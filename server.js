'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const AGENT_SECRET = process.env.AGENT_SECRET || '';
const STATIC_DIR = path.join(__dirname, 'remote');
const ACTION_TIMEOUT_MS = 60000;
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function timingSafeEqualHex(a, b) {
  const bufA = Buffer.from(String(a || ''), 'hex');
  const bufB = Buffer.from(String(b || ''), 'hex');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

class RelayState {
  constructor(options = {}) {
    this.now = options.now || (() => new Date());
    this.agentSocket = null;
    this.pairingCode = null;
    this.devices = [];
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

  setPairingCode(code, expiresAt) {
    this.pairingCode = { code: String(code || ''), expiresAt: Number(expiresAt) || 0 };
  }

  pair(code) {
    if (!this.pairingCode || this.now().getTime() > this.pairingCode.expiresAt) {
      throw Object.assign(new Error('Código expirado. Gere um novo código no APISS.'), { status: 401 });
    }
    if (String(code || '') !== this.pairingCode.code) {
      throw Object.assign(new Error('Código incorreto.'), { status: 401 });
    }
    this.pairingCode = null;
    const token = crypto.randomBytes(32).toString('hex');
    this.devices.push({ tokenHash: hashToken(token), pairedAt: this.now().toISOString() });
    return token;
  }

  verifyToken(token) {
    if (!token) return false;
    const hash = hashToken(token);
    return this.devices.some((device) => timingSafeEqualHex(device.tokenHash, hash));
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

  async function handleApi(req, res, pathname) {
    if (pathname === '/api/pair' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const token = state.pair(body.code);
        sendJson(res, 200, { ok: true, result: { token } });
      } catch (error) {
        sendJson(res, error?.status || 400, { ok: false, error: { message: error?.message || 'Não foi possível parear.' } });
      }
      return;
    }

    const authHeader = String(req.headers.authorization || '');
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (!state.verifyToken(token)) { sendJson(res, 401, { ok: false, error: { message: 'Não autenticado.' } }); return; }

    if (pathname === '/api/state' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, result: { ...(state.latestSnapshot || {}), connected: state.isAgentConnected() } });
      return;
    }

    const actionRoutes = {
      '/api/actions/sync': 'sync',
      '/api/actions/download-batch': 'download-batch',
      '/api/actions/update-process': 'update-process',
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
      if (message.type === 'set-pairing-code') state.setPairingCode(message.code, message.expiresAt);
      else if (message.type === 'push-state') state.pushState(message.snapshot || {});
      else if (message.type === 'action-result') state.resolveAction(message.requestId, message.ok, message.result, message.error);
    });
    socket.on('close', () => state.clearAgent(socket));
  });

  return { server, state, wss };
}

if (require.main === module) {
  if (!AGENT_SECRET) {
    console.error('Defina a variável de ambiente AGENT_SECRET antes de iniciar o relay.');
    process.exit(1);
  }
  const { server } = createRelay();
  server.listen(PORT, () => console.log(`apiss-remote-relay ouvindo na porta ${PORT}`));
}

module.exports = { createRelay, RelayState, hashToken, timingSafeEqualHex };
