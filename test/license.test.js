'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { signLicense, verifyLicense } = require('../license');

function makeKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
  };
}

test('signLicense + verifyLicense fazem o ciclo completo e devolvem o payload original', () => {
  const { privateKeyPem, publicKeyPem } = makeKeyPair();
  const payload = { email: 'fulano@agu.gov.br', machineId: 'abc-123', issuedAt: '2026-09-22T00:00:00.000Z' };
  const license = signLicense(privateKeyPem, payload);
  assert.match(license, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(verifyLicense(publicKeyPem, license), payload);
});

test('verifyLicense rejeita uma licença adulterada (payload alterado depois de assinado)', () => {
  const { privateKeyPem, publicKeyPem } = makeKeyPair();
  const license = signLicense(privateKeyPem, { email: 'a@b.com', machineId: 'm1' });
  const [payloadB64, signatureB64] = license.split('.');
  const tamperedPayload = Buffer.from(JSON.stringify({ email: 'atacante@b.com', machineId: 'm1' })).toString('base64url');
  assert.equal(verifyLicense(publicKeyPem, `${tamperedPayload}.${signatureB64}`), null);
});

test('verifyLicense rejeita quando a assinatura foi feita com outra chave privada', () => {
  const pairA = makeKeyPair();
  const pairB = makeKeyPair();
  const license = signLicense(pairA.privateKeyPem, { email: 'a@b.com', machineId: 'm1' });
  assert.equal(verifyLicense(pairB.publicKeyPem, license), null);
});

test('verifyLicense devolve null para entradas malformadas, sem lançar exceção', () => {
  const { publicKeyPem } = makeKeyPair();
  assert.equal(verifyLicense(publicKeyPem, ''), null);
  assert.equal(verifyLicense(publicKeyPem, 'sem-ponto-nenhum'), null);
  assert.equal(verifyLicense(publicKeyPem, 'a.b.c'), null);
  assert.equal(verifyLicense(publicKeyPem, null), null);
  assert.equal(verifyLicense(publicKeyPem, undefined), null);
});
