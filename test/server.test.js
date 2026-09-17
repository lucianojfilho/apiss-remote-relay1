'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const WebSocket = require('ws');
const { createRelay } = require('../server');

const AGENT_SECRET = 'segredo-de-teste';

async function withRelay(fn) {
  const { server, state, wss } = createRelay({ agentSecret: AGENT_SECRET, now: () => new Date('2026-09-14T12:00:00.000Z') });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  try {
    await fn({ baseUrl: `http://127.0.0.1:${port}`, wsBase: `ws://127.0.0.1:${port}`, state });
  } finally {
    // Conexões upgradadas para WebSocket não são fechadas por server.closeAllConnections() —
    // isso só alcança conexões HTTP simples. É preciso terminar os clientes do WebSocketServer
    // à parte, senão um socket de teste ainda aberto trava o close() do http.Server para sempre.
    for (const client of wss.clients) client.terminate();
    await new Promise((resolve) => server.close(resolve));
  }
}

function request(baseUrl, path, { method = 'GET', body, token } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    let payload;
    if (body !== undefined) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
    const req = http.request(`${baseUrl}${path}`, { method, headers }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => { resolve({ status: res.statusCode, data: JSON.parse(raw || 'null') }); });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function connectAgent(wsBase, secret) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBase}/agent?secret=${encodeURIComponent(secret)}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

test('recusa a conexão do agente com segredo errado', async () => {
  await withRelay(async ({ wsBase }) => {
    const ws = new WebSocket(`${wsBase}/agent?secret=errado`);
    const closeCode = await new Promise((resolve) => ws.on('close', (code) => resolve(code)));
    assert.equal(closeCode, 4001);
  });
});

test('/api/state sem agente conectado responde connected:false, e /api/actions/sync responde 503', async () => {
  await withRelay(async ({ baseUrl, state }) => {
    state.setPairingCode('123456', Date.now() + 60000);
    const paired = await request(baseUrl, '/api/pair', { method: 'POST', body: { code: '123456' } });
    const token = paired.data.result.token;

    const stateResponse = await request(baseUrl, '/api/state', { token });
    assert.equal(stateResponse.data.result.connected, false);

    const actionResponse = await request(baseUrl, '/api/actions/sync', { method: 'POST', token });
    assert.equal(actionResponse.status, 503);
  });
});

test('o agente conecta, define o código de pareamento, e o celular consegue parear e ver o estado', async () => {
  await withRelay(async ({ baseUrl, wsBase }) => {
    const agent = await connectAgent(wsBase, AGENT_SECRET);
    agent.send(JSON.stringify({ type: 'set-pairing-code', code: '654321', expiresAt: Date.now() + 60000 }));
    agent.send(JSON.stringify({ type: 'push-state', snapshot: { dayCount: 3, nearCount: 7, overdueCount: 0, lastSyncAt: '2026-09-14T11:00:00.000Z' } }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const paired = await request(baseUrl, '/api/pair', { method: 'POST', body: { code: '654321' } });
    assert.equal(paired.status, 200);

    const stateResponse = await request(baseUrl, '/api/state', { token: paired.data.result.token });
    assert.equal(stateResponse.data.result.connected, true);
    assert.equal(stateResponse.data.result.dayCount, 3);
    agent.close();
  });
});

test('uma ação disparada pelo celular chega no agente e a resposta do agente volta pro celular', async () => {
  await withRelay(async ({ baseUrl, wsBase }) => {
    const agent = await connectAgent(wsBase, AGENT_SECRET);
    agent.send(JSON.stringify({ type: 'set-pairing-code', code: '111222', expiresAt: Date.now() + 60000 }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const paired = await request(baseUrl, '/api/pair', { method: 'POST', body: { code: '111222' } });
    const token = paired.data.result.token;

    agent.on('message', (raw) => {
      const message = JSON.parse(raw.toString('utf8'));
      if (message.type === 'action' && message.name === 'sync') {
        agent.send(JSON.stringify({ type: 'action-result', requestId: message.requestId, ok: true, result: { synced: true } }));
      }
    });

    const response = await request(baseUrl, '/api/actions/sync', { method: 'POST', token });
    assert.equal(response.status, 200);
    assert.deepEqual(response.data.result, { synced: true });
    agent.close();
  });
});

test('download-batch e update-process repassam o payload intacto até o agente', async () => {
  await withRelay(async ({ baseUrl, wsBase }) => {
    const agent = await connectAgent(wsBase, AGENT_SECRET);
    agent.send(JSON.stringify({ type: 'set-pairing-code', code: '333444', expiresAt: Date.now() + 60000 }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const paired = await request(baseUrl, '/api/pair', { method: 'POST', body: { code: '333444' } });
    const token = paired.data.result.token;

    const receivedPayloads = [];
    agent.on('message', (raw) => {
      const message = JSON.parse(raw.toString('utf8'));
      if (message.type !== 'action') return;
      receivedPayloads.push({ name: message.name, payload: message.payload });
      agent.send(JSON.stringify({ type: 'action-result', requestId: message.requestId, ok: true, result: { name: message.name } }));
    });

    const batchResponse = await request(baseUrl, '/api/actions/download-batch', { method: 'POST', token, body: { keys: ['cnj:123', 'nup:456'] } });
    assert.equal(batchResponse.status, 200);
    assert.deepEqual(batchResponse.data.result, { name: 'download-batch' });

    const updateResponse = await request(baseUrl, '/api/actions/update-process', { method: 'POST', token, body: { key: 'cnj:123', status: 'Concluído', observacao: 'ok' } });
    assert.equal(updateResponse.status, 200);

    assert.deepEqual(receivedPayloads, [
      { name: 'download-batch', payload: { keys: ['cnj:123', 'nup:456'] } },
      { name: 'update-process', payload: { key: 'cnj:123', status: 'Concluído', observacao: 'ok' } },
    ]);
    agent.close();
  });
});

test('token inválido é recusado em rotas protegidas', async () => {
  await withRelay(async ({ baseUrl }) => {
    const response = await request(baseUrl, '/api/state', { token: 'lixo' });
    assert.equal(response.status, 401);
  });
});

test('uma nova conexão do agente substitui a anterior (reconexão do APISS)', async () => {
  await withRelay(async ({ wsBase, state }) => {
    const first = await connectAgent(wsBase, AGENT_SECRET);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(state.isAgentConnected(), true);
    const second = await connectAgent(wsBase, AGENT_SECRET);
    const firstClosed = await new Promise((resolve) => first.on('close', () => resolve(true)));
    assert.equal(firstClosed, true, 'a conexão antiga precisa ser fechada quando uma nova chega');
    // state.agentSocket é o socket do lado do servidor; "second" é o socket do lado do
    // cliente para a mesma conexão lógica — são objetos diferentes por natureza, então a
    // checagem de identidade é feita indiretamente, via isAgentConnected() continuar true.
    assert.equal(state.isAgentConnected(), true);
    second.close();
  });
});
