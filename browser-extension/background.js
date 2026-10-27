// Load the shared single-source core (vendored from @video-summary/shared) BEFORE utils.js,
// which delegates platform detection / URL canonicalization to self.VideoSummaryShared.
importScripts('vendor/shared.global.js', 'utils.js');

const U = self.VideoCaptureUtils;
const HISTORY_LIMIT = 80;

function syncGet(keys) {
  return chrome.storage.sync.get(keys);
}

function syncSet(value) {
  return chrome.storage.sync.set(value);
}

function localGet(keys) {
  return chrome.storage.local.get(keys);
}

function localSet(value) {
  return chrome.storage.local.set(value);
}

// The Obsidian REST token stays on this device; everything else syncs with the browser profile.
const LOCAL_ONLY_SETTINGS = ['obsidianRestToken'];

async function getSettings() {
  const stored = await syncGet(Object.keys(U.DEFAULT_SETTINGS));
  const local = await localGet(LOCAL_ONLY_SETTINGS);
  // Versions up to 0.2 kept the token in sync storage; move it once.
  if (stored.obsidianRestToken && !local.obsidianRestToken) {
    await localSet({ obsidianRestToken: stored.obsidianRestToken });
    local.obsidianRestToken = stored.obsidianRestToken;
  }
  if (stored.obsidianRestToken !== undefined) {
    await chrome.storage.sync.remove(LOCAL_ONLY_SETTINGS);
    delete stored.obsidianRestToken;
  }
  return { ...U.DEFAULT_SETTINGS, ...stored, ...local };
}

async function setSettings(settings) {
  const next = { ...U.DEFAULT_SETTINGS, ...settings };
  const synced = { ...next };
  for (const key of LOCAL_ONLY_SETTINGS) delete synced[key];
  await syncSet(synced);
  await localSet({ obsidianRestToken: next.obsidianRestToken || '' });
  return next;
}

async function getQueue() {
  const data = await localGet(['video_queue']);
  return Array.isArray(data.video_queue) ? data.video_queue : [];
}

async function setQueue(queue) {
  await localSet({ video_queue: queue });
  return queue;
}

async function addToQueue(rawItem) {
  const item = normalizeCaptureItem(rawItem);
  const queue = await getQueue();
  const existing = queue.find(
    (queued) =>
      U.cleanVideoUrl(queued.url, { keepTimestamp: false }) ===
      U.cleanVideoUrl(item.url, { keepTimestamp: false }),
  );
  if (!existing) {
    queue.push({ ...item, queuedAt: Date.now() });
    await setQueue(queue);
  }
  return { added: !existing, count: queue.length, item };
}

async function removeFromQueue(url) {
  const queue = await getQueue();
  const target = U.cleanVideoUrl(url, { keepTimestamp: false });
  const next = queue.filter(
    (item) => U.cleanVideoUrl(item.url, { keepTimestamp: false }) !== target,
  );
  await setQueue(next);
  return next;
}

async function clearQueue() {
  await setQueue([]);
  return [];
}

async function getHistory() {
  const data = await localGet(['capture_history']);
  return Array.isArray(data.capture_history) ? data.capture_history : [];
}

async function addHistory(entry) {
  const history = await getHistory();
  history.push({ ...entry, at: Date.now() });
  const next = history.slice(-HISTORY_LIMIT);
  await localSet({ capture_history: next });
  return next;
}

async function clearHistory() {
  await localSet({ capture_history: [] });
  return [];
}

function normalizeCaptureItem(item) {
  const title = U.cleanTitle(item?.title || 'Untitled Video');
  const url = U.cleanVideoUrl(item?.url || '', { keepTimestamp: true });
  const timestamp = Number.isFinite(item?.timestamp) ? Math.floor(item.timestamp) : null;
  const timestampUrl =
    timestamp !== null ? U.appendTimestamp(url, timestamp) : item?.timestampUrl || url;
  return {
    title,
    url,
    timestamp,
    timestampUrl,
    platform: U.detectPlatform(url),
    sourceTabUrl: item?.sourceTabUrl || '',
    source: item?.source || 'browser',
  };
}

