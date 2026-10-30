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
  routeLabel: $('route-label'),
  currentTitle: $('current-title'),
  currentPlatform: $('current-platform'),
  currentTime: $('current-time'),
  currentUrl: $('current-url'),
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
        reject(new Error(response?.error || '扩展请求失败。'));
        return;
      }
      resolve(response);
    });
  });
}

function setStatus(message, type = '') {
  els.status.textContent = message || '';
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
  if (!state.current?.url) throw new Error('没有识别到当前页面的视频。');
  return state.current;
}

function renderCurrent() {
  const item = state.current;
  if (!item) {
    els.currentTitle.textContent = '当前页面不是视频';
    els.currentPlatform.textContent = '';
    els.currentTime.textContent = '';
    els.currentUrl.textContent = '可以扫描本页里的视频链接';
    return;
  }
  els.currentTitle.textContent = item.title;
  els.currentPlatform.textContent = platformLabel(item.platform || U.detectPlatform(item.url));
  els.currentTime.textContent = Number.isFinite(item.timestamp)
    ? U.formatTimestamp(item.timestamp)
    : '';
  els.currentUrl.textContent = getHostname(item.url);
  const copy = $('btn-current-copy');
  copy.textContent = Number.isFinite(item.timestamp)
    ? `复制 ${U.formatTimestamp(item.timestamp)} 链接`
    : '复制时间戳链接';
}

function platformLabel(platform) {
  const labels = {
    youtube: 'YouTube',
    bilibili: 'B站',
    douyin: '抖音',
    tiktok: 'TikTok',
    xiaohongshu: '小红书',
  };
  return labels[platform] || platform || '';
}

function renderBatch() {
  els.batchCount.textContent = String(state.batch.length);
  if (state.batch.length === 0) {
    els.batchList.replaceChildren(
      element('div', { className: 'empty', textContent: '本页还没找到视频链接。' }),
    );
    return;
  }
  els.batchList.replaceChildren();
  const selectAll = document.createElement('div');
  selectAll.className = 'row';
  const allBox = element('input', { type: 'checkbox', id: 'batch-select-all' });
  allBox.checked = true;
  selectAll.append(
    allBox,
    rowText('全选', `共 ${state.batch.length} 个`, false),
    element('span', { className: 'subtle' }),
  );
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
    row.append(
      box,
      rowText(item.title, getHostname(item.url)),
      element('button', { textContent: '加入队列', dataset: { action: 'queue' } }),
    );
    row.querySelector('input').addEventListener('change', (event) => {
      item.checked = event.target.checked;
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
function rowText(title, meta, withTooltip = true) {
  const box = element('div');
  const titleEl = element('div', { className: 'row-title', textContent: title || '' });
  if (withTooltip) titleEl.title = title || '';
  box.append(titleEl, element('div', { className: 'row-meta', textContent: meta || '' }));
  return box;
}

function renderQueue() {
  els.queueCount.textContent = String(state.queue.length);
  els.queueCountFull.textContent = String(state.queue.length);
  fillQueue(els.queueList, [...state.queue].reverse());
  fillQueue(els.queuePreview, [...state.queue].reverse().slice(0, 3));
}

function fillQueue(list, items) {
  if (items.length === 0) {
    list.replaceChildren(element('div', { className: 'empty', textContent: '队列是空的。' }));
    return;
  }
  list.replaceChildren();
  items.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'row';
    row.append(
      element('span', {
        className: 'platform',
        textContent: platformLabel(item.platform || U.detectPlatform(item.url)),
      }),
      rowText(item.title, getHostname(item.url)),
      element('button', {
        className: 'danger',
        textContent: '移除',
        dataset: { action: 'remove' },
      }),
    );
    row.querySelector('button').addEventListener('click', async () => {
      await send('QUEUE_REMOVE', { url: item.url });
      await refreshState();
      setStatus('已从队列移除。', 'success');
    });
    list.appendChild(row);
  });
}

function renderHistory() {
  if (state.history.length === 0) {
    els.historyList.replaceChildren(
      element('div', { className: 'empty', textContent: '还没有记录。' }),
    );
    return;
  }
  els.historyList.replaceChildren();
  [...state.history].reverse().forEach((item) => {
    const row = document.createElement('div');
    row.className = 'row';
    const tone =
      item.status === 'error'
        ? 'platform error'
        : item.status === 'needs-review'
          ? 'platform warning'
          : 'platform';
    const statusText =
      { error: '失败', 'needs-review': '待确认', success: '完成' }[item.status] || '完成';
    const metaParts = [
      item.operation ? labelOperation(item.operation) : '',
      item.jobStatus ? `任务：${item.jobStatus}` : '',
      new Date(item.at).toLocaleString(),
    ].filter(Boolean);
    row.append(
      element('span', { className: tone, textContent: statusText }),
      rowText(item.title, metaParts.join(' · ')),
      element('button', { textContent: '复制', dataset: { action: 'copy' } }),
    );
    row.querySelector('button').addEventListener('click', async () => {
      await navigator.clipboard.writeText(item.url || '');
      setStatus('已复制链接。', 'success');
    });
    els.historyList.appendChild(row);
  });
}

function renderSettings() {
  const s = state.settings;
  els.routeLabel.textContent = `送到：${labelOperation(s.quickAction)}`;
  els.quickButton.textContent = quickButtonLabel(s.quickAction);
  els.settings.vault.value = s.vaultName || '';
  els.settings.folder.value = s.folder || '';
  els.settings.appendPath.value = s.appendPath || '';
  els.settings.quickAction.value = s.quickAction || 'create-pending-note';
  els.settings.n8nWebhookUrl.value = '';
  els.settings.n8nWebhookUrl.placeholder = s.n8nToken
    ? `已保存：${s.n8nWebhookUrl}`
    : '粘贴启动脚本给的连接码';
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
    'create-pending-note': '待处理笔记',
    'process-via-plugin': 'Obsidian 插件',
    'create-pending-rest': '待处理笔记（REST）',
    'append-link': '链接清单',
    'send-to-n8n': 'n8n',
    queue: '队列',
  };
  return labels[operation] || '未设置';
}

