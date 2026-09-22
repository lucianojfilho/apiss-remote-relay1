'use strict';

const crypto = require('node:crypto');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Autenticação de conta de serviço via JWT assinado (RFC 7523) — sem SDK do
// Google, no mesmo espírito do resto deste projeto: assina um JWT com a
// chave privada da conta de serviço e troca por um access_token via fetch.
class GoogleSheetsClient {
  constructor({ clientEmail, privateKey, spreadsheetId, fetchImpl }) {
    this.clientEmail = clientEmail;
    this.privateKey = privateKey;
    this.spreadsheetId = spreadsheetId;
    this.fetch = fetchImpl || globalThis.fetch;
    this.accessToken = null;
    this.expiresAt = 0;
  }

  async ensureAccessToken() {
    if (this.accessToken && this.expiresAt - Date.now() > 60000) return this.accessToken;
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const now = Math.floor(Date.now() / 1000);
    const claims = base64url(JSON.stringify({ iss: this.clientEmail, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 }));
    const signature = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), this.privateKey);
    const jwt = `${header}.${claims}.${base64url(signature)}`;
    const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt });
    const response = await this.fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error_description || data.error || 'Falha ao autenticar com a conta de serviço do Google.');
    this.accessToken = data.access_token;
    this.expiresAt = Date.now() + Number(data.expires_in || 3600) * 1000;
    return this.accessToken;
  }

  async apiRequest(method, pathname, body) {
    const token = await this.ensureAccessToken();
    const response = await this.fetch(`${SHEETS_API}/${this.spreadsheetId}${pathname}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.error?.message || `Erro ${response.status} ao acessar a planilha.`);
    return data;
  }

  appendRow(range, values) {
    return this.apiRequest('POST', `/values/${encodeURIComponent(range)}:append?valueInputOption=RAW`, { values: [values] });
  }

  async getRows(range) {
    const data = await this.apiRequest('GET', `/values/${encodeURIComponent(range)}`);
    return data.values || [];
  }

  updateRow(range, values) {
    return this.apiRequest('PUT', `/values/${encodeURIComponent(range)}?valueInputOption=RAW`, { values: [values] });
  }
}

module.exports = { GoogleSheetsClient };