async function getCurrentTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs[0] ? tabs[0] : null;
}

async function getTimestamp(tabId) {
  if (!tabId) return null;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const video = document.querySelector('video');
        return video ? Math.floor(video.currentTime) : null;
      },
    });
    const value = results && results[0] ? results[0].result : null;
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

async function getCurrentTabCapture() {
  const tab = await getCurrentTab();
  if (!tab || !tab.url) return null;
  const timestamp = await getTimestamp(tab.id);
  return normalizeCaptureItem({
    title: tab.title,
    url: timestamp !== null ? U.appendTimestamp(tab.url, timestamp) : tab.url,
    timestamp,
    sourceTabUrl: tab.url,
    source: 'current-tab',
  });
}

async function showToast(tabId, message) {
  if (!tabId) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (msg) => {
        const existing = document.getElementById('__obsidian_video_capture_toast');
        if (existing) existing.remove();
        const toast = document.createElement('div');
        toast.id = '__obsidian_video_capture_toast';
        toast.textContent = msg;
        Object.assign(toast.style, {
          position: 'fixed',
          left: '18px',
          bottom: '18px',
          zIndex: 2147483647,
          padding: '10px 12px',
          borderRadius: '8px',
          background: '#202124',
          color: '#f4f1ff',
          border: '1px solid #8f7cf7',
          boxShadow: '0 10px 28px rgba(0,0,0,.32)',
          font: '13px/1.4 -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif',
        });
        document.body.appendChild(toast);
        setTimeout(() => {
          toast.style.opacity = '0';
          toast.style.transition = 'opacity .2s ease';
          setTimeout(() => toast.remove(), 240);
        }, 1800);
      },
      args: [message],
    });
  } catch {
    // Some internal browser pages cannot be scripted.
  }
}

async function openObsidianUri(uri) {
  const tab = await getCurrentTab();
  if (!tab?.id) throw new Error('No active tab available for opening Obsidian URI.');
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (targetUri) => {
      const link = document.createElement('a');
      link.href = targetUri;
      document.body.appendChild(link);
      link.click();
      link.remove();
    },
    args: [uri],
  });
}

async function postJson(url, payload) {
  if (!url) throw new Error('Endpoint URL is not configured.');
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let body = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Plain text response is fine.
  }
  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`,
    );
  }
  return body;
}

async function getJson(url) {
  const response = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  const text = await response.text();
  let body = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Plain text response is fine.
  }
  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`,
    );
  }
  return body;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildJobStatusUrl(endpointUrl, job) {
  const endpoint = new URL(endpointUrl);
  if (job?.logsUrl && String(job.logsUrl).startsWith('/')) {
    const statusPath = String(job.logsUrl).replace(/\/logs$/, '');
    return `${endpoint.origin}${statusPath}`;
  }
  const base = endpoint.pathname.endsWith('/jobs')
    ? endpoint.pathname
    : endpoint.pathname.replace(/\/process-sync$/, '/jobs').replace(/\/$/, '');
  return `${endpoint.origin}${base}/${encodeURIComponent(job.id)}`;
}

async function waitForCodexJob(endpointUrl, initialJob, options = {}) {
  if (!initialJob?.id) return initialJob;
  const timeoutMs = options.timeoutMs || 90000;
  const intervalMs = options.intervalMs || 1000;
  const started = Date.now();
  const statusUrl = buildJobStatusUrl(endpointUrl, initialJob);
  let latest = initialJob;

  while (Date.now() - started < timeoutMs) {
    latest = await getJson(statusUrl);
    if (['success', 'error', 'needs-review', 'cancelled'].includes(latest?.status)) {
      return latest;
    }
    await wait(intervalMs);
  }

  return {
    ...latest,
    status: 'needs-review',
    error: latest?.error || { error: 'The Worker job is still running.' },
  };
}