/** 主按钮写清这一下会做什么 */
function quickButtonLabel(operation) {
  if (['process-via-plugin', 'send-to-n8n'].includes(operation)) return '送去总结';
  if (operation === 'append-link') return '追加到链接清单';
  if (operation === 'queue') return '加入队列';
  return '建一篇待处理笔记';
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
  setStatus('正在扫描本页…');
  const response = await send('SCAN_CURRENT_PAGE');
  state.batch = (response.items || []).map((item) => ({ ...item, checked: true }));
  renderBatch();
  setStatus(
    state.batch.length ? `找到 ${state.batch.length} 个视频链接。` : '本页没有找到视频链接。',
    state.batch.length ? 'success' : '',
  );
}

async function queueItems(items) {
  if (!items.length) return;
  const response = await send('QUEUE_ADD_MANY', { items });
  state.queue = response.queue || state.queue;
  renderQueue();
  setStatus(`已加入队列：${items.length} 个。`, 'success');
}

async function transferItems(items, operation) {
  if (!items.length) {
    setStatus('没有选中任何视频。', 'error');
    return;
  }
  setStatus(`正在发送 ${items.length} 个到${labelOperation(operation)}…`);
  const response = await send('TRANSFER_ITEMS', { items, operation });
  const results = response.results || [];
  const ok = results.filter((result) => result.status === 'success').length;
  const needsReview = results.filter((result) => result.status === 'needs-review').length;
  const failed = results.length - ok - needsReview;
  await refreshState();
  if (failed) {
    const firstError = results.find((result) => result.status === 'error')?.error || '原因不明';
    setStatus(`成功 ${ok} 个，失败 ${failed} 个：${firstError}`, 'error');
  } else if (needsReview) {
    const firstReview =
      results.find((result) => result.status === 'needs-review')?.error || '需要确认。';
    setStatus(`完成 ${ok} 个，${needsReview} 个待确认：${firstReview}`, 'warning');
  } else {
    setStatus(`完成 ${ok} 个。`, 'success');
  }
}

async function copyItems(items) {
  if (!items.length) return;
  await navigator.clipboard.writeText(items.map((item) => U.buildMarkdownLink(item)).join('\n'));
  setStatus(`已复制 ${items.length} 个 Markdown 链接。`, 'success');
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
    setStatus('没有允许读取 B 站 cookie，未同步。', 'error');
    return;
  }
  setStatus('正在同步 B 站登录…');
  const response = await send('SYNC_COOKIES', { platform: 'bilibili' });
  setStatus(`已同步 ${response.result.count} 条 B 站 cookie 到后端。`, 'success');
}

async function saveSettings() {
  const settings = {
    vaultName: els.settings.vault.value.trim(),
    folder: els.settings.folder.value.trim(),
    appendPath: els.settings.appendPath.value.trim(),
    quickAction: els.settings.quickAction.value,
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
  setStatus('已保存。', 'success');
}

/** “送去总结”：按设置里选的路线发送；路线是“队列”时只加入队列 */
function runQuick(items) {
  if (state.settings.quickAction === 'queue') return queueItems(items);
  return transferItems(items, state.settings.quickAction);
}

function bindEvents() {
  els.tabs.forEach((tab) => {
    tab.addEventListener('click', () => switchView(tab.dataset.view));
  });
  // 按钮里抛出的错误统一显示在底部状态行
  window.addEventListener('unhandledrejection', (event) =>
    setStatus(event.reason?.message || String(event.reason), 'error'),
  );
  window.addEventListener('error', (event) => setStatus(event.message, 'error'));

  $('btn-current-quick').addEventListener('click', () => runQuick([currentItem()]));
  $('btn-batch-quick').addEventListener('click', () => runQuick(selectedBatchItems()));
  $('btn-queue-quick').addEventListener('click', () => runQuick(selectedQueueItems()));
  $('btn-open-batch').addEventListener('click', () => switchView('batch'));
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
    send('COPY_TIMESTAMP_LINK').then((r) => setStatus(`已复制：${r.text}`, 'success')),
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
    setStatus('队列已清空。', 'success');
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
    setStatus('记录已清空。', 'success');
  });
  $('btn-save-settings').addEventListener('click', saveSettings);
  $('btn-sync-bilibili').addEventListener('click', () =>
    syncBilibiliLogin().catch((error) => setStatus(error.message, 'error')),
  );
}

document.addEventListener('DOMContentLoaded', async () => {
  bindEvents();
  try {
    await refreshState();
  } catch (error) {
    setStatus(error.message, 'error');
  }
});
