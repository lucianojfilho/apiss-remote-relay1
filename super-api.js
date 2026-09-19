'use strict';

const BASE_URL = 'https://supersapiensbackend.agu.gov.br/';
const TASKS_URL = `${BASE_URL}v2/administrativo/tarefa`;
const NOTIFICATION_URLS = Object.freeze([
  `${BASE_URL}v2/administrativo/notificacao`,
  `${BASE_URL}administrativo/notificacao`,
  `${BASE_URL}v1/administrativo/notificacao`,
]);
const NOTIFICATIONS_URL = NOTIFICATION_URLS[0];
const PAGE_SIZE = 250;
const MAX_TASKS = 5000;
const DOWNLOAD_NOTIFICATION_TYPE = 'DOWNLOAD PROCESSO';
const TASK_EXTRACT_CONTEXT = Object.freeze({
  capaProcesso: null,
  interessados: null,
  assuntos: null,
  sequenciais: null,
  extrato: true,
});

const TASK_POPULATE = [
  'processo',
  'processo.vinculacoesEtiquetas',
  'processo.vinculacoesEtiquetas.etiqueta',
  'processo.especieProcesso',
  'processo.origemDados',
  'processo.especieProcesso.generoProcesso',
  'processo.modalidadeMeio',
  'processo.setorAtual',
  'processo.setorAtual.unidade',
  'especieTarefa',
  'especieTarefa.generoTarefa',
  'folder',
  'usuarioResponsavel',
  'usuarioResponsavel.colaborador',
  'setorResponsavel',
  'setorResponsavel.unidade',
  'processo.interessados',
  'processo.assuntos',
  'processo.relevancias',
  'processo.vinculacoesProcessosJudiciaisProcessos',
  'processo.vinculacoesProcessosJudiciaisProcessos.processoJudicial',
  'any',
  'processo.any',
];

class SuperApiError extends Error {
  constructor(message, code = 'SUPER_ERROR', status = 0) {
    super(message);
    this.name = 'SuperApiError';
    this.code = code;
    this.status = status;
  }
}

function compactText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function onlyDigits(value) {
  return compactText(value).replace(/\D/g, '');
}

function formatCnj(value) {
  const digits = onlyDigits(value);
  if (digits.length !== 20) return compactText(value);
  return `${digits.slice(0, 7)}-${digits.slice(7, 9)}.${digits.slice(9, 13)}.${digits.slice(13, 14)}.${digits.slice(14, 16)}.${digits.slice(16)}`;
}

function firstText(...values) {
  for (const value of values) {
    const text = compactText(value);
    if (text) return text;
  }
  return '';
}

function dateText(value) {
  const raw = value && typeof value === 'object' ? value.date : value;
  const text = compactText(raw);
  if (!text) return { date: '', full: '' };
  const iso = text.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2})(?::\d{2})?)?/);
  if (iso) return { date: iso[1], full: `${iso[1]} ${iso[2] || '23:59'}` };
  const br = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{2}:\d{2}))?/);
  if (br) {
    const date = `${br[3]}-${br[2].padStart(2, '0')}-${br[1].padStart(2, '0')}`;
    return { date, full: `${date} ${br[4] || '23:59'}` };
  }
  return { date: '', full: text };
}

function collectCandidateNumbers(value, out = [], depth = 0, seen = new Set()) {
  if (value === null || value === undefined || depth > 5) return out;
  if (typeof value !== 'object') return out;
  if (seen.has(value)) return out;
  seen.add(value);

  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    if (/(cnj|numero.*process|process.*numero|outronumero)/.test(normalizedKey)) {
      if (Array.isArray(child)) child.forEach((item) => out.push(compactText(item)));
      else if (typeof child !== 'object') out.push(compactText(child));
    }
    if (child && typeof child === 'object') collectCandidateNumbers(child, out, depth + 1, seen);
  }
  return out.filter(Boolean);
}

function findCnj(task) {
  const processo = task?.processo || {};
  const vinculacoes = Array.isArray(processo.vinculacoesProcessosJudiciaisProcessos)
    ? processo.vinculacoesProcessosJudiciaisProcessos
    : [];
  const candidates = [
    ...vinculacoes.flatMap((vinculacao) => [
      vinculacao?.processoJudicial?.numeroFormatado,
      vinculacao?.processoJudicial?.numero,
    ]),
    processo.outroNumero,
    task.numeroProcesso,
    task.numeroProcessoJudicial,
    task.numeroCNJ,
    ...collectCandidateNumbers(task),
  ];
  const cnj = candidates.find((value) => onlyDigits(value).length === 20);
  return cnj ? formatCnj(cnj) : '';
}

