/* global chrome -- Chrome extension APIs */
const U = window.VideoCaptureUtils;

const state = {
  settings: { ...U.DEFAULT_SETTINGS },
  current: null,
  batch: [],
  queue: [],
  history: [],
};

const $ = (id) => document.getElementById(id);

/** A message in the browser's language (see _locales/). */
function t(key, ...substitutions) {
  return chrome.i18n.getMessage(key, substitutions.map(String)) || key;
}

function localizePage() {
  document.documentElement.lang = chrome.i18n.getUILanguage();
  document.querySelectorAll('[data-i18n]').forEach((node) => {
    node.textContent = t(node.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((node) => {
    node.placeholder = t(node.dataset.i18nPlaceholder);
  });
}

const els = {
  tabs: Array.from(document.querySelectorAll('.tab')),
  views: {
    current: $('view-current'),
    batch: $('view-batch'),
    queue: $('view-queue'),
    history: $('view-history'),
    settings: $('view-settings'),
  },
  status: $('status'),
  queuePreview: $('queue-preview'),
  queueCountFull: $('queue-count-full'),
  quickButton: $('btn-current-quick'),
  currentTitle: $('current-title'),
  currentPlatform: $('current-platform'),
  currentTime: $('current-time'),
  batchCount: $('batch-count'),
  batchList: $('batch-list'),
  queueCount: $('queue-count'),
  queueList: $('queue-list'),
  historyList: $('history-list'),
  settings: {
    vault: $('setting-vault'),
    folder: $('setting-folder'),
    appendPath: $('setting-append'),
    quickAction: $('setting-quick'),
    sendCaptions: $('setting-captions'),
    obsidianBridge: $('setting-bridge'),
    sendInBackground: $('setting-background'),
    n8nWebhookUrl: $('setting-n8n'),
    webhookFormat: $('setting-webhook-format'),
    defaultMode: $('setting-mode'),
    defaultLanguage: $('setting-language'),
    obsidianRestProtocol: $('setting-rest-protocol'),
    obsidianRestPort: $('setting-rest-port'),
    obsidianRestToken: $('setting-rest-token'),
  },
};

function send(type, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...payload }, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || t('errRequestFailed')));
        return;
      }
      resolve(response);
    });
  });
}

/** Chrome's own wording when it keeps extensions off a page (chrome://, the Web Store, PDFs). */
function friendly(message) {
  return /cannot access|cannot be scripted|extensions gallery|chrome:\/\//i.test(message || '')
    ? t('cantReadPage')
    : message;
}

function setStatus(message, type = '') {
  els.status.textContent = friendly(message) || '';
  els.status.className = `status ${type}`.trim();
}

function switchView(name) {
  els.tabs.forEach((tab) => tab.classList.toggle('active', tab.dataset.view === name));
  Object.entries(els.views).forEach(([key, view]) => view.classList.toggle('active', key === name));
  setStatus('');
  if (name === 'batch' && state.batch.length === 0)
    scanPage().catch((error) => setStatus(error.message, 'error'));
}

function getHostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function selectedBatchItems() {
  return state.batch.filter((item) => item.checked !== false);
}

function selectedQueueItems() {
  return [...state.queue];
}

function currentItem() {
  if (!state.current?.url) throw new Error(t('noCurrentVideo'));
  return state.current;
}

function renderCurrent() {
  const item = state.current;
  // Not a video: the card turns into one button that looks for videos on the page.
  const isVideo = Boolean(item?.url && U.isVideoUrl(item.url));
  $('current-actions').hidden = !isVideo;
  $('current-more').hidden = !isVideo;
  $('btn-current-scan').hidden = isVideo;
  $('btn-open-batch').hidden = !isVideo;
  if (!isVideo) {
    els.currentTitle.textContent = t('noVideo');
    els.currentPlatform.textContent = '';
    els.currentTime.textContent = '';
    return;
  }
  els.currentTitle.textContent = item.title;
  els.currentTitle.title = item.title;
  const platform = item.platform || U.detectPlatform(item.url);
  els.currentPlatform.textContent = platformLabel(platform) || getHostname(item.url);
  const hasTime = Number.isFinite(item.timestamp) && item.timestamp > 0;
  els.currentTime.textContent = hasTime ? U.formatTimestamp(item.timestamp) : '';
  $('btn-current-copy').textContent = hasTime
    ? t('copyLinkAt', U.formatTimestamp(item.timestamp))
    : t('copyLink');
}