async function putObsidianRestNote(settings, item) {
  if (!settings.obsidianRestToken) throw new Error('Obsidian REST token is not configured.');
  const protocol = settings.obsidianRestProtocol || 'https';
  const port = settings.obsidianRestPort || 27123;
  const title = U.sanitizeFilename(U.cleanTitle(item.title));
  const filePath = `${U.buildObsidianFilePath(settings.folder, title)}.md`;
  const url = `${protocol}://127.0.0.1:${port}/vault/${filePath.split('/').map(encodeURIComponent).join('/')}`;
  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${settings.obsidianRestToken}`,
      'Content-Type': 'text/markdown',
    },
    body: U.buildPendingNoteContent(item, settings),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Obsidian REST HTTP ${response.status}: ${text}`);
  return { filePath, response: text };
}

async function transferOne(rawItem, operation, settings) {
  const item = normalizeCaptureItem(rawItem);
  const actionForPayload = operation === 'append-link' ? 'append-link' : 'process';

  if (operation === 'create-pending-note') {
    if (!settings.vaultName) throw new Error('Vault name is required.');
    const uri = U.buildObsidianNewUri(settings.vaultName, settings.folder, item, settings);
    await openObsidianUri(uri);
    await addHistory({ operation, title: item.title, url: item.url, status: 'success' });
    return { operation, status: 'success', title: item.title };
  }
  if (operation === 'process-via-plugin') {
    if (!settings.vaultName) throw new Error('Vault name is required.');
    const uri = U.buildObsidianProcessUri(settings.vaultName, item, settings);
    await openObsidianUri(uri);
    await addHistory({ operation, title: item.title, url: item.url, status: 'success' });
    return { operation, status: 'success', title: item.title };
  }

  if (operation === 'create-pending-rest') {
    const response = await putObsidianRestNote(settings, item);
    await addHistory({ operation, title: item.title, url: item.url, status: 'success' });
    return { operation, status: 'success', title: item.title, response };
  }

  if (operation === 'append-link') {
    if (!settings.vaultName || !settings.appendPath) {
      throw new Error('Vault name and append file path are required.');
    }
    const uri = U.buildObsidianAppendUri(settings.vaultName, settings.appendPath, item);
    await openObsidianUri(uri);
    await addHistory({ operation, title: item.title, url: item.url, status: 'success' });
    return { operation, status: 'success', title: item.title };
  }

  if (operation === 'send-to-codex-worker') {
    const payload = U.buildUnifiedPayload(item, settings, actionForPayload);
    const response = await postJson(settings.codexWorkerUrl, payload);
    const finalJob = await waitForCodexJob(settings.codexWorkerUrl, response);
    const finalStatus =
      finalJob?.status === 'success'
        ? 'success'
        : finalJob?.status === 'needs-review'
          ? 'needs-review'
          : finalJob?.error
            ? 'error'
            : 'success';
    const errorMessage =
      typeof finalJob?.error === 'string'
        ? finalJob.error
        : finalJob?.error?.error || finalJob?.error?.message || '';
    await addHistory({
      operation,
      title: item.title,
      url: item.url,
      status: finalStatus,
      jobId: finalJob?.id || response?.id || '',
      jobStatus: finalJob?.status || '',
      error: errorMessage,
    });
    return {
      operation,
      status: finalStatus,
      title: item.title,
      response,
      job: finalJob,
      error: errorMessage,
    };
  }

  if (operation === 'send-to-n8n') {
    const payload =
      settings.webhookFormat === 'legacy'
        ? U.buildLegacyBridgePayload(item, settings, actionForPayload)
        : U.buildUnifiedPayload(item, settings, actionForPayload);
    const response = await postJson(settings.n8nWebhookUrl, payload);
    await addHistory({ operation, title: item.title, url: item.url, status: 'success' });
    return { operation, status: 'success', title: item.title, response };
  }

  throw new Error(`Unknown operation: ${operation}`);
}

