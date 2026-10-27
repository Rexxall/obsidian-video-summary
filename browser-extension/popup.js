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
    codexWorkerUrl: $('setting-codex'),
    n8nWebhookUrl: $('setting-n8n'),
    webhookFormat: $('setting-webhook-format'),
    defaultMode: $('setting-mode'),
    defaultLanguage: $('setting-language'),
    obsidianRestProtocol: $('setting-rest-protocol'),
    obsidianRestPort: $('setting-rest-port'),
    obsidianRestToken: $('setting-rest-token'),
    paperStyle: $('setting-paper'),
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
    els.batchList.innerHTML = `<div class="empty">本页还没找到视频链接。</div>`;
    return;
  }
  els.batchList.innerHTML = '';
  const selectAll = document.createElement('div');
  selectAll.className = 'row';
  selectAll.innerHTML = `
    <input type="checkbox" id="batch-select-all" checked />
    <div>
      <div class="row-title">全选</div>
      <div class="row-meta">共 ${state.batch.length} 个</div>
    </div>
    <span class="subtle"></span>
  `;
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
    row.innerHTML = `
      <input type="checkbox" ${item.checked === false ? '' : 'checked'} />
      <div>
        <div class="row-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
        <div class="row-meta">${escapeHtml(getHostname(item.url))}</div>
      </div>
      <button data-action="queue">加入队列</button>
    `;
    row.querySelector('input').addEventListener('change', (event) => {
      item.checked = event.target.checked;
    });
    row.querySelector('button').addEventListener('click', () => queueItems([item]));
    els.batchList.appendChild(row);
  }
}

function renderQueue() {
  els.queueCount.textContent = String(state.queue.length);
  els.queueCountFull.textContent = String(state.queue.length);
  fillQueue(els.queueList, [...state.queue].reverse());
  fillQueue(els.queuePreview, [...state.queue].reverse().slice(0, 3));
}

function fillQueue(list, items) {
  if (items.length === 0) {
    list.innerHTML = `<div class="empty">队列是空的。</div>`;
    return;
  }
  list.innerHTML = '';
  items.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `
      <span class="platform">${escapeHtml(platformLabel(item.platform || U.detectPlatform(item.url)))}</span>
      <div>
        <div class="row-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
        <div class="row-meta">${escapeHtml(getHostname(item.url))}</div>
      </div>
      <button class="danger" data-action="remove">移除</button>
    `;
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
    els.historyList.innerHTML = `<div class="empty">还没有记录。</div>`;
    return;
  }
  els.historyList.innerHTML = '';
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
    row.innerHTML = `
      <span class="${tone}">${escapeHtml(statusText)}</span>
      <div>
        <div class="row-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
        <div class="row-meta">${escapeHtml(metaParts.join(' · '))}</div>
      </div>
      <button data-action="copy">复制</button>
    `;
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
  els.settings.paperStyle.checked = s.paperStyle === true;
  applyPaper(s.paperStyle === true);
  els.settings.vault.value = s.vaultName || '';
  els.settings.folder.value = s.folder || '';
  els.settings.appendPath.value = s.appendPath || '';
  els.settings.quickAction.value = s.quickAction || 'create-pending-note';
  els.settings.codexWorkerUrl.value = s.codexWorkerUrl || U.DEFAULT_SETTINGS.codexWorkerUrl;
  els.settings.n8nWebhookUrl.value = s.n8nWebhookUrl || U.DEFAULT_SETTINGS.n8nWebhookUrl;
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
    'send-to-codex-worker': 'Worker',
    'send-to-n8n': 'n8n',
    queue: '队列',
  };
  return labels[operation] || '未设置';
}

/** 主按钮写清这一下会做什么 */
function quickButtonLabel(operation) {
  if (['process-via-plugin', 'send-to-n8n', 'send-to-codex-worker'].includes(operation))
    return '送去总结';
  if (operation === 'append-link') return '追加到链接清单';
  if (operation === 'queue') return '加入队列';
  return '建一篇待处理笔记';
}

function applyPaper(on) {
  document.documentElement.classList.toggle('paper', on);
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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

async function saveSettings() {
  const settings = {
    vaultName: els.settings.vault.value.trim(),
    folder: els.settings.folder.value.trim(),
    appendPath: els.settings.appendPath.value.trim(),
    quickAction: els.settings.quickAction.value,
    codexWorkerUrl: els.settings.codexWorkerUrl.value.trim(),
    n8nWebhookUrl: els.settings.n8nWebhookUrl.value.trim(),
    webhookFormat: els.settings.webhookFormat.value,
    defaultMode: els.settings.defaultMode.value,
    defaultLanguage: els.settings.defaultLanguage.value,
    obsidianRestProtocol: els.settings.obsidianRestProtocol.value,
    obsidianRestPort: Number(els.settings.obsidianRestPort.value || 27123),
    obsidianRestToken: els.settings.obsidianRestToken.value.trim(),
    paperStyle: els.settings.paperStyle.checked,
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
  $('btn-current-codex').addEventListener('click', () =>
    transferItems([currentItem()], 'send-to-codex-worker'),
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
  $('btn-batch-codex').addEventListener('click', () =>
    transferItems(selectedBatchItems(), 'send-to-codex-worker'),
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
  $('btn-queue-codex').addEventListener('click', () =>
    transferItems(selectedQueueItems(), 'send-to-codex-worker'),
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
}

document.addEventListener('DOMContentLoaded', async () => {
  bindEvents();
  try {
    await refreshState();
  } catch (error) {
    setStatus(error.message, 'error');
  }
});
