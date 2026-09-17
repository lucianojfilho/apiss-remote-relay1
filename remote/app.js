(function () {
  'use strict';

  var TOKEN_KEY = 'apiss-remote-token';
  var pollTimer = null;
  var latestProcesses = [];
  var selectedKeys = {};
  var searchText = '';
  var editingOpen = false; // pausa a atualização da lista enquanto o usuário edita um cartão

  function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (_e) { return ''; } }
  function setToken(value) { try { localStorage.setItem(TOKEN_KEY, value); } catch (_e) { /* localStorage indisponível */ } }
  function clearToken() { try { localStorage.removeItem(TOKEN_KEY); } catch (_e) { /* localStorage indisponível */ } }

  function el(id) { return document.getElementById(id); }

  function showPairView() {
    el('pairView').hidden = false;
    el('dashboardView').hidden = true;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function showDashboard() {
    el('pairView').hidden = true;
    el('dashboardView').hidden = false;
    refreshState();
    if (!pollTimer) pollTimer = setInterval(refreshState, 15000);
  }

  function api(path, options) {
    options = options || {};
    var headers = options.headers || {};
    var token = getToken();
    if (token) headers.Authorization = 'Bearer ' + token;
    if (options.body) headers['Content-Type'] = 'application/json';
    return fetch(path, {
      method: options.method || 'GET',
      headers: headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    }).then(function (response) {
      return response.json().then(function (data) { return { status: response.status, data: data }; });
    });
  }

  function formatWhen(iso) {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleString('pt-BR'); } catch (_e) { return iso; }
  }

  function formatDeadline(daysUntil) {
    if (daysUntil == null) return '';
    if (daysUntil < 0) return 'vencido há ' + Math.abs(daysUntil) + ' dia(s)';
    if (daysUntil === 0) return 'vence hoje';
    return 'faltam ' + daysUntil + ' dia(s)';
  }

  function renderLog(entries) {
    var list = el('logList');
    list.innerHTML = '';
    (entries || []).forEach(function (entry) {
      var li = document.createElement('li');
      li.textContent = formatWhen(entry.at) + ' — ' + entry.message;
      list.appendChild(li);
    });
    if (!entries || !entries.length) list.innerHTML = '<li class="empty">Nenhuma ação ainda.</li>';
  }

  function filteredProcesses() {
    var query = searchText.trim().toLowerCase();
    if (!query) return latestProcesses;
    return latestProcesses.filter(function (p) {
      return (p.numero || '').toLowerCase().indexOf(query) > -1 || (p.assunto || '').toLowerCase().indexOf(query) > -1;
    });
  }

  function updateDownloadButton() {
    var count = Object.keys(selectedKeys).filter(function (k) { return selectedKeys[k]; }).length;
    var button = el('btnDownloadBatch');
    button.disabled = count === 0;
    button.textContent = count ? 'Baixar selecionados (' + count + ')' : 'Baixar selecionados';
  }

  function renderProcessList() {
    var container = el('processList');
    var template = el('processCardTemplate');
    var rows = filteredProcesses();
    container.innerHTML = '';
    if (!rows.length) { container.innerHTML = '<p class="empty">Nenhum processo encontrado.</p>'; updateDownloadButton(); return; }
    rows.forEach(function (p) {
      var node = template.content.cloneNode(true);
      var checkbox = node.querySelector('.process-select');
      checkbox.checked = !!selectedKeys[p.key];
      checkbox.addEventListener('change', function () { selectedKeys[p.key] = checkbox.checked; updateDownloadButton(); });
      node.querySelector('.process-numero').textContent = p.numero || 'Processo sem número';
      node.querySelector('.process-assunto').textContent = p.assunto || '';
      var deadline = node.querySelector('.process-deadline');
      deadline.textContent = formatDeadline(p.daysUntil);
      deadline.className = 'process-deadline' + (p.daysUntil != null && p.daysUntil <= 0 ? ' urgent' : p.daysUntil != null && p.daysUntil <= 5 ? ' soon' : '');
      var editBox = node.querySelector('.process-edit');
      var statusSelect = node.querySelector('.process-status');
      var observacaoField = node.querySelector('.process-observacao');
      statusSelect.value = p.status || 'Ativo';
      observacaoField.value = p.observacao || '';
      node.querySelector('.process-open').addEventListener('click', function () {
        var willOpen = editBox.hidden;
        editBox.hidden = !willOpen;
        editingOpen = willOpen;
      });
      node.querySelector('.process-save').addEventListener('click', function (event) {
        var button = event.currentTarget, statusBox = editBox.querySelector('.process-edit-status');
        button.disabled = true;
        statusBox.textContent = 'Salvando…';
        api('/api/actions/update-process', { method: 'POST', body: { key: p.key, status: statusSelect.value, observacao: observacaoField.value } }).then(function (response) {
          if (response.status === 401) { clearToken(); showPairView(); return; }
          statusBox.textContent = (response.data && response.data.ok) ? 'Salvo.' : ((response.data && response.data.error && response.data.error.message) || 'Não foi possível salvar.');
          editingOpen = false;
          refreshState();
        }).catch(function () { statusBox.textContent = 'Falha de conexão.'; }).finally(function () { button.disabled = false; });
      });
      container.appendChild(node);
    });
    updateDownloadButton();
  }

  function refreshState() {
    api('/api/state').then(function (response) {
      if (response.status === 401) { clearToken(); showPairView(); return; }
      var result = response.data && response.data.result;
      if (!result) return;
      el('connectionState').textContent = result.connected ? 'APISS conectado.' : 'APISS não está conectado agora — abra o programa no computador.';
      el('connectionState').className = 'connection-state ' + (result.connected ? 'online' : 'offline');
      el('btnSync').disabled = !result.connected;
      el('cntDia').textContent = result.dayCount != null ? result.dayCount : '–';
      el('cntProximos').textContent = result.nearCount != null ? result.nearCount : '–';
      el('cntVencidos').textContent = result.overdueCount != null ? result.overdueCount : '–';
      el('lastSync').textContent = formatWhen(result.lastSyncAt);
      renderLog(result.log);
      latestProcesses = Array.isArray(result.processes) ? result.processes : [];
      if (!editingOpen) renderProcessList();
    }).catch(function () { el('connectionState').textContent = 'Não foi possível falar com o servidor.'; });
  }

  function runAction(path, button, busyLabel, doneLabel) {
    button.disabled = true;
    el('actionStatus').textContent = busyLabel;
    api(path, { method: 'POST' }).then(function (response) {
      if (response.status === 401) { clearToken(); showPairView(); return; }
      if (response.data && response.data.ok) el('actionStatus').textContent = doneLabel;
      else el('actionStatus').textContent = (response.data && response.data.error && response.data.error.message) || 'Não foi possível concluir.';
      refreshState();
    }).catch(function () {
      el('actionStatus').textContent = 'Falha de conexão com o APISS.';
    }).finally(function () {
      button.disabled = false;
    });
  }

  el('btnPair').addEventListener('click', function () {
    var code = el('pairCode').value.trim();
    if (!/^\d{6}$/.test(code)) { el('pairStatus').textContent = 'Digite os 6 números do código.'; return; }
    el('btnPair').disabled = true;
    el('pairStatus').textContent = 'Pareando…';
    api('/api/pair', { method: 'POST', body: { code: code, label: navigator.userAgent.slice(0, 40) } }).then(function (response) {
      if (response.data && response.data.ok) { setToken(response.data.result.token); showDashboard(); return; }
      el('pairStatus').textContent = (response.data && response.data.error && response.data.error.message) || 'Não foi possível parear.';
    }).catch(function () {
      el('pairStatus').textContent = 'Falha de conexão com o APISS.';
    }).finally(function () {
      el('btnPair').disabled = false;
    });
  });

  el('btnSync').addEventListener('click', function () {
    runAction('/api/actions/sync', el('btnSync'), 'Sincronizando com o SUPER…', 'Sincronização concluída.');
  });

  el('processSearch').addEventListener('input', function (event) {
    searchText = event.target.value;
    renderProcessList();
  });

  el('selectAllVisible').addEventListener('change', function (event) {
    filteredProcesses().forEach(function (p) { selectedKeys[p.key] = event.target.checked; });
    renderProcessList();
  });

  el('btnDownloadBatch').addEventListener('click', function () {
    var keys = Object.keys(selectedKeys).filter(function (k) { return selectedKeys[k]; });
    if (!keys.length) return;
    var button = el('btnDownloadBatch');
    button.disabled = true;
    el('batchStatus').textContent = 'Enviando pedido de download ao APISS…';
    api('/api/actions/download-batch', { method: 'POST', body: { keys: keys } }).then(function (response) {
      if (response.status === 401) { clearToken(); showPairView(); return; }
      if (response.data && response.data.ok) {
        var result = response.data.result || {};
        el('batchStatus').textContent = 'Sapiens: ' + (result.sapiensCount || 0) + ' baixado(s). TRF1: ' + (result.trf1Started || 0) + ' iniciado(s) (a conversão continua em segundo plano no APISS).';
        selectedKeys = {};
      } else {
        el('batchStatus').textContent = (response.data && response.data.error && response.data.error.message) || 'Não foi possível iniciar o download.';
      }
      refreshState();
    }).catch(function () {
      el('batchStatus').textContent = 'Falha de conexão com o APISS.';
    }).finally(function () {
      updateDownloadButton();
    });
  });

  el('btnForget').addEventListener('click', function () {
    clearToken();
    showPairView();
  });

  if (getToken()) showDashboard(); else showPairView();
})();