async function transferMany(items, operation) {
  const settings = await getSettings();
  const results = [];
  for (const item of items) {
    try {
      results.push(await transferOne(item, operation, settings));
    } catch (error) {
      const normalized = normalizeCaptureItem(item);
      await addHistory({
        operation,
        title: normalized.title,
        url: normalized.url,
        status: 'error',
        error: error.message,
      });
      results.push({
        operation,
        status: 'error',
        title: normalized.title,
        error: error.message,
      });
    }
  }
  return results;
}

async function scanVideosInTab(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const videos = [];
      const seen = new Set();

      const normalizeCandidateUrl = (rawUrl) => {
        try {
          const u = new URL(rawUrl, location.href);
          let path = u.pathname.replace(/\/$/, '');
          if (
            u.hostname.includes('bilibili') &&
            u.searchParams.get('bvid') &&
            !/\/video\/BV/i.test(path)
          ) {
            path = `/video/${u.searchParams.get('bvid')}`;
          }
          const params = [];
          if (u.searchParams.has('v')) params.push(`v=${u.searchParams.get('v')}`);
          if (u.searchParams.has('p')) params.push(`p=${u.searchParams.get('p')}`);
          if (u.searchParams.has('t')) params.push(`t=${u.searchParams.get('t')}`);
          return `${u.origin}${path}${params.length ? `?${params.join('&')}` : ''}`;
        } catch {
          return '';
        }
      };

      const add = (rawTitle, rawUrl) => {
        const title = String(rawTitle || '')
          .replace(/\s+/g, ' ')
          .trim();
        const url = normalizeCandidateUrl(rawUrl);
        if (!title || !url || seen.has(url)) return;
        if (title.length < 2) return;
        if (/^\d{1,4}\s*(个视频|videos?)$/i.test(title)) return;
        if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(title)) return;
        if (/^[\d:./\s万]+$/.test(title)) return;
        seen.add(url);
        videos.push({ title, url, checked: true, source: 'page-scan' });
      };

      if (location.hostname.includes('youtube')) {
        document.querySelectorAll('#video-title, a#video-title-link').forEach((el) => {
          const title = el.textContent || el.getAttribute('title') || el.getAttribute('aria-label');
          const link = el.closest('a') || el.querySelector('a');
          if (link?.href?.includes('/watch')) add(title, link.href);
        });
        document.querySelectorAll("a[href*='/watch?v='], a[href*='youtu.be/']").forEach((a) => {
          const title = a.getAttribute('title') || a.textContent || a.getAttribute('aria-label');
          add(title, a.href);
        });
      } else if (location.hostname.includes('bilibili')) {
        const selectors = [
          '.bili-video-card__info--tit',
          'h3.title',
          '.video-card-reco .title',
          '.video-card-common .title',
        ];
        document.querySelectorAll(selectors.join(',')).forEach((el) => {
          const title = el.textContent || el.getAttribute('title');
          const link =
            el.closest('a') ||
            el
              .closest('.bili-video-card, .video-card-reco, .video-card-common')
              ?.querySelector("a[href*='/video/BV'], a[href*='bvid=']");
          if (link?.href) add(title, link.href);
        });
        document.querySelectorAll("a[href*='/video/BV'], a[href*='bvid=']").forEach((a) => {
          const img = a.querySelector('img');
          const title = a.getAttribute('title') || img?.alt || a.textContent;
          add(title, a.href);
        });
      } else {
        document.querySelectorAll('a[href]').forEach((a) => {
          const href = a.href || '';
          if (
            !/(youtube\.com\/watch|youtu\.be\/|bilibili\.com\/video\/|douyin\.com|tiktok\.com)/i.test(
              href,
            )
          )
            return;
          const title = a.getAttribute('title') || a.textContent || a.getAttribute('aria-label');
          add(title, href);
        });
      }

      return videos.slice(0, 80);
    },
  });
  const raw = results && results[0] ? results[0].result : [];
  return Array.isArray(raw) ? raw.map(normalizeCaptureItem) : [];
}