function platformLabel(platform) {
  const labels = {
    youtube: 'YouTube',
    bilibili: 'bilibili',
    douyin: 'Douyin',
    tiktok: 'TikTok',
    xiaohongshu: 'Xiaohongshu',
  };
  return labels[platform] || platform || '';
}

function renderBatch() {
  els.batchCount.textContent = String(state.batch.length);
  $('batch-actions').hidden = state.batch.length === 0;
  if (state.batch.length === 0) {
    els.batchList.replaceChildren(
      element('div', { className: 'empty', textContent: t('batchEmpty') }),
    );
    return;
  }
  els.batchList.replaceChildren();
  const selectAll = document.createElement('div');
  selectAll.className = 'row';
  const allBox = element('input', { type: 'checkbox', id: 'batch-select-all' });
  allBox.checked = state.batch.every((item) => item.checked !== false);
  allBox.setAttribute('aria-label', t('selectAll'));
  selectAll.append(allBox, rowText(t('selectAll'), '', false), element('span'));
  els.batchList.appendChild(selectAll);
  selectAll.querySelector('input').addEventListener('change', (event) => {
    state.batch.forEach((item) => {
      item.checked = event.target.checked;
    });
    renderBatch();
  });

  for (const item of state.batch) {
    const row = document.createElement('div');
    row.className = 'row';
    const box = element('input', { type: 'checkbox' });
    box.checked = item.checked !== false;
    box.setAttribute('aria-label', item.title || item.url);
    row.append(
      box,
      rowText(item.title, getHostname(item.url), true, item.url),
      element('button', { textContent: t('btnQueue'), dataset: { action: 'queue' } }),
    );
    row.querySelector('input').addEventListener('change', (event) => {
      item.checked = event.target.checked;
      allBox.checked = state.batch.every((entry) => entry.checked !== false);
    });
    row.querySelector('button').addEventListener('click', () => queueItems([item]));
    els.batchList.appendChild(row);
  }
}

/** A DOM element with properties set; text always goes in as text, never as HTML. */
function element(tag, props = {}) {
  const node = document.createElement(tag);
  const { dataset, ...rest } = props;
  Object.assign(node, rest);
  if (dataset) Object.assign(node.dataset, dataset);
  return node;
}

/** Title and one line of metadata, the middle column of every list row. */
function rowText(title, meta, withTooltip = true, url = '') {
  const box = element('div');
  // A video without a title still needs something to recognise it by.
  const shown = title || getHostname(url) || url;
  const titleEl = element('div', { className: 'row-title', textContent: shown });
  if (withTooltip) titleEl.title = title || url;
  const metaEl = element('div', { className: 'row-meta' });
  metaEl.append(...[].concat(meta).filter(Boolean));
  box.append(titleEl, metaEl);
  return box;
}

const shortTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' });

function renderQueue() {
  els.queueCount.textContent = String(state.queue.length);
  els.queueCountFull.textContent = String(state.queue.length);
  $('queue-actions').hidden = state.queue.length === 0;
  $('btn-queue-clear').hidden = state.queue.length === 0;
  $('queue-see-all').hidden = state.queue.length <= 3;
  fillQueue(els.queueList, [...state.queue].reverse());
  fillQueue(els.queuePreview, [...state.queue].reverse().slice(0, 3));
}

function fillQueue(list, items) {
  if (items.length === 0) {
    list.replaceChildren(element('div', { className: 'empty', textContent: t('queueEmpty') }));
    return;
  }
  list.replaceChildren();
  items.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'row';
    row.classList.add('two');
    row.append(
      rowText(
        item.title,
        platformLabel(item.platform || U.detectPlatform(item.url)) || getHostname(item.url),
        true,
        item.url,
      ),
      element('button', {
        className: 'danger',
        textContent: t('remove'),
        title: t('removeTitle'),
        dataset: { action: 'remove' },
      }),
    );
    row.querySelector('button').addEventListener('click', async () => {
      await send('QUEUE_REMOVE', { url: item.url });
      await refreshState();
      setStatus(t('removedFromQueue'), 'success');
    });
    list.appendChild(row);
  });
}