function relationNames(items, nestedKeys = []) {
  const source = Array.isArray(items) ? items : items ? [items] : [];
  const names = [];
  for (const item of source) {
    if (!item) continue;
    const candidates = [item.nome, item.titulo, item.descricao, item.valor];
    for (const key of nestedKeys) {
      const nested = item[key];
      if (nested) candidates.unshift(nested.nome, nested.titulo, nested.descricao, nested.valor);
    }
    const name = firstText(...candidates);
    if (name && !names.includes(name)) names.push(name);
  }
  return names.join('; ');
}

function normalizeTask(task, syncedAt = new Date().toISOString()) {
  const processo = task?.processo || {};
  const start = dateText(task?.dataHoraInicioPrazo);
  const end = dateText(task?.dataHoraFinalPrazo);
  const nup = firstText(processo.NUPFormatado, processo.NUP, task?.NUP);
  const cnj = findCnj(task);
  const especieTarefa = firstText(task?.especieTarefa?.nome, task?.especieTarefa?.titulo, task?.generoTarefa);
  const setor = task?.setorResponsavel || task?.setor || {};
  const folder = task?.folder || {};
  const responsavel = task?.usuarioResponsavel || {};
  const setorResponsavel = firstText(
    [setor.sigla, setor.nome].filter(Boolean).join(' — '),
    setor.nome,
    setor.sigla,
  );
  const assuntos = relationNames(processo.assuntos, ['assuntoAdministrativo', 'assuntoJudicial']);
  const interessados = relationNames(processo.interessados, ['pessoa']);
  const observacao = firstText(task?.observacao, task?.descricao, task?.titulo, processo.titulo);
  const numero = cnj;

  return {
    idTarefa: task?.id ?? '',
    superProcessoId: processo.id ?? '',
    nup,
    numero,
    numeroAlternativo: firstText(processo.outroNumero && processo.outroNumero !== cnj ? processo.outroNumero : ''),
    assunto: firstText(assuntos, processo.titulo, processo.especieProcesso?.nome),
    orgao: interessados,
    origem: firstText(processo.origemDados?.nome, processo.procedencia?.nome),
    orgaoJulgador: firstText(processo.setorAtual?.nome, processo.setorAtual?.sigla),
    tribunal: firstText(processo.setorAtual?.unidade?.nome, setor.unidade?.nome),
    classeProcessual: firstText(processo.especieProcesso?.nome, processo.especieProcesso?.generoProcesso?.nome),
    dataInicial: start.date,
    dataInicialHora: start.full,
    dataFinal: end.date,
    dataFinalHora: end.full,
    setorResponsavel,
    especieTarefa,
    pastaSapiens: firstText(folder.nome, folder.titulo, folder.descricao),
    responsavel: firstText(responsavel.nome, responsavel.name, responsavel.colaborador?.nome, responsavel.username, responsavel.email),
    observacao,
    motivoIntimacao: observacao,
    prazoConcedido: end.date ? 'Prazo informado pelo SUPER Sapiens' : '',
    urgente: Boolean(task?.urgente),
    status: 'Ativo',
    fonteTipo: 'super',
    fonteAgenda: 'SUPER Sapiens',
    importadoEm: syncedAt,
  };
}

function safeServerMessage(body) {
  const message = firstText(body?.message, body?.error?.message, body?.error_description, body?.detail);
  return message.slice(0, 300);
}

function networkFailureMessage(error) {
  const detail = firstText(error?.cause?.code, error?.code, error?.cause?.message, error?.message).toUpperCase();
  if (/CERT|SSL|TLS/.test(detail)) {
    return 'O Windows recusou o certificado de segurança do SUPER. Atualize a VPN/certificados institucionais e tente novamente.';
  }
  if (/PROXY/.test(detail)) {
    return 'O proxy do Windows não conseguiu alcançar o SUPER. Reconecte a VPN ou confira a configuração de proxy.';
  }
  if (/NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN|DNS/.test(detail)) {
    return 'O endereço do SUPER não foi localizado pela rede. Reconecte a VPN e tente novamente.';
  }
  if (/TIMED_OUT|TIMEOUT|ETIMEDOUT|CONNECT_TIMEOUT/.test(detail)) {
    return 'A conexão com o SUPER excedeu o tempo limite. Reconecte a VPN e tente novamente.';
  }
  if (/CONNECTION_RESET|ECONNRESET|CONNECTION_CLOSED/.test(detail)) {
    return 'A conexão com o SUPER foi interrompida pela rede. Reconecte a VPN e tente novamente.';
  }
  return 'Não foi possível comunicar com o SUPER pela rede do Windows. Confira a internet/VPN e tente novamente.';
}

