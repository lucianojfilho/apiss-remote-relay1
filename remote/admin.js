'use strict';

var ADMIN_PASSWORD_KEY = 'apiss-admin-password';

function el(id) { return document.getElementById(id); }

function currentPassword() {
  try { return sessionStorage.getItem(ADMIN_PASSWORD_KEY) || ''; }
  catch (_e) { return window.__adminPassword || ''; }
}
function savePassword(value) {
  try { sessionStorage.setItem(ADMIN_PASSWORD_KEY, value); }
  catch (_e) { window.__adminPassword = value; }
}
function clearPassword() {
  try { sessionStorage.removeItem(ADMIN_PASSWORD_KEY); }
  catch (_e) { window.__adminPassword = ''; }
}

async function api(path, options) {
  var headers = Object.assign({ 'Content-Type': 'application/json' }, (options && options.headers) || {});
  var password = currentPassword();
  if (password && path !== '/admin/api/login') headers.Authorization = 'Bearer ' + password;
  var response = await fetch(path, Object.assign({}, options, { headers: headers }));
  var data = await response.json().catch(function () { return null; });
  if (!response.ok || !data || data.ok === false) {
    throw new Error((data && data.error && data.error.message) || 'Falha na requisição.');
  }
  return data.result;
}

function showList() {
  el('loginView').hidden = true;
  el('listView').hidden = false;
  loadRows();
}
function showLogin() {
  el('loginView').hidden = false;
  el('listView').hidden = true;
}

async function doLogin() {
  var password = el('adminPassword').value;
  el('loginStatus').textContent = 'Entrando…';
  try {
    savePassword(password);
    await api('/admin/api/login', { method: 'POST', body: JSON.stringify({ password: password }) });
    el('loginStatus').textContent = '';
    showList();
  } catch (error) {
    clearPassword();
    el('loginStatus').textContent = error.message || 'Senha incorreta.';
  }
}

function statusLabel(status) {
  if (status === 'ativo') return 'Ativo';
  if (status === 'revogado') return 'Revogado';
  return status || '—';
}

function formatDate(iso) {
  if (!iso) return '—';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function renderRows(rows) {
  var body = el('rowsBody');
  body.innerHTML = '';
  el('adminEmpty').hidden = rows.length > 0;
  rows.forEach(function (row) {
    var tr = document.createElement('tr');
    var isAtivo = row.status === 'ativo';
    tr.innerHTML =
      '<td>' + esc(row.nome) + '</td>' +
      '<td>' + esc(row.email) + '</td>' +
      '<td>' + esc(formatDate(row.dataCadastro)) + '</td>' +
      '<td class="status-' + esc(row.status) + '">' + esc(statusLabel(row.status)) + '</td>' +
      '<td class="actions-cell"><button type="button" class="secondary toggle-status">' + (isAtivo ? 'Revogar' : 'Reativar') + '</button></td>';
    tr.querySelector('.toggle-status').addEventListener('click', function () { toggleStatus(row.email, isAtivo); });
    body.appendChild(tr);
  });
}

function esc(value) {
  var div = document.createElement('div');
  div.textContent = String(value == null ? '' : value);
  return div.innerHTML;
}

async function loadRows() {
  el('listStatus').textContent = 'Carregando…';
  try {
    var result = await api('/admin/api/list', { method: 'GET' });
    renderRows(result.rows || []);
    el('listStatus').textContent = '';
  } catch (error) {
    el('listStatus').textContent = error.message || 'Não foi possível carregar a lista.';
  }
}

async function toggleStatus(email, isCurrentlyAtivo) {
  var action = isCurrentlyAtivo ? 'revoke' : 'reactivate';
  var confirmMessage = isCurrentlyAtivo
    ? 'Revogar o acesso de ' + email + '? O computador dela vai perder o uso do APISS na próxima verificação.'
    : 'Reativar o acesso de ' + email + '?';
  if (!window.confirm(confirmMessage)) return;
  el('listStatus').textContent = 'Aplicando…';
  try {
    await api('/admin/api/' + action, { method: 'POST', body: JSON.stringify({ email: email }) });
    await loadRows();
  } catch (error) {
    el('listStatus').textContent = error.message || 'Não foi possível aplicar a mudança.';
  }
}

el('btnAdminLogin').addEventListener('click', doLogin);
el('adminPassword').addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });
el('btnRefresh').addEventListener('click', loadRows);
el('btnAdminLogout').addEventListener('click', function () { clearPassword(); showLogin(); });

if (currentPassword()) showList(); else showLogin();