function renderHistory() {
  $('btn-history-clear').hidden = state.history.length === 0;
  if (state.history.length === 0) {
    els.historyList.replaceChildren(
      element('div', { className: 'empty', textContent: t('historyEmpty') }),
    );
    return;
  }
  els.historyList.replaceChildren();
  [...state.history].reverse().forEach((item) => {
    const row = document.createElement('div');
    row.className = 'row two';
    // Status leads the meta line in its colour; the reason for a failure is in the tooltip.
    const tone = { error: 'error', 'needs-review': 'warning' }[item.status] || '';
    const statusText =
      { error: t('statusFailed'), 'needs-review': t('statusReview') }[item.status] ||
      t('statusDone');
    const rest = [
      item.operation ? labelOperation(item.operation) : '',
      item.jobStatus ? t('jobStatus', item.jobStatus) : '',
      shortTime.format(new Date(item.at)),
    ].filter(Boolean);
    const text = rowText(
      item.title,
      [
        element('span', { className: `state ${tone}`.trim(), textContent: statusText }),
        ` · ${rest.join(' · ')}`,
      ],
      true,
      item.url,
    );
    if (item.error) text.title = item.error;
    row.append(text, element('button', { textContent: t('copy'), dataset: { action: 'copy' } }));
    row.querySelector('button').addEventListener('click', async () => {
      await navigator.clipboard.writeText(item.url || '');
      setStatus(t('copiedLink'), 'success');
    });
    els.historyList.appendChild(row);
  });
}

function renderSettings() {
  const s = state.settings;
  els.quickButton.textContent = quickButtonLabel(s.quickAction);
  els.settings.vault.value = s.vaultName || '';
  els.settings.folder.value = s.folder || '';
  els.settings.appendPath.value = s.appendPath || '';
  els.settings.quickAction.value = s.quickAction || 'create-pending-note';
  els.settings.sendCaptions.checked = s.sendCaptions !== false;
  els.settings.obsidianBridge.value = s.obsidianBridge || '';
  els.settings.sendInBackground.checked = s.sendInBackground !== false;
  els.settings.sendInBackground.disabled = !s.obsidianBridge;
  els.settings.n8nWebhookUrl.value = '';
  els.settings.n8nWebhookUrl.placeholder = s.n8nToken
    ? t('backendSaved', s.n8nWebhookUrl)
    : t('backendPlaceholder');
  els.settings.webhookFormat.value = s.webhookFormat || 'unified';
  els.settings.defaultMode.value = s.defaultMode || 'summary';
  els.settings.defaultLanguage.value = s.defaultLanguage || 'zh';
  els.settings.obsidianRestProtocol.value = s.obsidianRestProtocol || 'https';
  els.settings.obsidianRestPort.value = s.obsidianRestPort || 27123;
  els.settings.obsidianRestToken.value = s.obsidianRestToken || '';
}

function renderAll() {
  renderCurrent();
  renderBatch();
  renderQueue();
  renderHistory();
  renderSettings();
}

function labelOperation(operation) {
  const labels = {
    'create-pending-note': t('opPending'),
    'process-via-plugin': t('opPlugin'),
    'create-pending-rest': t('opPendingRest'),
    'append-link': t('opAppend'),
    'send-to-n8n': t('opN8n'),
    queue: t('opQueue'),
  };
  return labels[operation] || t('opUnset');
}

/** The main button says what this press will do. */
function quickButtonLabel(operation) {
  if (operation === 'process-via-plugin') return t('btnSummarize');
  if (operation === 'send-to-n8n') return t('btnSendN8n');
  if (operation === 'append-link') return t('btnAppend');
  if (operation === 'queue') return t('btnQueue');
  return t('btnPendingNote');
}

async function refreshState() {
  const response = await send('GET_STATE');
  state.settings = response.settings;
  state.queue = response.queue || [];
  state.history = response.history || [];
  state.current = response.current;
  renderAll();
  if (response.targetTab && els.views[response.targetTab]) switchView(response.targetTab);
}

