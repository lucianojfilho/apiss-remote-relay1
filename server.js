'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');
const { SuperApi } = require('./super-api');
const { pdfToMarkdown } = require('./pdf-markdown');
const { GoogleSheetsClient } = require('./google-sheets');
const { signLicense } = require('./license');

const PORT = process.env.PORT || 3000;
const AGENT_SECRET = process.env.AGENT_SECRET || '';
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';
const LICENSE_PRIVATE_KEY = process.env.LICENSE_PRIVATE_KEY
  ? Buffer.from(process.env.LICENSE_PRIVATE_KEY, 'base64').toString('utf8')
  : '';
const LICENSE_SHEET_ID = process.env.LICENSE_SHEET_ID || '';
const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '';
const GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
  ? Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY, 'base64').toString('utf8')
  : '';
const LICENSE_SHEET_TAB = 'Página1';
const STATIC_DIR = path.join(__dirname, 'remote');
const ACTION_TIMEOUT_MS = 60000;
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

// A senha do celular É o mesmo "Segredo do agente" que o APISS já usa para se autenticar
// junto a este relay. Isso evita qualquer estado que precise sobreviver a um reinício do
// serviço (o plano gratuito do Render derruba o processo após ~15 min sem uso): não há
// pareamento nem lista de dispositivos para perder — a senha nunca muda sozinha, então o
// celular sempre consegue entrar de novo, mesmo depois do relay reiniciar.
function verifySecret(candidate, secret) {
  const a = Buffer.from(String(candidate || ''), 'utf8');
  const b = Buffer.from(String(secret || ''), 'utf8');
  if (!secret || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

class RelayState {
  constructor(options = {}) {
    this.now = options.now || (() => new Date());
    this.agentSocket = null;
    this.latestSnapshot = null;
    this.pendingActions = new Map();
  }

  setAgent(socket) {
    if (this.agentSocket && this.agentSocket !== socket) {
      try { this.agentSocket.close(4000, 'substituído por nova conexão do agente'); } catch (_e) { /* ignore */ }
    }
    this.agentSocket = socket;
  }

  clearAgent(socket) {
    if (this.agentSocket === socket) this.agentSocket = null;
  }

  isAgentConnected() {
    return Boolean(this.agentSocket && this.agentSocket.readyState === this.agentSocket.OPEN);
  }

  pushState(snapshot) {
    this.latestSnapshot = { ...snapshot, receivedAt: this.now().toISOString() };
  }

  requestAction(name, payload) {
    return new Promise((resolve, reject) => {
      if (!this.isAgentConnected()) { reject(Object.assign(new Error('O APISS não está conectado agora.'), { status: 503 })); return; }
      const requestId = crypto.randomUUID();
      const timeout = setTimeout(() => {
        this.pendingActions.delete(requestId);
        reject(Object.assign(new Error('O APISS não respondeu a tempo.'), { status: 504 }));
      }, ACTION_TIMEOUT_MS);
      this.pendingActions.set(requestId, { resolve, reject, timeout });
      this.agentSocket.send(JSON.stringify({ type: 'action', requestId, name, payload }));
    });
  }

  resolveAction(requestId, ok, result, error) {
    const pending = this.pendingActions.get(requestId);
    if (!pending) return;
    this.pendingActions.delete(requestId);
    clearTimeout(pending.timeout);
    if (ok) pending.resolve(result);
    else pending.reject(Object.assign(new Error(error?.message || 'Falha ao executar a ação.'), { status: 502 }));
  }
}

// Validação simples de e-mail — só pra recusar lixo óbvio no cadastro, não
// pretende ser uma validação RFC completa.
function looksLikeEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ''));
}

// Camada de domínio sobre a planilha "APISS - Licenças": cada linha é
// [Nome, Email, MachineId, DataCadastro, Status]. A planilha é a fonte da
// verdade que sobrevive a reinícios do relay (o resto do estado é só em
// memória — ver RelayState).
class LicenseStore {
  constructor({ sheetsClient, now }) {
    this.sheets = sheetsClient;
    this.now = now || (() => new Date());
  }