async function addSelectedLinkToQueue(tab) {
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const hovered = document.querySelector('a:hover');
      if (hovered?.href) {
        return { url: hovered.href, title: hovered.textContent || hovered.title || 'Linked Video' };
      }
      const active = document.activeElement;
      if (active?.tagName === 'A' && active.href) {
        return { url: active.href, title: active.textContent || active.title || 'Linked Video' };
      }
      const selection = window.getSelection();
      if (selection && selection.rangeCount > 0) {
        const anchor = selection.anchorNode;
        const element = anchor?.nodeType === Node.TEXT_NODE ? anchor.parentElement : anchor;
        const link = element?.closest ? element.closest('a') : null;
        if (link?.href)
          return { url: link.href, title: link.textContent || link.title || 'Linked Video' };
        const match = selection.toString().match(/https?:\/\/[^\s)]+/);
        if (match) return { url: match[0], title: 'Selected Link' };
      }
      return null;
    },
  });
  const found = results && results[0] ? results[0].result : null;
  if (!found?.url)
    return { added: false, count: (await getQueue()).length, error: 'No selected link found.' };
  return addToQueue({ ...found, source: 'selected-link', sourceTabUrl: tab.url });
}

async function copyTimestampMarkdown(tab) {
  const capture = await getCurrentTabCapture();
  if (!capture) throw new Error('No current tab to copy.');
  const text = U.buildMarkdownLink(capture);
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (value) => navigator.clipboard.writeText(value),
    args: [text],
  });
  await showToast(tab.id, 'Copied timestamp link');
  return text;
}

async function runQuickAction(tab) {
  const settings = await getSettings();
  const capture = await getCurrentTabCapture();
  if (!capture) throw new Error('No current tab to capture.');
  if (settings.quickAction === 'queue') {
    const result = await addToQueue(capture);
    await showToast(tab.id, result.added ? `Queued (${result.count})` : 'Already queued');
    return result;
  }
  const result = await transferOne(capture, settings.quickAction, settings);
  await showToast(tab.id, result.status === 'success' ? 'Sent' : 'Failed');
  return result;
}

async function createContextMenus() {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: 'capture-current',
    title: 'Obsidian Video: quick capture current page',
    contexts: ['page', 'video'],
  });
  chrome.contextMenus.create({
    id: 'append-current',
    title: 'Obsidian Video: append current page',
    contexts: ['page', 'video'],
  });
  chrome.contextMenus.create({
    id: 'queue-current',
    title: 'Obsidian Video: add current page to queue',
    contexts: ['page', 'video'],
  });
  chrome.contextMenus.create({
    id: 'queue-link',
    title: 'Obsidian Video: add link to queue',
    contexts: ['link'],
  });
  chrome.contextMenus.create({
    id: 'copy-timestamp',
    title: 'Obsidian Video: copy timestamp link',
    contexts: ['page', 'video'],
  });
}

chrome.runtime.onInstalled.addListener(() => {
  createContextMenus().catch(console.error);
});