function extractDownloadContext(value, depth = 0, seen = new Set()) {
  if (!value || typeof value !== 'object' || depth > 6 || seen.has(value)) return {};
  seen.add(value);
  const directComponent = firstText(
    value.componente_digital_id,
    value.componenteDigitalId,
    value.component_id,
    value.componentId,
    value.componenteId,
    value.componenteDigital?.id,
    value.componente_digital?.id,
    value.component?.id,
  );
  const directProcess = firstText(value.processo_id, value.processId, value.processo?.id);
  if (directComponent) return { componente_digital_id: directComponent, processo_id: directProcess };
  for (const child of Object.values(value)) {
    if (!child || typeof child !== 'object') continue;
    const found = extractDownloadContext(child, depth + 1, seen);
    if (found.componente_digital_id) return found;
  }
  return {};
}

function isPdfPayload(value) {
  const content = compactText(value?.conteudo);
  return Boolean(content && (/^data:application\/pdf;base64,/i.test(content) || /^JVBER/i.test(content)));
}

function decodeTaskExtractPayload(response) {
  const content = [response?.conteudo, response?.content, response?.payload?.conteudo]
    .find((value) => typeof value === 'string' && value.trim());
  if (!content) throw new SuperApiError('O SUPER não retornou o conteúdo do extrato.', 'REPORT_CONTENT_MISSING');
  const invalid = () => new SuperApiError('O extrato retornado pelo SUPER não pôde ser lido.', 'INVALID_REPORT_CONTENT');
  let buffer;
  const match = content.trim().match(/^data:([^,]*),([\s\S]*)$/i);
  if (match && match[1].split(';').some((part) => part.trim().toLowerCase() === 'base64')) {
    const encoded = match[2].replace(/\s/g, '');
    if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 === 1) throw invalid();
    buffer = Buffer.from(encoded, 'base64');
    if (buffer.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) throw invalid();
  } else if (!/^data:/i.test(content.trim())) {
    buffer = Buffer.from(content, 'utf8');
  } else {
    throw invalid();
  }
  if (!/<(?:!doctype\s+html|html|body|table)\b/i.test(buffer.toString('utf8'))) throw invalid();
  return { buffer, mime: 'text/html', fileName: firstText(response?.fileName, response?.filename) };
}

class SuperApi {
  constructor(fetchImpl = globalThis.fetch, options = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('fetch indisponível');
    this.fetch = fetchImpl;
    this.wait = options.wait || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.downloadPollIntervalMs = options.downloadPollIntervalMs || 5000;
    this.downloadMaxPolls = options.downloadMaxPolls || 360;
    this.notificationUrls = options.notificationUrls || NOTIFICATION_URLS;
    this.token = '';
    this.challenge = '';
    this.profile = null;
  }

  async requestFirstAvailable(urls, options, unavailableMessage, unavailableCode) {
    let lastError = null;
    for (const url of urls) {
      try { return await this.request(url, options); }
      catch (error) {
        lastError = error;
        if (![404, 405].includes(Number(error?.status))) throw error;
      }
    }
    throw new SuperApiError(unavailableMessage, unavailableCode, Number(lastError?.status) || 404);
  }

  status() {
    return {
      authenticated: Boolean(this.token && this.profile?.id),
      awaitingTotp: Boolean(this.challenge && !this.token),
      profile: this.profile ? {
        id: this.profile.id,
        name: firstText(this.profile.nome, this.profile.name, this.profile.colaborador?.nome),
        username: firstText(this.profile.username, this.profile.email),
      } : null,
    };
  }

  logout() {
    this.token = '';
    this.challenge = '';
    this.profile = null;
    return this.status();
  }