  async register({ nome, email, machineId }) {
    const cleanNome = String(nome || '').trim();
    const cleanEmail = String(email || '').trim().toLowerCase();
    const cleanMachineId = String(machineId || '').trim();
    if (!cleanNome) throw Object.assign(new Error('Informe o nome completo.'), { status: 400 });
    if (!looksLikeEmail(cleanEmail)) throw Object.assign(new Error('Informe um e-mail válido.'), { status: 400 });
    if (!cleanMachineId) throw Object.assign(new Error('Não foi possível identificar este computador.'), { status: 400 });
    // Reativar em vez de duplicar: se esse par e-mail+computador já tinha uma linha (ex.:
    // a pessoa foi revogada e está se cadastrando de novo), atualiza a linha existente em
    // vez de criar outra — evita duas linhas para o mesmo par, o que faria a busca de
    // status encontrar a mais antiga (revogada) antes da nova.
    const rows = await this.findRows();
    const existing = rows.find((row) => row.email === cleanEmail && row.machineId === cleanMachineId);
    if (existing) {
      await this.sheets.updateRow(`${LICENSE_SHEET_TAB}!A${existing.rowNumber}:E${existing.rowNumber}`, [cleanNome, cleanEmail, cleanMachineId, this.now().toISOString(), 'ativo']);
    } else {
      await this.sheets.appendRow(`${LICENSE_SHEET_TAB}!A:E`, [cleanNome, cleanEmail, cleanMachineId, this.now().toISOString(), 'ativo']);
    }
    return { nome: cleanNome, email: cleanEmail, machineId: cleanMachineId };
  }

  async findRows() {
    const rows = await this.sheets.getRows(`${LICENSE_SHEET_TAB}!A2:E`);
    return rows.map((row, index) => ({
      rowNumber: index + 2,
      nome: row[0] || '',
      email: (row[1] || '').toLowerCase(),
      machineId: row[2] || '',
      dataCadastro: row[3] || '',
      status: row[4] || 'ativo',
    }));
  }

  async statusFor({ email, machineId }) {
    const cleanEmail = String(email || '').trim().toLowerCase();
    const cleanMachineId = String(machineId || '').trim();
    const rows = await this.findRows();
    const match = rows.find((row) => row.email === cleanEmail && row.machineId === cleanMachineId);
    if (!match) return 'nao_encontrado';
    return match.status;
  }

  async setStatusForEmail(email, status) {
    const cleanEmail = String(email || '').trim().toLowerCase();
    const rows = await this.findRows();
    const matches = rows.filter((row) => row.email === cleanEmail);
    if (!matches.length) throw Object.assign(new Error('Nenhum cadastro encontrado com este e-mail.'), { status: 404 });
    for (const row of matches) {
      await this.sheets.updateRow(`${LICENSE_SHEET_TAB}!E${row.rowNumber}`, [status]);
    }
    return matches.length;
  }
}

