'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');
const { SuperApi } = require('./super-api');

const PORT = process.env.PORT || 3000;
const AGENT_SECRET = process.env.AGENT_SECRET || '';
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

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 16 * 1024) { reject(Object.assign(new Error('Corpo muito grande.'), { status: 413 })); req.destroy(); return; }
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

  async function handleApi(req, res, pathname) {
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
    if (url.pathname.startsWith('/api/')) handleApi(req, res, url.pathname).catch((error) => sendJson(res, 500, { ok: false, error: { message: error?.message || 'Erro interno.' } }));
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
  const { server } = createRelay();
  server.listen(PORT, () => console.log(`apiss-remote-relay ouvindo na porta ${PORT}`));
}

module.exports = { createRelay, RelayState, verifySecret };