  async login({ username, password, loginType = 'auto' } = {}) {
    const user = compactText(username);
    if (!user || typeof password !== 'string' || !password) {
      throw new SuperApiError('Informe o usuário e a senha.', 'VALIDATION');
    }

    this.logout();
    const cpf = onlyDigits(user);
    const type = loginType === 'interno' || loginType === 'ldap'
      ? loginType
      : cpf.length === 11 && !/@/.test(user) ? 'interno' : 'ldap';
    const endpoint = type === 'interno' ? 'auth/get_token' : 'auth/ldap_get_token';
    const body = await this.request(`${BASE_URL}${endpoint}`, {
      method: 'POST',
      body: { username: user, password },
      authenticated: false,
    });
    return this.acceptAuthentication(body);
  }

  async verifyTotp({ code } = {}) {
    const cleanCode = onlyDigits(code);
    if (!this.challenge) throw new SuperApiError('Não há autenticação de dois fatores pendente.', 'NO_CHALLENGE');
    if (!/^\d{6}$/.test(cleanCode)) throw new SuperApiError('Digite os 6 números do Authenticator.', 'VALIDATION');

    const challenge = this.challenge;
    const body = await this.request(`${BASE_URL}auth/totp/verify`, {
      method: 'POST',
      body: { challenge, code: cleanCode },
      authenticated: false,
    });
    return this.acceptAuthentication(body);
  }

  async acceptAuthentication(response) {
    const payload = response?.payload && typeof response.payload === 'object' ? response.payload : response;
    const totpRequired = Boolean(response?.totpRequired ?? payload?.totpRequired);
    const challenge = firstText(response?.challenge, payload?.challenge);
    if (totpRequired || (challenge && !payload?.token)) {
      if (!challenge) throw new SuperApiError('O SUPER solicitou o segundo fator, mas não forneceu o desafio de autenticação.', 'TOTP_ERROR');
      this.challenge = challenge;
      return { status: 'totp_required', ...this.status() };
    }

    const token = firstText(payload?.token, response?.token, payload?.access_token);
    if (!token) throw new SuperApiError('A resposta de autenticação do SUPER não trouxe um token válido.', 'TOKEN_MISSING');
    this.token = token;
    this.challenge = '';
    try {
      this.profile = await this.request(`${BASE_URL}profile`, { authenticated: true });
      if (!this.profile?.id) throw new Error('perfil sem identificador');
    } catch (error) {
      this.logout();
      if (error instanceof SuperApiError) throw error;
      throw new SuperApiError('Login aceito, mas não foi possível identificar o perfil no SUPER.', 'PROFILE_ERROR');
    }
    return { status: 'authenticated', ...this.status() };
  }

  async syncTasks({ genre = 'judicial' } = {}) {
    if (!this.token || !this.profile?.id) throw new SuperApiError('Conecte-se ao SUPER antes de sincronizar.', 'NOT_AUTHENTICATED', 401);
    const where = {
      'usuarioResponsavel.id': `eq:${this.profile.id}`,
      dataHoraConclusaoPrazo: 'isNull',
    };
    const requestedGenre = compactText(genre).toUpperCase();
    const normalizedGenre = ['JUDICIAL', 'ADMINISTRATIVO', 'ALL'].includes(requestedGenre) ? requestedGenre : 'JUDICIAL';
    if (normalizedGenre !== 'ALL') where['especieTarefa.generoTarefa.nome'] = `eq:${normalizedGenre}`;
    const context = { interessados: true, assuntos: true, relevancias: true };
    if (normalizedGenre !== 'ALL') context.modulo = normalizedGenre;
    const entities = [];
    let total = 0;

    for (let offset = 0; offset < MAX_TASKS; offset += PAGE_SIZE) {
      const url = new URL(TASKS_URL);
      url.searchParams.set('where', JSON.stringify(where));
      url.searchParams.set('limit', String(PAGE_SIZE));
      url.searchParams.set('offset', String(offset));
      url.searchParams.set('order', JSON.stringify({ dataHoraFinalPrazo: 'ASC' }));
      url.searchParams.set('populate', JSON.stringify(TASK_POPULATE));
      url.searchParams.set('context', JSON.stringify(context));
      const page = await this.request(url.toString(), { authenticated: true });
      const pageEntities = Array.isArray(page?.entities) ? page.entities : Array.isArray(page) ? page : [];
      total = Number(page?.total ?? pageEntities.length);
      entities.push(...pageEntities);
      if (!pageEntities.length || entities.length >= total || pageEntities.length < PAGE_SIZE) break;
    }

    const syncedAt = new Date().toISOString();
    return {
      tasks: entities.slice(0, MAX_TASKS).map((task) => normalizeTask(task, syncedAt)),
      total,
      truncated: total > MAX_TASKS,
      syncedAt,
      profile: this.status().profile,
    };
  }

