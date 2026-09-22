'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { GoogleSheetsClient } = require('../google-sheets');

function makeRsaPem() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return privateKey.export({ type: 'pkcs8', format: 'pem' });
}

function makeClient(overrides) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), method: (options && options.method) || 'GET', body: options && options.body });
    if (String(url) === 'https://oauth2.googleapis.com/token') {
      return { ok: true, json: async () => ({ access_token: 'access-fake', expires_in: 3600 }) };
    }
    return (overrides && overrides.dispatch) ? overrides.dispatch(String(url), options) : { ok: true, json: async () => ({}) };
  };
  const client = new GoogleSheetsClient({
    clientEmail: 'conta@apiss-remote-relay.iam.gserviceaccount.com',
    privateKey: makeRsaPem(),
    spreadsheetId: 'planilha-123',
    fetchImpl,
  });
  return { client, calls };
}

test('ensureAccessToken troca um JWT assinado por um access_token e reutiliza enquanto válido', async () => {
  const { client, calls } = makeClient();
  const token1 = await client.ensureAccessToken();
  const token2 = await client.ensureAccessToken();
  assert.equal(token1, 'access-fake');
  assert.equal(token2, 'access-fake');
  const tokenCalls = calls.filter((c) => c.url === 'https://oauth2.googleapis.com/token');
  assert.equal(tokenCalls.length, 1, 'não deveria pedir um token novo antes do atual expirar');
});

test('appendRow monta a URL de append com o range codificado e envia os valores', async () => {
  const { client, calls } = makeClient({
    dispatch: async () => ({ ok: true, json: async () => ({ updates: { updatedRows: 1 } }) }),
  });
  await client.appendRow('Página1!A:E', ['Fulano', 'fulano@example.com', 'm1', '2026-09-22', 'ativo']);
  const call = calls.find((c) => c.url.includes(':append'));
  assert.ok(call, 'deveria ter chamado o endpoint de append');
  assert.equal(call.method, 'POST');
  assert.ok(call.url.includes('P%C3%A1gina1'), 'o nome da aba deve ir url-encoded');
  assert.deepEqual(JSON.parse(call.body).values, [['Fulano', 'fulano@example.com', 'm1', '2026-09-22', 'ativo']]);
});

test('getRows devolve as linhas retornadas pela API (ou lista vazia se não houver "values")', async () => {
  const { client } = makeClient({
    dispatch: async (url) => {
      if (url.includes('vazio')) return { ok: true, json: async () => ({}) };
      return { ok: true, json: async () => ({ values: [['a', 'b'], ['c', 'd']] }) };
    },
  });
  assert.deepEqual(await client.getRows('Página1!A2:E'), [['a', 'b'], ['c', 'd']]);
});

test('updateRow envia PUT com valueInputOption=RAW e propaga erro da API', async () => {
  const { client, calls } = makeClient({
    dispatch: async () => ({ ok: false, json: async () => ({ error: { message: 'Range inválido' } }) }),
  });
  await assert.rejects(() => client.updateRow('Página1!E2', ['revogado']), /Range inválido/);
  const call = calls.find((c) => c.method === 'PUT');
  assert.ok(call.url.includes('valueInputOption=RAW'));
});

test('apiRequest lança um erro descritivo quando a API não devolve JSON de erro estruturado', async () => {
  const { client } = makeClient({
    dispatch: async () => ({ ok: false, status: 500, json: async () => { throw new Error('não é JSON'); } }),
  });
  await assert.rejects(() => client.getRows('Página1!A2:E'), /Erro 500/);
});