// Mesma decodificação usada pelo APISS (download-manager.js): o SUPER devolve o PDF como
// base64 dentro de "conteudo", às vezes já com o prefixo data URL, às vezes só o base64 puro.
function decodePdfContent(component) {
  const content = String(component?.conteudo || '');
  const marker = ';base64,';
  const markerAt = content.indexOf(marker);
  const encoded = markerAt >= 0 ? content.slice(markerAt + marker.length) : content;
  if (!encoded) throw Object.assign(new Error('O SUPER retornou um PDF vazio.'), { status: 502 });
  const buffer = Buffer.from(encoded, 'base64');
  if (buffer.length < 5 || buffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw Object.assign(new Error('O arquivo retornado pelo SUPER não é um PDF válido.'), { status: 502 });
  }
  return buffer;
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

async function readBody(req, maxBytes = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) { reject(Object.assign(new Error('Corpo muito grande.'), { status: 413 })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) { resolve({}); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (_e) { reject(Object.assign(new Error('JSON inválido.'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

async function serveStatic(res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.resolve(STATIC_DIR, relative);
  if (filePath !== STATIC_DIR && !filePath.startsWith(STATIC_DIR + path.sep)) { sendJson(res, 404, { ok: false, error: { message: 'Não encontrado.' } }); return; }
  try {
    const content = await fs.readFile(filePath);
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream', 'Content-Length': content.length });
    res.end(content);
  } catch (_e) {
    sendJson(res, 404, { ok: false, error: { message: 'Não encontrado.' } });
  }
}

function createRelay(options = {}) {
  const state = new RelayState(options);
  const agentSecret = options.agentSecret ?? AGENT_SECRET;
  // Cliente do SUPER Sapiens rodando direto no relay — funciona mesmo com o APISS do
  // computador desligado. A sessão (token) fica só em memória deste processo: some se o
  // relay reiniciar (plano gratuito do Render), exigindo login de novo pelo celular.
  const sapiensApi = options.sapiensApi || new SuperApi(globalThis.fetch);
  // Injetável nos testes para não depender de um PDF real nem do pdfjs-dist.
  const convertPdfToMarkdown = options.pdfToMarkdown || pdfToMarkdown;
  const adminSecret = options.adminSecret ?? ADMIN_SECRET;
  const licensePrivateKey = options.licensePrivateKey ?? LICENSE_PRIVATE_KEY;
  const sheetsClient = options.sheetsClient || (LICENSE_SHEET_ID && GOOGLE_SERVICE_ACCOUNT_EMAIL
    ? new GoogleSheetsClient({ clientEmail: GOOGLE_SERVICE_ACCOUNT_EMAIL, privateKey: GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY, spreadsheetId: LICENSE_SHEET_ID })
    : null);
  const licenseStore = sheetsClient ? new LicenseStore({ sheetsClient, now: options.now }) : null;

  async function handleApi(req, res, pathname) {
    if (pathname === '/api/license/register' && req.method === 'POST') {
      try {
        if (!licenseStore || !licensePrivateKey) throw Object.assign(new Error('Ativação indisponível no momento.'), { status: 503 });
        const body = await readBody(req);
        const { nome, email, machineId } = await licenseStore.register(body);
        const license = signLicense(licensePrivateKey, { nome, email, machineId, issuedAt: (options.now ? options.now() : new Date()).toISOString() });
        sendJson(res, 200, { ok: true, result: { license } });
      } catch (error) {
        sendJson(res, error?.status || 500, { ok: false, error: { message: error?.message || 'Não foi possível concluir o cadastro.' } });
      }
      return;
    }
    if (pathname === '/api/license/check' && req.method === 'POST') {
      try {
        if (!licenseStore) throw Object.assign(new Error('Verificação indisponível no momento.'), { status: 503 });
        const body = await readBody(req);
        const status = await licenseStore.statusFor(body);
        sendJson(res, 200, { ok: true, result: { status } });
      } catch (error) {
        sendJson(res, error?.status || 500, { ok: false, error: { message: error?.message || 'Não foi possível verificar a licença.' } });
      }
      return;
    }
    if (pathname === '/admin/api/login' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        if (!verifySecret(body.password, adminSecret)) throw Object.assign(new Error('Senha incorreta.'), { status: 401 });
        sendJson(res, 200, { ok: true, result: {} });
      } catch (error) {
        sendJson(res, error?.status || 400, { ok: false, error: { message: error?.message || 'Não foi possível entrar.' } });
      }
      return;
    }
    if (pathname.startsWith('/admin/api/')) {
      const adminAuthHeader = String(req.headers.authorization || '');
      const adminToken = adminAuthHeader.startsWith('Bearer ') ? adminAuthHeader.slice(7).trim() : '';
      if (!verifySecret(adminToken, adminSecret)) { sendJson(res, 401, { ok: false, error: { message: 'Não autenticado.' } }); return; }
      try {
        if (!licenseStore) throw Object.assign(new Error('Gerenciamento de licenças indisponível no momento.'), { status: 503 });
        if (pathname === '/admin/api/list' && req.method === 'GET') {
          const rows = await licenseStore.findRows();
          sendJson(res, 200, { ok: true, result: { rows } });
          return;
        }
        if (pathname === '/admin/api/revoke' && req.method === 'POST') {
          const body = await readBody(req);
          const updated = await licenseStore.setStatusForEmail(body.email, 'revogado');
          sendJson(res, 200, { ok: true, result: { updated } });
          return;
        }
        if (pathname === '/admin/api/reactivate' && req.method === 'POST') {
          const body = await readBody(req);
          const updated = await licenseStore.setStatusForEmail(body.email, 'ativo');
          sendJson(res, 200, { ok: true, result: { updated } });
          return;
        }
      } catch (error) {
        sendJson(res, error?.status || 500, { ok: false, error: { message: error?.message || 'Não foi possível concluir a operação.' } });
        return;
      }
    }

    if (pathname === '/api/login' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        if (!verifySecret(body.password, agentSecret)) throw Object.assign(new Error('Senha incorreta.'), { status: 401 });
        sendJson(res, 200, { ok: true, result: {} });
      } catch (error) {
        sendJson(res, error?.status || 400, { ok: false, error: { message: error?.message || 'Não foi possível entrar.' } });
      }
      return;
    }

    const authHeader = String(req.headers.authorization || '');
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (!verifySecret(token, agentSecret)) { sendJson(res, 401, { ok: false, error: { message: 'Não autenticado.' } }); return; }

    if (pathname === '/api/state' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, result: { ...(state.latestSnapshot || {}), connected: state.isAgentConnected() } });
      return;
    }

    if (pathname === '/api/sapiens/status' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, result: sapiensApi.status() });
      return;
    }
    if (pathname === '/api/sapiens/login' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        sendJson(res, 200, { ok: true, result: await sapiensApi.login(body) });
      } catch (error) {
        sendJson(res, error?.status || 400, { ok: false, error: { message: error?.message || 'Não foi possível entrar no SUPER.' } });
      }
      return;
    }
    if (pathname === '/api/sapiens/verify-totp' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        sendJson(res, 200, { ok: true, result: await sapiensApi.verifyTotp(body) });
      } catch (error) {
        sendJson(res, error?.status || 400, { ok: false, error: { message: error?.message || 'Código inválido.' } });
      }
      return;
    }
    if (pathname === '/api/sapiens/logout' && req.method === 'POST') {
      sendJson(res, 200, { ok: true, result: sapiensApi.logout() });
      return;
    }
    if (pathname === '/api/sapiens/sync' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        sendJson(res, 200, { ok: true, result: await sapiensApi.syncTasks(body || {}) });
      } catch (error) {
        sendJson(res, error?.status || 502, { ok: false, error: { message: error?.message || 'Não foi possível sincronizar com o SUPER.' } });
      }
      return;
    }
    if (pathname === '/api/sapiens/download' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const processId = String(body?.superProcessoId || '').replace(/\D/g, '');
        if (!processId) throw Object.assign(new Error('Processo sem identificador do SUPER.'), { status: 400 });
        const component = await sapiensApi.downloadProcessPdf(processId);
        const pdf = decodePdfContent(component);
        sendJson(res, 200, { ok: true, result: { filename: `processo-${processId}.pdf`, mimeType: 'application/pdf', base64: pdf.toString('base64') } });
      } catch (error) {
        sendJson(res, error?.status || 502, { ok: false, error: { message: error?.message || 'Não foi possível baixar o PDF.' } });
      }
      return;
    }
    if (pathname === '/api/sapiens/convert-md' && req.method === 'POST') {
      // Sem OCR: só extrai o texto já presente no PDF (rápido e leve). PDFs digitalizados sem
      // camada de texto saem com pouco ou nenhum conteúdo — nesse caso o PDF original enviado
      // ao Drive continua sendo a fonte completa.
      let tempPath = '';
      try {
        const body = await readBody(req, 25 * 1024 * 1024);
        const base64 = String(body?.base64 || '');
        if (!base64) throw Object.assign(new Error('PDF ausente.'), { status: 400 });
        const buffer = Buffer.from(base64, 'base64');
        tempPath = path.join(os.tmpdir(), `apiss-relay-${crypto.randomUUID()}.pdf`);
        await fs.writeFile(tempPath, buffer);
        const result = await convertPdfToMarkdown(tempPath, { enableOcr: false });
        const filename = String(body?.filename || 'processo.pdf').replace(/\.pdf$/i, '') + '.md';
        sendJson(res, 200, { ok: true, result: { markdown: result.markdown, warnings: result.warnings, filename } });
      } catch (error) {
        sendJson(res, error?.status || 502, { ok: false, error: { message: error?.message || 'Não foi possível converter para .md.' } });
      } finally {
        if (tempPath) await fs.unlink(tempPath).catch(() => {});
      }
      return;
    }

    const actionRoutes = {
      '/api/actions/sync': 'sync',
      '/api/actions/download-batch': 'download-batch',
      '/api/actions/update-process': 'update-process',
      '/api/actions/reconnect-super': 'reconnect-super',
    };
    const actionName = req.method === 'POST' ? actionRoutes[pathname] : undefined;
    if (actionName) {
      try {
        const payload = await readBody(req);
        const result = await state.requestAction(actionName, payload);
        sendJson(res, 200, { ok: true, result: result || {} });
      } catch (error) {
        sendJson(res, error?.status || 502, { ok: false, error: { message: error?.message || 'Não foi possível executar a ação.' } });
      }
      return;
    }
    sendJson(res, 404, { ok: false, error: { message: 'Rota não encontrada.' } });
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/admin/api/')) handleApi(req, res, url.pathname).catch((error) => sendJson(res, 500, { ok: false, error: { message: error?.message || 'Erro interno.' } }));
    else serveStatic(res, url.pathname);
  });

  const wss = new WebSocketServer({ server, path: '/agent' });
  wss.on('connection', (socket, req) => {
    const url = new URL(req.url, 'http://localhost');
    const providedSecret = url.searchParams.get('secret') || '';
    if (!agentSecret || providedSecret !== agentSecret) { socket.close(4001, 'segredo inválido'); return; }
    state.setAgent(socket);
    socket.on('message', (raw) => {
      let message;
      try { message = JSON.parse(raw.toString('utf8')); } catch (_e) { return; }
      if (message.type === 'push-state') state.pushState(message.snapshot || {});
      else if (message.type === 'action-result') state.resolveAction(message.requestId, message.ok, message.result, message.error);
    });
    socket.on('close', () => state.clearAgent(socket));
  });

  return { server, state, wss, sapiensApi };
}

if (require.main === module) {
  if (!AGENT_SECRET) {
    console.error('Defina a variável de ambiente AGENT_SECRET antes de iniciar o relay.');
    process.exit(1);
  }
  if (!ADMIN_SECRET || !LICENSE_PRIVATE_KEY || !LICENSE_SHEET_ID || !GOOGLE_SERVICE_ACCOUNT_EMAIL || !GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY) {
    console.warn('Variáveis de ambiente de licenciamento incompletas (ADMIN_SECRET/LICENSE_PRIVATE_KEY/LICENSE_SHEET_ID/GOOGLE_SERVICE_ACCOUNT_EMAIL/GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY) — o cadastro/ativação e a página de administração ficam indisponíveis, mas o resto do relay continua funcionando normalmente.');
  }
  const { server } = createRelay();
  server.listen(PORT, () => console.log(`apiss-remote-relay ouvindo na porta ${PORT}`));
}

module.exports = { createRelay, RelayState, verifySecret, LicenseStore, looksLikeEmail };
