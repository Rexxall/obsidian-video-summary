/* global chrome, importScripts -- Chrome extension APIs */
// Load the shared single-source core (vendored from @video-summary/shared) BEFORE utils.js,
// which delegates platform detection / URL canonicalization to self.VideoSummaryShared.
importScripts('vendor/shared.global.js', 'utils.js');

const U = self.VideoCaptureUtils;

/** A message in the browser's language; the English fallback covers tests and missing keys. */
function t(key, substitutions = [], fallback = key) {
  return chrome.i18n?.getMessage(key, substitutions) || fallback;
}

function queuedToast(result) {
  return result.added
    ? t('toastQueued', [String(result.count)], `Queued · ${result.count}`)
    : t('toastAlreadyQueued', [], 'Already in the queue');
}
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

// Tokens stay on this device; everything else syncs with the browser profile.
const LOCAL_ONLY_SETTINGS = ['obsidianRestToken', 'n8nToken', 'obsidianBridge'];

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
  // The local Codex Worker route was removed; send those captures to n8n instead.
  if (stored.quickAction === 'send-to-codex-worker') {
    stored.quickAction = 'send-to-n8n';
    await chrome.storage.sync.set({ quickAction: 'send-to-n8n' });
  }
  return { ...U.DEFAULT_SETTINGS, ...stored, ...local };
}