chrome.runtime.onStartup.addListener(() => {
  createContextMenus().catch(console.error);
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  (async () => {
    if (!tab?.id) return;
    if (info.menuItemId === 'capture-current') {
      await runQuickAction(tab);
    } else if (info.menuItemId === 'append-current') {
      const capture = await getCurrentTabCapture();
      await transferMany([capture], 'append-link');
      await showToast(tab.id, 'Appended');
    } else if (info.menuItemId === 'queue-current') {
      const capture = await getCurrentTabCapture();
      const result = await addToQueue(capture);
      await showToast(tab.id, result.added ? `Queued (${result.count})` : 'Already queued');
    } else if (info.menuItemId === 'queue-link' && info.linkUrl) {
      const result = await addToQueue({
        title: 'Linked Video',
        url: info.linkUrl,
        source: 'context-link',
        sourceTabUrl: tab.url,
      });
      await showToast(tab.id, result.added ? `Queued (${result.count})` : 'Already queued');
    } else if (info.menuItemId === 'copy-timestamp') {
      await copyTimestampMarkdown(tab);
    }
  })().catch((error) => showToast(tab?.id, `Video capture failed: ${error.message}`));
});

chrome.commands.onCommand.addListener((command) => {
  (async () => {
    const tab = await getCurrentTab();
    if (!tab) return;
    if (command === 'capture_current_video') {
      await runQuickAction(tab);
    } else if (command === 'append_current_video') {
      const capture = await getCurrentTabCapture();
      await transferMany([capture], 'append-link');
      await showToast(tab.id, 'Appended');
    } else if (command === 'queue_current_video') {
      const capture = await getCurrentTabCapture();
      const result = await addToQueue(capture);
      await localSet({ target_tab: 'queue' });
      await showToast(tab.id, result.added ? `Queued (${result.count})` : 'Already queued');
      chrome.action.openPopup().catch(() => {});
    } else if (command === 'open_batch_view') {
      await localSet({ target_tab: 'batch' });
      chrome.action.openPopup().catch(() => {});
    } else if (command === 'copy_timestamp_link') {
      await copyTimestampMarkdown(tab);
    } else if (command === 'queue_selected_link') {
      const result = await addSelectedLinkToQueue(tab);
      await showToast(
        tab.id,
        result.added ? `Queued (${result.count})` : result.error || 'Already queued',
      );
    }
  })().catch((error) => console.error('[Obsidian Video Capture]', error));
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case 'GET_STATE': {
        sendResponse({
          ok: true,
          settings: await getSettings(),
          queue: await getQueue(),
          history: await getHistory(),
          current: await getCurrentTabCapture(),
          targetTab: (await localGet(['target_tab'])).target_tab || '',
        });
        await localSet({ target_tab: '' });
        return;
      }
      case 'SAVE_SETTINGS':
        sendResponse({ ok: true, settings: await setSettings(message.settings || {}) });
        return;
      case 'SCAN_CURRENT_PAGE': {
        const tab = await getCurrentTab();
        if (!tab?.id) throw new Error('No current tab.');
        sendResponse({ ok: true, items: await scanVideosInTab(tab.id) });
        return;
      }
      case 'TRANSFER_ITEMS':
        sendResponse({
          ok: true,
          results: await transferMany(message.items || [], message.operation),
        });
        return;
      case 'QUEUE_ADD':
        sendResponse({ ok: true, result: await addToQueue(message.item) });
        return;
      case 'QUEUE_ADD_MANY': {
        const results = [];
        for (const item of message.items || []) results.push(await addToQueue(item));
        sendResponse({ ok: true, results, queue: await getQueue() });
        return;
      }
      case 'QUEUE_REMOVE':
        sendResponse({ ok: true, queue: await removeFromQueue(message.url) });
        return;
      case 'QUEUE_CLEAR':
        sendResponse({ ok: true, queue: await clearQueue() });
        return;
      case 'HISTORY_CLEAR':
        sendResponse({ ok: true, history: await clearHistory() });
        return;
      case 'COPY_TIMESTAMP_LINK': {
        const tab = await getCurrentTab();
        if (!tab?.id) throw new Error('No current tab.');
        sendResponse({ ok: true, text: await copyTimestampMarkdown(tab) });
        return;
      }
      default:
        sendResponse({ ok: false, error: 'Unknown message type.' });
    }
  })().catch((error) => {
    sendResponse({ ok: false, error: error.message });
  });
  return true;
});