  async downloadProcessTaskExtract(processId, { signal } = {}) {
    if (!this.token || !this.profile?.id) throw new SuperApiError('Conecte-se ao SUPER antes de gerar extratos.', 'NOT_AUTHENTICATED', 401);
    const id = onlyDigits(processId);
    if (!id) throw new SuperApiError('O processo não possui identificador interno do SUPER.', 'PROCESS_ID_MISSING');
    const url = new URL(`${BASE_URL}v1/administrativo/processo/imprime_relatorio/${id}`);
    url.searchParams.set('context', JSON.stringify(TASK_EXTRACT_CONTEXT));
    const response = await this.request(url.toString(), { authenticated: true, signal });
    return decodeTaskExtractPayload(response);
  }

  async listDownloadNotifications(limit = 100) {
    if (!this.token || !this.profile?.id) throw new SuperApiError('Conecte-se ao SUPER antes de baixar processos.', 'NOT_AUTHENTICATED', 401);
    const urls = this.notificationUrls.map((endpoint) => {
      const url = new URL(endpoint);
      url.searchParams.set('where', JSON.stringify({
        'destinatario.id': `eq:${this.profile.id}`,
      }));
      url.searchParams.set('limit', String(Math.min(Math.max(Number(limit) || 100, 1), 250)));
      url.searchParams.set('offset', '0');
      url.searchParams.set('order', JSON.stringify({ id: 'DESC' }));
      url.searchParams.set('populate', JSON.stringify(['populateAll']));
      url.searchParams.set('context', JSON.stringify({}));
      return url.toString();
    });
    const page = await this.requestFirstAvailable(
      urls,
      { authenticated: true },
      'O SUPER alterou a rota de notificações necessária para acompanhar a geração do PDF.',
      'NOTIFICATION_ROUTE_UNAVAILABLE',
    );
    return Array.isArray(page?.entities) ? page.entities : Array.isArray(page) ? page : [];
  }

  async requestProcessPdf(processId, signal) {
    const id = String(processId || '').replace(/\D/g, '');
    if (!id) throw new SuperApiError('O processo não possui identificador interno do SUPER.', 'PROCESS_ID_MISSING');
    return this.requestFirstAvailable([
      `${BASE_URL}v2/administrativo/processo/${id}/download/PDF/all`,
      `${BASE_URL}administrativo/processo/${id}/download/PDF/all`,
      `${BASE_URL}v1/administrativo/processo/${id}/download/PDF/all`,
    ], { authenticated: true, signal }, 'O SUPER alterou a rota usada para solicitar a íntegra do processo.', 'PROCESS_DOWNLOAD_ROUTE_UNAVAILABLE');
  }

  async downloadDigitalComponent(componentId, signal) {
    const id = String(componentId || '').replace(/\D/g, '');
    if (!id) throw new SuperApiError('A notificação não trouxe o identificador do PDF.', 'COMPONENT_ID_MISSING');
    return this.requestFirstAvailable([
      `${BASE_URL}v2/administrativo/componente_digital/${id}/download`,
      `${BASE_URL}administrativo/componente_digital/${id}/download`,
      `${BASE_URL}v1/administrativo/componente_digital/${id}/download`,
    ], { authenticated: true, signal }, 'O SUPER alterou a rota usada para receber o PDF pronto.', 'COMPONENT_DOWNLOAD_ROUTE_UNAVAILABLE');
  }

  notificationContext(notification) {
    if (!notification) return {};
    if (notification.contexto && typeof notification.contexto === 'object') return notification.contexto;
    if (notification.context && typeof notification.context === 'object') return notification.context;
    try { return JSON.parse(notification.contexto || notification.context || '{}'); } catch { return {}; }
  }

