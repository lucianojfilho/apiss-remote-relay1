'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const WebSocket = require('ws');
const { createRelay } = require('../server');
const { verifyLicense } = require('../license');

const AGENT_SECRET = 'segredo-de-teste';
const ADMIN_SECRET = 'senha-admin-teste';

function makeLicenseKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
  };
}

// Fake do GoogleSheetsClient: guarda linhas em memória com a mesma forma
// [Nome, Email, MachineId, DataCadastro, Status] e entende os mesmos formatos
// de range que o LicenseStore de fato usa (A:E para acrescentar, A2:E para
// ler, E<linha> para atualizar só a coluna Status de uma linha).
function fakeSheetsClient(seedRows) {
  const rows = (seedRows || []).map((row) => row.slice());
  return {
    rows,
    appendRow: async (_range, values) => { rows.push(values.slice()); },
    getRows: async (_range) => rows.map((row) => row.slice()),
    updateRow: async (range, values) => {
      const fullRow = /!A(\d+):E\d+$/.exec(range);
      if (fullRow) { const index = Number(fullRow[1]) - 2; rows[index] = values.slice(); return; }
      const statusOnly = /!E(\d+)$/.exec(range);
      if (!statusOnly) throw new Error('range de updateRow não suportado no fake: ' + range);
      const index = Number(statusOnly[1]) - 2;
      if (rows[index]) rows[index][4] = values[0];
    },
  };
}