async function scanPage() {
  setStatus(t('scanning'));
  const response = await send('SCAN_CURRENT_PAGE');
  state.batch = (response.items || []).map((item) => ({ ...item, checked: true }));
  renderBatch();
  setStatus('');
}

async function queueItems(items) {
  if (!items.length) return;
  const response = await send('QUEUE_ADD_MANY', { items });
  state.queue = response.queue || state.queue;
  renderQueue();
  setStatus(t('queuedN', items.length), 'success');
}

async function transferItems(items, operation) {
  if (!items.length) {
    setStatus(t('noneSelected'), 'error');
    return;
  }
  if (document.body.classList.contains('busy')) return;
  document.body.classList.add('busy');
  try {
    await sendItems(items, operation);
  } finally {
    document.body.classList.remove('busy');
  }
}

async function sendItems(items, operation) {
  setStatus(t('sendingN', items.length, labelOperation(operation)));
  const response = await send('TRANSFER_ITEMS', { items, operation });
  const results = response.results || [];
  const ok = results.filter((result) => result.status === 'success').length;
  const needsReview = results.filter((result) => result.status === 'needs-review').length;
  const failed = results.length - ok - needsReview;
  await refreshState();
  if (failed) {
    const firstError =
      results.find((result) => result.status === 'error')?.error || t('unknownReason');
    setStatus(t('resultFailed', ok, failed, firstError), 'error');
  } else if (needsReview) {
    const firstReview =
      results.find((result) => result.status === 'needs-review')?.error || t('needsReviewDefault');
    setStatus(t('resultReview', ok, needsReview, firstReview), 'warning');
  } else {
    setStatus(t('resultDone', ok), 'success');
  }
}

async function copyItems(items) {
  if (!items.length) return;
  await navigator.clipboard.writeText(items.map((item) => U.buildMarkdownLink(item)).join('\n'));
  setStatus(t('copiedN', items.length), 'success');
}

/** The connection code sets address and token; a plain URL changes only the address. */
function backendFromInput(raw) {
  const text = raw.trim();
  if (!text) return {};
  const code = U.parseConnectionCode(text);
  if (code) return { n8nWebhookUrl: code.url, n8nToken: code.token };
  return { n8nWebhookUrl: text };
}

async function syncBilibiliLogin() {
  // Asked only when used, so the extension does not hold cookie access by default.
  const granted = await chrome.permissions.request({
    permissions: ['cookies'],
    origins: ['https://*.bilibili.com/*'],
  });
  if (!granted) {
    setStatus(t('cookieDenied'), 'error');
    return;
  }
  setStatus(t('syncingBilibili'));
  const response = await send('SYNC_COOKIES', { platform: 'bilibili' });
  setStatus(t('syncedBilibili', response.result.count), 'success');
}

async function saveSettings() {
  const bridgeCode = els.settings.obsidianBridge.value.trim();
  if (bridgeCode && !U.parseBridgeCode(bridgeCode)) {
    setStatus(t('errBridgeFormat'), 'error');
    return;
  }
  // A backend on another computer needs that site's permission; ask while the click counts.
  const backend = backendFromInput(els.settings.n8nWebhookUrl.value).n8nWebhookUrl;
  const origin = backend ? U.backendOriginPattern(backend) : null;
  const allowed = origin ? await chrome.permissions.request({ origins: [origin] }) : true;
  const settings = {
    vaultName: els.settings.vault.value.trim(),
    folder: els.settings.folder.value.trim(),
    appendPath: els.settings.appendPath.value.trim(),
    quickAction: els.settings.quickAction.value,
    sendCaptions: els.settings.sendCaptions.checked,
    obsidianBridge: els.settings.obsidianBridge.value.trim(),
    sendInBackground: els.settings.sendInBackground.checked,
    n8nWebhookUrl: state.settings.n8nWebhookUrl,
    n8nToken: state.settings.n8nToken || '',
    ...backendFromInput(els.settings.n8nWebhookUrl.value),
    webhookFormat: els.settings.webhookFormat.value,
    defaultMode: els.settings.defaultMode.value,
    defaultLanguage: els.settings.defaultLanguage.value,
    obsidianRestProtocol: els.settings.obsidianRestProtocol.value,
    obsidianRestPort: Number(els.settings.obsidianRestPort.value || 27123),
    obsidianRestToken: els.settings.obsidianRestToken.value.trim(),
  };
  const response = await send('SAVE_SETTINGS', { settings });
  state.settings = response.settings;
  renderSettings();
  setStatus(allowed ? t('saved') : t('savedNoPermission'), allowed ? 'success' : 'error');
}