  async waitForProcessPdf(processId, knownNotificationIds, { signal, onStage } = {}) {
    const known = knownNotificationIds instanceof Set ? knownNotificationIds : new Set(knownNotificationIds || []);
    for (let attempt = 1; attempt <= this.downloadMaxPolls; attempt += 1) {
      if (signal?.aborted) throw new SuperApiError('Download cancelado.', 'CANCELLED');
      const notifications = await this.listDownloadNotifications();
      const match = notifications.find((notification) => {
        if (known.has(String(notification?.id ?? ''))) return false;
        const context = this.notificationContext(notification);
        const extracted = extractDownloadContext(context);
        const componentId = firstText(context.componente_digital_id, context.componenteDigitalId, extracted.componente_digital_id);
        const contextProcessId = firstText(context.id, context.processo_id, context.processId, extracted.processo_id);
        const notificationType = firstText(notification?.tipoNotificacao?.nome, notification?.tipo, notification?.type);
        return (!notificationType || notificationType === DOWNLOAD_NOTIFICATION_TYPE)
          && String(contextProcessId) === String(processId)
          && Boolean(componentId);
      });
      if (match) {
        const context = this.notificationContext(match);
        const extracted = extractDownloadContext(context);
        return { ...context, componente_digital_id: firstText(context.componente_digital_id, context.componenteDigitalId, extracted.componente_digital_id) };
      }
      if (typeof onStage === 'function') onStage({ stage: 'waiting', attempt, maxAttempts: this.downloadMaxPolls });
      await this.wait(this.downloadPollIntervalMs);
    }
    throw new SuperApiError('O SUPER não concluiu a geração do PDF dentro do tempo de espera.', 'DOWNLOAD_TIMEOUT');
  }

  async downloadProcessPdf(processId, { signal, onStage } = {}) {
    if (!this.token || !this.profile?.id) throw new SuperApiError('Conecte-se ao SUPER antes de baixar processos.', 'NOT_AUTHENTICATED', 401);
    if (typeof onStage === 'function') onStage({ stage: 'checking' });
    let knownIds = new Set();
    let notificationRouteAvailable = true;
    try {
      const before = await this.listDownloadNotifications();
      knownIds = new Set(before.map((item) => String(item?.id ?? '')));
    } catch (error) {
      if (error?.code !== 'NOTIFICATION_ROUTE_UNAVAILABLE') throw error;
      notificationRouteAvailable = false;
    }
    if (typeof onStage === 'function') onStage({ stage: 'requesting' });
    const requested = await this.requestProcessPdf(processId, signal);
    if (isPdfPayload(requested)) return requested;
    const directContext = extractDownloadContext(requested);
    if (directContext.componente_digital_id) {
      if (typeof onStage === 'function') onStage({ stage: 'downloading' });
      return this.downloadDigitalComponent(directContext.componente_digital_id, signal);
    }
    if (!notificationRouteAvailable) {
      throw new SuperApiError('O pedido de PDF foi recebido, mas o SUPER não disponibilizou uma rota para acompanhar a geração.', 'NOTIFICATION_ROUTE_UNAVAILABLE', 404);
    }
    if (typeof onStage === 'function') onStage({ stage: 'waiting' });
    const context = await this.waitForProcessPdf(processId, knownIds, { signal, onStage });
    if (typeof onStage === 'function') onStage({ stage: 'downloading' });
    return this.downloadDigitalComponent(context.componente_digital_id, signal);
  }

  async request(url, { method = 'GET', body, authenticated = false, signal } = {}) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (authenticated) {
      if (!this.token) throw new SuperApiError('Sessão do SUPER não iniciada.', 'NOT_AUTHENTICATED', 401);
      headers.Authorization = `Bearer ${this.token}`;
    }

    let response;
    try {
      response = await this.fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw new SuperApiError('Download cancelado.', 'CANCELLED');
      throw new SuperApiError(networkFailureMessage(error), 'NETWORK');
    }

    let data = null;
    const text = await response.text();
    if (text) {
      try { data = JSON.parse(text); } catch { data = { message: text }; }
    }
    if (!response.ok) {
      if (response.status === 401) {
        if (authenticated) this.logout();
        throw new SuperApiError('Credenciais, código ou sessão recusados pelo SUPER.', 'UNAUTHORIZED', 401);
      }
      if (response.status === 403) throw new SuperApiError('O perfil não possui permissão para esta consulta no SUPER.', 'FORBIDDEN', 403);
      const serverMessage = safeServerMessage(data);
      throw new SuperApiError(serverMessage || `O SUPER retornou erro ${response.status}.`, 'HTTP_ERROR', response.status);
    }
    return data || {};
  }
}

module.exports = {
  BASE_URL,
  DOWNLOAD_NOTIFICATION_TYPE,
  TASK_EXTRACT_CONTEXT,
  NOTIFICATION_URLS,
  NOTIFICATIONS_URL,
  TASKS_URL,
  SuperApi,
  SuperApiError,
  decodeTaskExtractPayload,
  normalizeTask,
};