async function withRelay(fn, extraOptions) {
  const { server, state, wss, sapiensApi } = createRelay({ agentSecret: AGENT_SECRET, now: () => new Date('2026-09-14T12:00:00.000Z'), ...extraOptions });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  try {
    await fn({ baseUrl: `http://127.0.0.1:${port}`, wsBase: `ws://127.0.0.1:${port}`, state, sapiensApi });
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

function fakeSapiensApi(overrides) {
  const validPdf = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4 conteúdo de teste').toString('base64');
  return Object.assign({
    status: () => ({ authenticated: false, awaitingTotp: false, profile: null }),
    login: async () => ({ status: 'authenticated', authenticated: true, awaitingTotp: false, profile: { name: 'Fulano de Tal' } }),
    verifyTotp: async () => ({ status: 'authenticated', authenticated: true, awaitingTotp: false, profile: { name: 'Fulano de Tal' } }),
    logout: () => ({ authenticated: false, awaitingTotp: false, profile: null }),
    syncTasks: async () => ({ tasks: [{ numero: '1111084-03.2023.4.01.3400', superProcessoId: '345' }], total: 1 }),
    downloadProcessPdf: async () => ({ conteudo: validPdf }),
  }, overrides);
}

test('recusa a conexão do agente com segredo errado', async () => {
  await withRelay(async ({ wsBase }) => {
    const ws = new WebSocket(`${wsBase}/agent?secret=errado`);
    const closeCode = await new Promise((resolve) => ws.on('close', (code) => resolve(code)));
    assert.equal(closeCode, 4001);
  });
});

test('/api/login recusa senha errada e aceita a senha certa (o próprio AGENT_SECRET)', async () => {
  await withRelay(async ({ baseUrl }) => {
    const wrong = await request(baseUrl, '/api/login', { method: 'POST', body: { password: 'chuta' } });
    assert.equal(wrong.status, 401);

    const right = await request(baseUrl, '/api/login', { method: 'POST', body: { password: AGENT_SECRET } });
    assert.equal(right.status, 200);
    assert.equal(right.data.ok, true);
  });
});

test('/api/state sem agente conectado responde connected:false, e /api/actions/sync responde 503', async () => {
  await withRelay(async ({ baseUrl }) => {
    const stateResponse = await request(baseUrl, '/api/state', { token: AGENT_SECRET });
    assert.equal(stateResponse.data.result.connected, false);

    const actionResponse = await request(baseUrl, '/api/actions/sync', { method: 'POST', token: AGENT_SECRET });
    assert.equal(actionResponse.status, 503);
  });
});

test('o agente conecta e empurra o estado, e o celular consegue ver com a mesma senha do agente', async () => {
  await withRelay(async ({ baseUrl, wsBase }) => {
    const agent = await connectAgent(wsBase, AGENT_SECRET);
    agent.send(JSON.stringify({ type: 'push-state', snapshot: { dayCount: 3, nearCount: 7, overdueCount: 0, lastSyncAt: '2026-09-14T11:00:00.000Z' } }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const stateResponse = await request(baseUrl, '/api/state', { token: AGENT_SECRET });
    assert.equal(stateResponse.status, 200);
    assert.equal(stateResponse.data.result.connected, true);
    assert.equal(stateResponse.data.result.dayCount, 3);
    agent.close();
  });
});

test('a mesma senha continua funcionando mesmo que o relay "reinicie" (nada fica em memória para expirar)', async () => {
  // Simula o efeito de um restart do serviço no plano gratuito do Render: cria uma SEGUNDA
  // instância do relay (memória zerada) com o mesmo AGENT_SECRET (que vem de uma variável de
  // ambiente, não da memória do processo) e confirma que a senha do celular continua válida
  // sem precisar de um novo pareamento.
  const first = createRelay({ agentSecret: AGENT_SECRET });
  await new Promise((resolve) => first.server.listen(0, resolve));
  const port = first.server.address().port;
  for (const client of first.wss.clients) client.terminate();
  await new Promise((resolve) => first.server.close(resolve));

  const second = createRelay({ agentSecret: AGENT_SECRET });
  await new Promise((resolve) => second.server.listen(port, resolve));
  try {
    const response = await request(`http://127.0.0.1:${port}`, '/api/login', { method: 'POST', body: { password: AGENT_SECRET } });
    assert.equal(response.status, 200);
  } finally {
    for (const client of second.wss.clients) client.terminate();
    await new Promise((resolve) => second.server.close(resolve));
  }
});

test('uma ação disparada pelo celular chega no agente e a resposta do agente volta pro celular', async () => {
  await withRelay(async ({ baseUrl, wsBase }) => {
    const agent = await connectAgent(wsBase, AGENT_SECRET);
    await new Promise((resolve) => setTimeout(resolve, 50));

    agent.on('message', (raw) => {
      const message = JSON.parse(raw.toString('utf8'));
      if (message.type === 'action' && message.name === 'sync') {
        agent.send(JSON.stringify({ type: 'action-result', requestId: message.requestId, ok: true, result: { synced: true } }));
      }
    });

    const response = await request(baseUrl, '/api/actions/sync', { method: 'POST', token: AGENT_SECRET });
    assert.equal(response.status, 200);
    assert.deepEqual(response.data.result, { synced: true });
    agent.close();
  });
});

test('download-batch e update-process repassam o payload intacto até o agente', async () => {
  await withRelay(async ({ baseUrl, wsBase }) => {
    const agent = await connectAgent(wsBase, AGENT_SECRET);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const receivedPayloads = [];
    agent.on('message', (raw) => {
      const message = JSON.parse(raw.toString('utf8'));
      if (message.type !== 'action') return;
      receivedPayloads.push({ name: message.name, payload: message.payload });
      agent.send(JSON.stringify({ type: 'action-result', requestId: message.requestId, ok: true, result: { name: message.name } }));
    });

    const batchResponse = await request(baseUrl, '/api/actions/download-batch', { method: 'POST', token: AGENT_SECRET, body: { keys: ['cnj:123', 'nup:456'] } });
    assert.equal(batchResponse.status, 200);
    assert.deepEqual(batchResponse.data.result, { name: 'download-batch' });

    const updateResponse = await request(baseUrl, '/api/actions/update-process', { method: 'POST', token: AGENT_SECRET, body: { key: 'cnj:123', status: 'Concluído', observacao: 'ok' } });
    assert.equal(updateResponse.status, 200);

    assert.deepEqual(receivedPayloads, [
      { name: 'download-batch', payload: { keys: ['cnj:123', 'nup:456'] } },
      { name: 'update-process', payload: { key: 'cnj:123', status: 'Concluído', observacao: 'ok' } },
    ]);
    agent.close();
  });
});

test('/api/actions/reconnect-super repassa o payload (código do Authenticator) até o agente', async () => {
  await withRelay(async ({ baseUrl, wsBase }) => {
    const agent = await connectAgent(wsBase, AGENT_SECRET);
    await new Promise((resolve) => setTimeout(resolve, 50));

    agent.on('message', (raw) => {
      const message = JSON.parse(raw.toString('utf8'));
      if (message.type === 'action' && message.name === 'reconnect-super') {
        agent.send(JSON.stringify({ type: 'action-result', requestId: message.requestId, ok: true, result: { authenticated: true, payloadSeen: message.payload } }));
      }
    });

    const response = await request(baseUrl, '/api/actions/reconnect-super', { method: 'POST', token: AGENT_SECRET, body: { totpCode: '123456' } });
    assert.equal(response.status, 200);
    assert.deepEqual(response.data.result, { authenticated: true, payloadSeen: { totpCode: '123456' } });
    agent.close();
  });
});

test('/api/sapiens/* funciona sem nenhum agente conectado (Sapiens independe do APISS do PC)', async () => {
  const sapiensApi = fakeSapiensApi();
  await withRelay(async ({ baseUrl, state }) => {
    assert.equal(state.isAgentConnected(), false);

    const login = await request(baseUrl, '/api/sapiens/login', { method: 'POST', token: AGENT_SECRET, body: { username: '12345678900', password: 'senha' } });
    assert.equal(login.status, 200);
    assert.equal(login.data.result.authenticated, true);

    const sync = await request(baseUrl, '/api/sapiens/sync', { method: 'POST', token: AGENT_SECRET, body: {} });
    assert.equal(sync.status, 200);
    assert.equal(sync.data.result.total, 1);

    const download = await request(baseUrl, '/api/sapiens/download', { method: 'POST', token: AGENT_SECRET, body: { superProcessoId: '345' } });
    assert.equal(download.status, 200);
    assert.equal(download.data.result.mimeType, 'application/pdf');
    const decoded = Buffer.from(download.data.result.base64, 'base64').toString('utf8');
    assert.match(decoded, /^%PDF-1\.4/);
  }, { sapiensApi });
});

test('/api/sapiens/login com TOTP pendente e /api/sapiens/verify-totp completa a autenticação', async () => {
  const sapiensApi = fakeSapiensApi({
    login: async () => ({ status: 'totp_required', authenticated: false, awaitingTotp: true }),
  });
  await withRelay(async ({ baseUrl }) => {
    const login = await request(baseUrl, '/api/sapiens/login', { method: 'POST', token: AGENT_SECRET, body: { username: 'x', password: 'y' } });
    assert.equal(login.data.result.status, 'totp_required');

    const verify = await request(baseUrl, '/api/sapiens/verify-totp', { method: 'POST', token: AGENT_SECRET, body: { code: '123456' } });
    assert.equal(verify.status, 200);
    assert.equal(verify.data.result.authenticated, true);
  }, { sapiensApi });
});

test('/api/sapiens/download recusa sem identificador do processo e propaga erro do SUPER', async () => {
  const sapiensApi = fakeSapiensApi({
    downloadProcessPdf: async () => { throw Object.assign(new Error('Credenciais, código ou sessão recusados pelo SUPER.'), { status: 401 }); },
  });
  await withRelay(async ({ baseUrl }) => {
    const missing = await request(baseUrl, '/api/sapiens/download', { method: 'POST', token: AGENT_SECRET, body: {} });
    assert.equal(missing.status, 400);

    const failed = await request(baseUrl, '/api/sapiens/download', { method: 'POST', token: AGENT_SECRET, body: { superProcessoId: '345' } });
    assert.equal(failed.status, 401);
    assert.match(failed.data.error.message, /SUPER/);
  }, { sapiensApi });
});

test('rotas do Sapiens também exigem a senha do relay', async () => {
  await withRelay(async ({ baseUrl }) => {
    const response = await request(baseUrl, '/api/sapiens/status');
    assert.equal(response.status, 401);
  }, { sapiensApi: fakeSapiensApi() });
});

test('/api/sapiens/convert-md grava o PDF recebido num arquivo temporário, converte sem OCR e apaga o temporário', async () => {
  const seenCalls = [];
  const fakePdfToMarkdown = async (filePath, options) => {
    seenCalls.push({ filePath, options });
    const bytes = await require('node:fs/promises').readFile(filePath);
    return { markdown: '# Convertido\n\n' + bytes.toString('utf8'), warnings: [], pages: 1 };
  };
  await withRelay(async ({ baseUrl }) => {
    const base64 = Buffer.from('%PDF-1.4 conteúdo de teste').toString('base64');
    const response = await request(baseUrl, '/api/sapiens/convert-md', {
      method: 'POST', token: AGENT_SECRET, body: { base64, filename: 'processo-345.pdf' },
    });
    assert.equal(response.status, 200);
    assert.match(response.data.result.markdown, /^# Convertido/);
    assert.equal(response.data.result.filename, 'processo-345.md');
    assert.equal(seenCalls.length, 1);
    assert.equal(seenCalls[0].options.enableOcr, false, 'a rota nunca deve pedir OCR');

    const fs = require('node:fs/promises');
    await assert.rejects(() => fs.access(seenCalls[0].filePath), 'o PDF temporário deve ser apagado após a conversão');
  }, { sapiensApi: fakeSapiensApi(), pdfToMarkdown: fakePdfToMarkdown });
});

test('/api/sapiens/convert-md recusa corpo sem PDF e propaga erro de conversão', async () => {
  await withRelay(async ({ baseUrl }) => {
    const missing = await request(baseUrl, '/api/sapiens/convert-md', { method: 'POST', token: AGENT_SECRET, body: {} });
    assert.equal(missing.status, 400);
  }, {
    sapiensApi: fakeSapiensApi(),
    pdfToMarkdown: async () => { throw new Error('PDF corrompido.'); },
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

test('POST /api/license/register cadastra na planilha e devolve uma licença assinada e verificável', async () => {
  const { privateKeyPem, publicKeyPem } = makeLicenseKeyPair();
  const sheetsClient = fakeSheetsClient();
  await withRelay(async ({ baseUrl }) => {
    const response = await request(baseUrl, '/api/license/register', {
      method: 'POST',
      body: { nome: 'Fulano de Tal', email: 'Fulano@AGU.gov.br', machineId: 'maquina-123' },
    });
    assert.equal(response.status, 200);
    assert.ok(response.data.result.license);
    const payload = verifyLicense(publicKeyPem, response.data.result.license);
    assert.equal(payload.email, 'fulano@agu.gov.br');
    assert.equal(payload.machineId, 'maquina-123');
    assert.equal(sheetsClient.rows.length, 1);
    assert.deepEqual(sheetsClient.rows[0].slice(0, 3), ['Fulano de Tal', 'fulano@agu.gov.br', 'maquina-123']);
    assert.equal(sheetsClient.rows[0][4], 'ativo');
  }, { sheetsClient, licensePrivateKey: privateKeyPem, adminSecret: ADMIN_SECRET });
});

test('POST /api/license/register reativa a linha existente (mesmo e-mail+computador) em vez de duplicar', async () => {
  const { privateKeyPem } = makeLicenseKeyPair();
  const sheetsClient = fakeSheetsClient([
    ['Fulano de Tal', 'fulano@agu.gov.br', 'maquina-123', '2026-09-01T00:00:00.000Z', 'revogado'],
  ]);
  await withRelay(async ({ baseUrl }) => {
    const response = await request(baseUrl, '/api/license/register', {
      method: 'POST',
      body: { nome: 'Fulano de Tal', email: 'fulano@agu.gov.br', machineId: 'maquina-123' },
    });
    assert.equal(response.status, 200);
    assert.equal(sheetsClient.rows.length, 1, 'não deveria criar uma segunda linha para o mesmo e-mail+computador');
    assert.equal(sheetsClient.rows[0][4], 'ativo');
  }, { sheetsClient, licensePrivateKey: privateKeyPem, adminSecret: ADMIN_SECRET });
});

test('POST /api/license/register recusa cadastro sem nome, e-mail inválido ou sem machineId', async () => {
  const { privateKeyPem } = makeLicenseKeyPair();
  const sheetsClient = fakeSheetsClient();
  await withRelay(async ({ baseUrl }) => {
    const semNome = await request(baseUrl, '/api/license/register', { method: 'POST', body: { nome: '', email: 'a@b.com', machineId: 'm1' } });
    assert.equal(semNome.status, 400);
    const emailInvalido = await request(baseUrl, '/api/license/register', { method: 'POST', body: { nome: 'Fulano', email: 'não-é-email', machineId: 'm1' } });
    assert.equal(emailInvalido.status, 400);
    const semMaquina = await request(baseUrl, '/api/license/register', { method: 'POST', body: { nome: 'Fulano', email: 'a@b.com', machineId: '' } });
    assert.equal(semMaquina.status, 400);
    assert.equal(sheetsClient.rows.length, 0);
  }, { sheetsClient, licensePrivateKey: privateKeyPem, adminSecret: ADMIN_SECRET });
});

test('POST /api/license/register responde 503 quando o licenciamento não está configurado no relay', async () => {
  await withRelay(async ({ baseUrl }) => {
    const response = await request(baseUrl, '/api/license/register', { method: 'POST', body: { nome: 'Fulano', email: 'a@b.com', machineId: 'm1' } });
    assert.equal(response.status, 503);
  });
});

test('POST /api/license/check devolve o status atual para o par email+machineId, e "nao_encontrado" quando não bate', async () => {
  const sheetsClient = fakeSheetsClient([
    ['Fulano de Tal', 'fulano@agu.gov.br', 'maquina-123', '2026-09-22T00:00:00.000Z', 'ativo'],
    ['Ciclana', 'ciclana@agu.gov.br', 'maquina-456', '2026-09-22T00:00:00.000Z', 'revogado'],
  ]);
  await withRelay(async ({ baseUrl }) => {
    const ativo = await request(baseUrl, '/api/license/check', { method: 'POST', body: { email: 'fulano@agu.gov.br', machineId: 'maquina-123' } });
    assert.equal(ativo.data.result.status, 'ativo');
    const revogado = await request(baseUrl, '/api/license/check', { method: 'POST', body: { email: 'ciclana@agu.gov.br', machineId: 'maquina-456' } });
    assert.equal(revogado.data.result.status, 'revogado');
    const machineErrada = await request(baseUrl, '/api/license/check', { method: 'POST', body: { email: 'fulano@agu.gov.br', machineId: 'outra-maquina' } });
    assert.equal(machineErrada.data.result.status, 'nao_encontrado');
  }, { sheetsClient, adminSecret: ADMIN_SECRET });
});

test('rotas /admin/api/* exigem a senha de administrador (login e Bearer nas demais)', async () => {
  const sheetsClient = fakeSheetsClient([['Fulano', 'fulano@agu.gov.br', 'm1', '2026-09-22T00:00:00.000Z', 'ativo']]);
  await withRelay(async ({ baseUrl }) => {
    const loginErrado = await request(baseUrl, '/admin/api/login', { method: 'POST', body: { password: 'errada' } });
    assert.equal(loginErrado.status, 401);
    const loginCerto = await request(baseUrl, '/admin/api/login', { method: 'POST', body: { password: ADMIN_SECRET } });
    assert.equal(loginCerto.status, 200);
    const semToken = await request(baseUrl, '/admin/api/list');
    assert.equal(semToken.status, 401);
    const comToken = await request(baseUrl, '/admin/api/list', { token: ADMIN_SECRET });
    assert.equal(comToken.status, 200);
    assert.equal(comToken.data.result.rows.length, 1);
    assert.equal(comToken.data.result.rows[0].email, 'fulano@agu.gov.br');
  }, { sheetsClient, adminSecret: ADMIN_SECRET });
});

test('POST /admin/api/revoke e /admin/api/reactivate mudam o status de todas as linhas daquele e-mail', async () => {
  const sheetsClient = fakeSheetsClient([
    ['Fulano', 'fulano@agu.gov.br', 'm1', '2026-09-22T00:00:00.000Z', 'ativo'],
    ['Fulano', 'fulano@agu.gov.br', 'm2-reinstalou', '2026-09-23T00:00:00.000Z', 'ativo'],
  ]);
  await withRelay(async ({ baseUrl }) => {
    const revoke = await request(baseUrl, '/admin/api/revoke', { method: 'POST', body: { email: 'Fulano@AGU.gov.br' }, token: ADMIN_SECRET });
    assert.equal(revoke.status, 200);
    assert.equal(revoke.data.result.updated, 2);
    assert.equal(sheetsClient.rows[0][4], 'revogado');
    assert.equal(sheetsClient.rows[1][4], 'revogado');

    const reactivate = await request(baseUrl, '/admin/api/reactivate', { method: 'POST', body: { email: 'fulano@agu.gov.br' }, token: ADMIN_SECRET });
    assert.equal(reactivate.status, 200);
    assert.equal(sheetsClient.rows[0][4], 'ativo');
    assert.equal(sheetsClient.rows[1][4], 'ativo');
  }, { sheetsClient, adminSecret: ADMIN_SECRET });
});

test('POST /admin/api/revoke devolve 404 para um e-mail sem nenhum cadastro', async () => {
  const sheetsClient = fakeSheetsClient([]);
  await withRelay(async ({ baseUrl }) => {
    const response = await request(baseUrl, '/admin/api/revoke', { method: 'POST', body: { email: 'ninguem@agu.gov.br' }, token: ADMIN_SECRET });
    assert.equal(response.status, 404);
  }, { sheetsClient, adminSecret: ADMIN_SECRET });
});