async function setSettings(settings) {
  const next = { ...U.DEFAULT_SETTINGS, ...settings };
  const synced = { ...next };
  for (const key of LOCAL_ONLY_SETTINGS) delete synced[key];
  await syncSet(synced);
  await localSet({
    obsidianRestToken: next.obsidianRestToken || '',
    n8nToken: next.n8nToken || '',
    obsidianBridge: next.obsidianBridge || '',
  });
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
    transcript: typeof item?.transcript === 'string' ? item.transcript : '',
    videoAuthor: typeof item?.videoAuthor === 'string' ? item.videoAuthor : '',
    videoDuration: typeof item?.videoDuration === 'string' ? item.videoDuration : '',
    videoCover: typeof item?.videoCover === 'string' ? item.videoCover : '',
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

/**
 * Runs in the YouTube page. Reads the captions the page's own player loaded: the
 * player's caption request carries the page's proof token, which a request from
 * anywhere else does not have, so the text is fetched again from the page with
 * that same request. When the person has captions off, the player is asked to load
 * the track and captions are switched off again afterwards. Nothing else is sent.
 */
async function readPlayerCaptions(videoId) {
  const started = Date.now();
  const player = document.querySelector('#movie_player');
  const response = player && player.getPlayerResponse ? player.getPlayerResponse() : null;
  if (!response || (response.videoDetails && response.videoDetails.videoId !== videoId)) {
    return { ok: false, reason: 'no-player' };
  }
  const renderer = response.captions && response.captions.playerCaptionsTracklistRenderer;
  const tracks = (renderer && renderer.captionTracks) || [];
  if (tracks.length === 0) return { ok: false, reason: 'no-captions' };
  // The spoken language: the automatic captions are always in it. A dubbed video has one
  // automatic track per dubbed language; then the player's mark for the original audio
  // decides. Without automatic captions the mark is all there is (it may follow the
  // viewer's language). Captions a person wrote in the spoken language come first.
  const base = (code) =>
    String(code || '')
      .toLowerCase()
      .split('-')[0];
  const automatic = tracks.filter((t) => t.kind === 'asr');
  const audio = (renderer.audioTracks || [])[renderer.defaultAudioTrackIndex || 0];
  const marked = audio ? tracks[audio.defaultCaptionTrackIndex] : undefined;
  // A dubbed video lists one automatic track per dub, the dubs first. The audio the
  // uploader recorded is marked as the default stream ("en-US.4"); its language picks
  // the automatic track, since the caption mark above is often missing.
  const original = ((response.streamingData && response.streamingData.adaptiveFormats) || [])
    .map((format) => format.audioTrack)
    .find((track) => track && track.audioIsDefault);
  const originalLanguage = base(
    ((original && original.id) || (audio && audio.audioTrackId) || '').split('.')[0],
  );
  const byOriginal = originalLanguage
    ? automatic.find((t) => base(t.languageCode) === originalLanguage)
    : undefined;
  const spoken = automatic.length === 1 ? automatic[0] : byOriginal || marked || automatic[0];
  const written = tracks.filter((t) => t.kind !== 'asr');
  const track =
    (spoken && written.find((t) => base(t.languageCode) === base(spoken.languageCode))) ||
    spoken ||
    written[0];
  const loaded = () =>
    performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter((name) => name.includes('/api/timedtext') && name.includes(`v=${videoId}`))
      // Some players sign the request with pot=, others with signature=; both work.
      .sort((a, b) => Number(a.includes('pot=')) - Number(b.includes('pot=')))
      .pop();
  let url = loaded();
  let switchedOn = false;
  let before = {};
  try {
    before = player.getOption('captions', 'track') || {};
  } catch {
    // Captions module not loaded yet: they were off.
  }
  const ask = async () => {
    try {
      player.loadModule('captions');
      // With the track already on, the player would not ask again: turn it off first.
      player.setOption('captions', 'track', {});
      await new Promise((resolve) => setTimeout(resolve, 150));
      player.setOption('captions', 'track', {
        languageCode: track.languageCode,
        ...(track.kind ? { kind: track.kind } : {}),
      });
      switchedOn = true;
    } catch {
      // An older player without this API: nothing to read.
    }
  };
  if (!url) {
    await ask();
    // A player that has only just started may ignore the first request; ask again every 2 s.
    for (let i = 1; i <= 40 && !url; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      url = loaded();
      if (!url && i % 8 === 0) await ask();
    }
  }
  const switchOff = () => {
    if (!switchedOn) return;
    try {
      // Leave the captions as the viewer had them.
      if (before.languageCode) player.setOption('captions', 'track', before);
      else {
        player.setOption('captions', 'track', {});
        player.unloadModule('captions');
      }
    } catch {
      // Leave the player as it is.
    }
  };
  if (!url) {
    switchOff();
    return { ok: false, reason: 'not-loaded', ms: Date.now() - started };
  }
  const fetchText = async (target) => {
    try {
      const reply = await fetch(target, { credentials: 'include' });
      return reply.ok ? await reply.text() : '';
    } catch {
      return '';
    }
  };
  const wanted = new URL(url);
  wanted.searchParams.set('fmt', 'json3');
  wanted.searchParams.delete('tlang');
  wanted.searchParams.set('lang', track.languageCode);
  if (track.kind) wanted.searchParams.set('kind', track.kind);
  else wanted.searchParams.delete('kind');
  let text = await fetchText(wanted.toString());
  if (!text) {
    // The loaded request as it was, in json3.
    const asLoaded = new URL(url);
    asLoaded.searchParams.set('fmt', 'json3');
    text = await fetchText(asLoaded.toString());
  }
  switchOff();
  const details = response.videoDetails || {};
  return text
    ? {
        ok: true,
        json3: text,
        lang: track.languageCode,
        kind: track.kind || '',
        author: details.author || '',
        lengthSeconds: Number(details.lengthSeconds) || 0,
        ms: Date.now() - started,
      }
    : { ok: false, reason: 'empty', ms: Date.now() - started };
}

function youTubeVideoId(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.endsWith('youtu.be')) return parsed.pathname.slice(1, 12) || null;
    if (!parsed.hostname.endsWith('youtube.com')) return null;
    if (parsed.pathname === '/watch') return parsed.searchParams.get('v');
    const match = parsed.pathname.match(/^\/(?:shorts|live)\/([^/?#]+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * The subtitles of the Bilibili video in this tab, read the way its player reads them: the
 * player API lists the tracks (AI subtitles only for a signed-in viewer), then the chosen
 * track's JSON. Runs in the page, so the page's own sign-in is used and nothing else is sent.
 * The cues come back in YouTube's json3 shape, so one formatter serves both.
 */
async function readBilibiliSubtitles() {
  const started = Date.now();
  const state = window.__INITIAL_STATE__ || {};
  const video = state.videoData || {};
  const pages = Array.isArray(video.pages) ? video.pages : [];
  const part = Number(new URLSearchParams(location.search).get('p')) || Number(state.p) || 1;
  const page = pages.find((item) => item.page === part) || pages[0] || {};
  const cid = page.cid || video.cid;
  if (!video.bvid || !cid) return { ok: false, reason: 'no-player' };
  const duration = Number(page.duration || video.duration) || 0;
  const machine = (track) => String(track.lan || '').startsWith('ai-');
  // The older player API (x/player/v2) now and then lists another video's subtitles; the
  // signed one does not. A track that runs well past the video's length is still put back.
  let body = [];
  let track = null;
  for (let attempt = 0; attempt < 3 && body.length === 0; attempt += 1) {
    let info;
    try {
      const reply = await fetch(
        `https://api.bilibili.com/x/player/wbi/v2?bvid=${encodeURIComponent(video.bvid)}&cid=${encodeURIComponent(cid)}`,
        { credentials: 'include' },
      );
      info = await reply.json();
    } catch {
      return { ok: false, reason: 'failed' };
    }
    const tracks = (info && info.data && info.data.subtitle && info.data.subtitle.subtitles) || [];
    if (tracks.length === 0) {
      return {
        ok: false,
        reason: info && info.data && info.data.login_mid ? 'no-captions' : 'signed-out',
      };
    }
    // Subtitles a person uploaded first, then the AI ones recognised from the audio
    // (ai_type 0), not the AI translations.
    track =
      tracks.find((item) => !machine(item)) ||
      tracks.find((item) => machine(item) && !item.ai_type) ||
      tracks[0];
    let url = String(track.subtitle_url || '');
    if (url.startsWith('//')) url = `https:${url}`;
    if (url.startsWith('http:')) url = `https:${url.slice(5)}`;
    try {
      const data = await (await fetch(url)).json();
      body = Array.isArray(data && data.body) ? data.body : [];
    } catch {
      return { ok: false, reason: 'failed' };
    }
    const last = body.length ? Number(body[body.length - 1].to) : 0;
    if (duration && last > duration + 15) body = [];
  }
  if (body.length === 0) return { ok: false, reason: 'empty' };
  const events = body.map((cue) => ({
    tStartMs: Math.round(Number(cue.from) * 1000),
    dDurationMs: Math.round((Number(cue.to) - Number(cue.from)) * 1000),
    segs: [{ utf8: String(cue.content || '') }],
  }));
  let cover = String(video.pic || '');
  if (cover.startsWith('//')) cover = `https:${cover}`;
  if (cover.startsWith('http:')) cover = `https:${cover.slice(5)}`;
  return {
    ok: true,
    json3: JSON.stringify({ events }),
    lang: String(track.lan || ''),
    kind: machine(track) ? 'asr' : '',
    author: (video.owner && video.owner.name) || '',
    lengthSeconds: duration,
    cover,
    ms: Date.now() - started,
  };
}

function bilibiliVideoId(url) {
  try {
    const parsed = new URL(url);
    if (!/(^|\.)bilibili\.com$/.test(parsed.hostname)) return null;
    const match = parsed.pathname.match(/^\/video\/(BV[0-9A-Za-z]+|av\d+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/** The transcript of the Bilibili video in this tab; '' when there is none. */
async function getBilibiliTranscript(tab) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: readBilibiliSubtitles,
    });
    const result = results && results[0] ? results[0].result : null;
    if (!result || !result.ok) return { transcript: '', reason: result?.reason || 'failed' };
    const transcript = U.captionTranscriptFromJson3(result.json3);
    const video = {
      videoAuthor: result.author || '',
      videoDuration: result.lengthSeconds ? U.durationString(result.lengthSeconds) : '',
      ...(result.cover ? { videoCover: result.cover } : {}),
    };
    return transcript
      ? { transcript, video, lang: result.lang, kind: result.kind, ms: result.ms }
      : { transcript: '', reason: 'empty' };
  } catch {
    return { transcript: '', reason: 'failed' };
  }
}

/** The transcript of the video in this tab (YouTube or Bilibili); '' when there is none. */
async function getPageTranscript(tab) {
  if (tab?.id && bilibiliVideoId(tab.url || '')) return getBilibiliTranscript(tab);
  return getYouTubeTranscript(tab);
}

/** The transcript of the YouTube video in this tab, from its player; '' when there is none. */
async function getYouTubeTranscript(tab) {
  const videoId = youTubeVideoId(tab?.url || '');
  if (!tab?.id || !videoId) return { transcript: '', reason: 'not-youtube' };
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: readPlayerCaptions,
      args: [videoId],
    });
    const result = results && results[0] ? results[0].result : null;
    if (!result || !result.ok) return { transcript: '', reason: result?.reason || 'failed' };
    const transcript = U.captionTranscriptFromJson3(result.json3);
    // What the backend would read with yt-dlp: uploader, duration_string, thumbnail.
    const video = {
      videoAuthor: result.author || '',
      videoDuration: result.lengthSeconds ? U.durationString(result.lengthSeconds) : '',
      videoCover: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
    };
    return transcript
      ? { transcript, video, lang: result.lang, kind: result.kind, ms: result.ms }
      : { transcript: '', reason: 'empty' };
  } catch {
    return { transcript: '', reason: 'failed' };
  }
}

/** Operations that put the video into Obsidian, where the captions can be used. */
const CAPTION_OPERATIONS = ['create-pending-note', 'process-via-plugin', 'create-pending-rest'];

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
        toast.setAttribute('role', 'status');
        toast.textContent = msg;
        const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        Object.assign(toast.style, {
          position: 'fixed',
          left: '50%',
          bottom: '28px',
          zIndex: 2147483647,
          maxWidth: 'min(420px, calc(100vw - 32px))',
          padding: '10px 18px',
          borderRadius: '999px',
          background: dark ? 'rgba(44,44,46,.92)' : 'rgba(255,255,255,.92)',
          color: dark ? '#f5f5f7' : '#1d1d1f',
          boxShadow: dark
            ? '0 0 0 .5px rgba(255,255,255,.14), 0 8px 28px rgba(0,0,0,.45)'
            : '0 0 0 .5px rgba(0,0,0,.12), 0 8px 28px rgba(0,0,0,.16)',
          backdropFilter: 'blur(20px) saturate(170%)',
          WebkitBackdropFilter: 'blur(20px) saturate(170%)',
          font: '500 13px/18px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
          letterSpacing: '0',
          textAlign: 'center',
          transform: 'translateX(-50%)',
          pointerEvents: 'none',
        });
        document.documentElement.appendChild(toast);
        const ease = 'cubic-bezier(0.16, 1, 0.3, 1)';
        if (!still) {
          toast.animate(
            [
              { opacity: 0, transform: 'translate(-50%, 8px) scale(.98)' },
              { opacity: 1, transform: 'translate(-50%, 0) scale(1)' },
            ],
            { duration: 180, easing: ease },
          );
        }
        window.setTimeout(() => {
          toast
            .animate([{ opacity: 1 }, { opacity: 0 }], {
              duration: still ? 1 : 180,
              easing: 'ease-out',
              fill: 'forwards',
            })
            .finished.then(() => toast.remove());
        }, 2000);
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

function backendHeaders(settings) {
  return settings.n8nToken ? { 'X-Video-Summary-Token': settings.n8nToken } : {};
}

async function postJson(url, payload, headers = {}) {
  if (!url)
    throw new Error(t('errNoEndpoint', [], 'Paste the backend connection code in Settings first.'));
  const response = await self.fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
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

async function putObsidianRestNote(settings, item) {
  if (!settings.obsidianRestToken)
    throw new Error(t('errRestToken', [], 'Enter the Obsidian REST token in Settings → Advanced.'));
  const protocol = settings.obsidianRestProtocol || 'https';
  const port = settings.obsidianRestPort || 27123;
  const title = U.sanitizeFilename(U.cleanTitle(item.title));
  const filePath = `${U.buildObsidianFilePath(settings.folder, title)}.md`;
  const url = `${protocol}://127.0.0.1:${port}/vault/${filePath.split('/').map(encodeURIComponent).join('/')}`;
  const response = await self.fetch(url, {
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

/**
 * Hand a video to the Obsidian plugin over 127.0.0.1, so Obsidian is not brought forward.
 * false when nothing answers (Obsidian closed, or an older plugin): then the link is used.
 */
async function sendToPluginInBackground(settings, item, { process }) {
  if (settings.sendInBackground === false) return false;
  const bridge = U.parseBridgeCode(settings.obsidianBridge);
  if (!bridge) return false;
  let response;
  try {
    response = await self.fetch(`http://127.0.0.1:${bridge.port}/video-summary/capture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Video-Summary-Token': bridge.token },
      body: JSON.stringify(Object.fromEntries(U.pluginCaptureParams(item, settings, { process }))),
    });
  } catch {
    return false;
  }
  if (response.status === 401) {
    throw new Error(
      t(
        'errBridgeCode',
        [],
        'The Obsidian pairing code does not match. Copy it again from Video Summary settings in Obsidian.',
      ),
    );
  }
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`Obsidian HTTP ${response.status}`);
  return true;
}

async function transferOne(rawItem, operation, settings) {
  const item = normalizeCaptureItem(rawItem);
  const actionForPayload = operation === 'append-link' ? 'append-link' : 'process';

  if (operation === 'create-pending-note' || operation === 'process-via-plugin') {
    const process = operation === 'process-via-plugin';
    if (await sendToPluginInBackground(settings, item, { process })) {
      await addHistory({ operation, title: item.title, url: item.url, status: 'success' });
      return { operation, status: 'success', title: item.title, background: true };
    }
  }
  if (operation === 'create-pending-note') {
    if (!settings.vaultName)
      throw new Error(t('errVaultRequired', [], 'Enter your vault name in Settings.'));
    const uri = U.buildObsidianNewUri(settings.vaultName, settings.folder, item, settings);
    await openObsidianUri(uri);
    await addHistory({ operation, title: item.title, url: item.url, status: 'success' });
    return { operation, status: 'success', title: item.title };
  }
  if (operation === 'process-via-plugin') {
    if (!settings.vaultName)
      throw new Error(t('errVaultRequired', [], 'Enter your vault name in Settings.'));
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
      throw new Error(
        t('errAppendRequired', [], 'Enter the vault name and the list file in Settings.'),
      );
    }
    const uri = U.buildObsidianAppendUri(settings.vaultName, settings.appendPath, item);
    await openObsidianUri(uri);
    await addHistory({ operation, title: item.title, url: item.url, status: 'success' });
    return { operation, status: 'success', title: item.title };
  }

  if (operation === 'send-to-n8n') {
    const payload =
      settings.webhookFormat === 'legacy'
        ? U.buildLegacyBridgePayload(item, settings, actionForPayload)
        : U.buildUnifiedPayload(item, settings, actionForPayload);
    const response = await postJson(settings.n8nWebhookUrl, payload, backendHeaders(settings));
    await addHistory({ operation, title: item.title, url: item.url, status: 'success' });
    return { operation, status: 'success', title: item.title, response };
  }

  throw new Error(`Unknown operation: ${operation}`);
}

const COOKIE_SITES = { bilibili: { domain: 'bilibili.com', login: 'SESSDATA' } };

/** Send this browser's login cookies for one site to the user's own backend, for yt-dlp. */
async function syncCookies(platform) {
  const site = COOKIE_SITES[platform];
  if (!site) throw new Error('Unsupported site.');
  const settings = await getSettings();
  if (!settings.n8nToken)
    throw new Error(
      t('errNoBackendCode', [], 'Paste the backend connection code in Settings and save first.'),
    );
  if (!chrome.cookies)
    throw new Error(
      t(
        'errNoCookiePerm',
        [],
        'Cookie access was not allowed. Press the button again and allow it.',
      ),
    );
  const cookies = await chrome.cookies.getAll({ domain: site.domain });
  if (!cookies.some((cookie) => cookie.name === site.login)) {
    throw new Error(
      t(
        'errNotLoggedIn',
        [site.domain],
        `This browser is not signed in to ${site.domain}. Sign in at ${site.domain}, then sync.`,
      ),
    );
  }
  const body = await postJson(
    settings.n8nWebhookUrl,
    { name: 'save-cookies', metadata: { platform, cookies: U.buildNetscapeCookies(cookies) } },
    backendHeaders(settings),
  );
  return { count: Number(body?.cookies) || cookies.length };
}

async function transferMany(items, operation) {
  const settings = await getSettings();
  const results = [];
  for (const original of items) {
    let item = original;
    try {
      // The popup's "current video" button: bring the captions of the page it came from.
      if (
        settings.sendCaptions !== false &&
        CAPTION_OPERATIONS.includes(operation) &&
        item?.source === 'current-tab' &&
        !item.transcript
      ) {
        const tab = await getCurrentTab();
        if (tab?.url && tab.url === item.sourceTabUrl) {
          const captions = await getPageTranscript(tab);
          if (captions.transcript) {
            item = { ...item, transcript: captions.transcript, ...captions.video };
          }
        }
      }
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
  await showToast(tab.id, t('toastCopied', [], 'Timestamped link copied'));
  return text;
}

async function runQuickAction(tab) {
  const settings = await getSettings();
  const capture = await getCurrentTabCapture();
  if (!capture) throw new Error('No current tab to capture.');
  if (settings.sendCaptions !== false && CAPTION_OPERATIONS.includes(settings.quickAction)) {
    const captions = await getPageTranscript(tab);
    if (captions.transcript)
      Object.assign(capture, { transcript: captions.transcript }, captions.video);
  }
  if (settings.quickAction === 'queue') {
    const result = await addToQueue(capture);
    await showToast(tab.id, queuedToast(result));
    return result;
  }
  const result = await transferOne(capture, settings.quickAction, settings);
  await showToast(
    tab.id,
    result.status !== 'success'
      ? t('toastFailed', [], 'Not sent. Open the extension to see why.')
      : capture.transcript
        ? t('toastSentCaptions', [], 'Sent with captions')
        : t('toastSent', [], 'Sent'),
  );
  return result;
}

async function createContextMenus() {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: 'capture-current',
    title: t('menuCapture', [], 'Quick capture current page'),
    contexts: ['page', 'video'],
  });
  chrome.contextMenus.create({
    id: 'append-current',
    title: t('menuAppend', [], 'Append current page'),
    contexts: ['page', 'video'],
  });
  chrome.contextMenus.create({
    id: 'queue-current',
    title: t('menuQueue', [], 'Add current page to queue'),
    contexts: ['page', 'video'],
  });
  chrome.contextMenus.create({
    id: 'queue-link',
    title: t('menuQueueLink', [], 'Add link to queue'),
    contexts: ['link'],
  });
  chrome.contextMenus.create({
    id: 'copy-timestamp',
    title: t('menuCopy', [], 'Copy timestamp link'),
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
      await showToast(tab.id, t('toastAppended', [], 'Appended to your list'));
    } else if (info.menuItemId === 'queue-current') {
      const capture = await getCurrentTabCapture();
      const result = await addToQueue(capture);
      await showToast(tab.id, queuedToast(result));
    } else if (info.menuItemId === 'queue-link' && info.linkUrl) {
      const result = await addToQueue({
        title: 'Linked Video',
        url: info.linkUrl,
        source: 'context-link',
        sourceTabUrl: tab.url,
      });
      await showToast(tab.id, queuedToast(result));
    } else if (info.menuItemId === 'copy-timestamp') {
      await copyTimestampMarkdown(tab);
    }
  })().catch((error) =>
    showToast(tab?.id, t('toastError', [error.message], `Video Summary Capture: ${error.message}`)),
  );
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
      await showToast(tab.id, t('toastAppended', [], 'Appended to your list'));
    } else if (command === 'queue_current_video') {
      const capture = await getCurrentTabCapture();
      const result = await addToQueue(capture);
      await localSet({ target_tab: 'queue' });
      await showToast(tab.id, queuedToast(result));
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
      case 'SYNC_COOKIES':
        sendResponse({ ok: true, result: await syncCookies(message.platform) });
        return;
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