/** The main button: send by the route chosen in Settings; the queue route only queues. */
function runQuick(items) {
  if (state.settings.quickAction === 'queue') return queueItems(items);
  return transferItems(items, state.settings.quickAction);
}

function bindEvents() {
  els.tabs.forEach((tab) => {
    tab.addEventListener('click', () => switchView(tab.dataset.view));
  });
  // Errors thrown in any button show in the status line.
  window.addEventListener('unhandledrejection', (event) =>
    setStatus(event.reason?.message || String(event.reason), 'error'),
  );
  window.addEventListener('error', (event) => setStatus(event.message, 'error'));

  $('btn-current-quick').addEventListener('click', () => runQuick([currentItem()]));
  $('btn-batch-quick').addEventListener('click', () => runQuick(selectedBatchItems()));
  $('btn-queue-quick').addEventListener('click', () => runQuick(selectedQueueItems()));
  $('btn-open-batch').addEventListener('click', () => switchView('batch'));
  $('btn-current-scan').addEventListener('click', () => switchView('batch'));
  $('btn-current-queue').addEventListener('click', () => queueItems([currentItem()]));
  $('btn-current-pending').addEventListener('click', () =>
    transferItems([currentItem()], 'create-pending-note'),
  );
  $('btn-current-rest').addEventListener('click', () =>
    transferItems([currentItem()], 'create-pending-rest'),
  );
  $('btn-current-append').addEventListener('click', () =>
    transferItems([currentItem()], 'append-link'),
  );
  $('btn-current-copy').addEventListener('click', () =>
    send('COPY_TIMESTAMP_LINK').then((r) => setStatus(t('copiedText', r.text), 'success')),
  );
  $('btn-current-n8n').addEventListener('click', () =>
    transferItems([currentItem()], 'send-to-n8n'),
  );

  $('btn-scan').addEventListener('click', scanPage);
  $('btn-batch-queue').addEventListener('click', () => queueItems(selectedBatchItems()));
  $('btn-batch-pending').addEventListener('click', () =>
    transferItems(selectedBatchItems(), 'create-pending-note'),
  );
  $('btn-batch-append').addEventListener('click', () =>
    transferItems(selectedBatchItems(), 'append-link'),
  );
  $('btn-batch-n8n').addEventListener('click', () =>
    transferItems(selectedBatchItems(), 'send-to-n8n'),
  );
  $('btn-batch-copy').addEventListener('click', () => copyItems(selectedBatchItems()));

  $('btn-queue-clear').addEventListener('click', async () => {
    await send('QUEUE_CLEAR');
    await refreshState();
    setStatus(t('queueCleared'), 'success');
  });
  $('btn-queue-pending').addEventListener('click', () =>
    transferItems(selectedQueueItems(), 'create-pending-note'),
  );
  $('btn-queue-append').addEventListener('click', () =>
    transferItems(selectedQueueItems(), 'append-link'),
  );
  $('btn-queue-n8n').addEventListener('click', () =>
    transferItems(selectedQueueItems(), 'send-to-n8n'),
  );
  $('btn-queue-copy').addEventListener('click', () => copyItems(selectedQueueItems()));

  $('btn-history-clear').addEventListener('click', async () => {
    await send('HISTORY_CLEAR');
    await refreshState();
    setStatus(t('historyCleared'), 'success');
  });
  $('btn-save-settings').addEventListener('click', saveSettings);
  $('btn-sync-bilibili').addEventListener('click', () =>
    syncBilibiliLogin().catch((error) => setStatus(error.message, 'error')),
  );
}

document.addEventListener('DOMContentLoaded', async () => {
  localizePage();
  bindEvents();
  const header = document.querySelector('header');
  const edge = () => header.classList.toggle('scrolled', window.scrollY > 0);
  window.addEventListener('scroll', edge, { passive: true });
  edge();
  try {
    await refreshState();
  } catch (error) {
    setStatus(error.message, 'error');
  }
});
