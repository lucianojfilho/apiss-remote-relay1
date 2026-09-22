'use strict';

const crypto = require('node:crypto');

function base64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromBase64url(value) {
  return Buffer.from(String(value).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

// Licença = payload assinado com Ed25519. A chave privada mora só aqui, no
// relay (variável de ambiente) — nunca vai para o APISS nem para o
// repositório. O APISS embarca só a chave pública correspondente e consegue
// validar a licença sozinho, offline, sem precisar confiar de novo no relay
// a cada abertura do programa.
function signLicense(privateKeyPem, payload) {
  const payloadB64 = base64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  const signature = crypto.sign(null, Buffer.from(payloadB64), privateKey);
  return `${payloadB64}.${base64url(signature)}`;
}

function verifyLicense(publicKeyPem, license) {
  const [payloadB64, signatureB64] = String(license || '').split('.');
  if (!payloadB64 || !signatureB64) return null;
  try {
    const publicKey = crypto.createPublicKey(publicKeyPem);
    const ok = crypto.verify(null, Buffer.from(payloadB64), publicKey, fromBase64url(signatureB64));
    if (!ok) return null;
    return JSON.parse(fromBase64url(payloadB64).toString('utf8'));
  } catch (_error) {
    return null;
  }
}

module.exports = { signLicense, verifyLicense };
