import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const dir = new URL('../browser-extension/', import.meta.url);

function loadBackground({ sync = {}, local = {}, fetchImpl, cookies } = {}) {
  const listeners = {};
  const area = (store) => ({
    get: async (keys) =>
      Object.fromEntries(
        (Array.isArray(keys) ? keys : [keys]).filter((k) => k in store).map((k) => [k, store[k]]),
      ),
    set: async (value) => Object.assign(store, value),
    remove: async (keys) => {
      for (const k of [].concat(keys)) delete store[k];
    },
  });
  const event = (name) => ({
    addListener: (fn) => {
      listeners[name] = fn;
    },
  });
  const context = {
    console,
    URL,
    fetch: fetchImpl,
    chrome: {
      storage: { sync: area(sync), local: area(local) },
      runtime: {
        onMessage: event('message'),
        onInstalled: event('installed'),
        onStartup: event('startup'),
      },
      commands: { onCommand: event('command') },
      contextMenus: {
        create() {},
        removeAll(cb) {
          cb?.();
        },
        onClicked: event('menu'),
      },
      tabs: { query: async () => [], create: async () => ({}), update: async () => ({}) },
      action: { openPopup: async () => {} },
      scripting: { executeScript: async () => [] },
      ...(cookies ? { cookies: { getAll: async () => cookies } } : {}),
    },
  };
  context.self = context;
  context.importScripts = (...files) => {
    for (const file of files) vm.runInContext(readFileSync(new URL(file, dir), 'utf8'), context);
  };
  vm.createContext(context);
  vm.runInContext(readFileSync(new URL('background.js', dir), 'utf8'), context);
  const send = (message) => new Promise((resolve) => listeners.message(message, {}, resolve));
  return { send, sync, local };
}

test('extension shared bundle detects supported platforms', () => {
  const context = { console, URL };
  context.self = context;
  vm.createContext(context);
  vm.runInContext(readFileSync(new URL('vendor/shared.global.js', dir), 'utf8'), context);
  assert.equal(
    context.VideoSummaryShared.detectPlatform('https://www.youtube.com/watch?v=abc'),
    'youtube',
  );
  assert.equal(context.VideoSummaryShared.isVideoUrl('https://example.com/article'), false);
});

test('an Obsidian REST token saved by older versions moves out of synced storage', async () => {
  const { send, sync, local } = loadBackground({
    sync: { vaultName: 'V', obsidianRestToken: 'secret-token' },
  });
  const state = await send({ type: 'GET_STATE' });
  assert.equal(state.settings.obsidianRestToken, 'secret-token');
  assert.equal(local.obsidianRestToken, 'secret-token');
  assert.ok(!('obsidianRestToken' in sync));
});

test('saving settings keeps the token local', async () => {
  const { send, sync, local } = loadBackground();
  await send({ type: 'SAVE_SETTINGS', settings: { vaultName: 'V', obsidianRestToken: 't2' } });
  assert.ok(!('obsidianRestToken' in sync));
  assert.equal(local.obsidianRestToken, 't2');
  assert.equal(sync.vaultName, 'V');
});

test('REST notes in a subfolder keep their slashes in the URL', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    return { ok: true, status: 204, text: async () => '' };
  };
  const { send } = loadBackground({
    sync: { vaultName: 'V', folder: 'Videos/Inbox' },
    local: { obsidianRestToken: 't' },
    fetchImpl,
  });
  await send({
    type: 'TRANSFER_ITEMS',
    operation: 'create-pending-rest',
    items: [{ url: 'https://www.youtube.com/watch?v=abc', title: 'A talk?' }],
  });
  assert.equal(urls.length, 1);
  assert.match(urls[0], /\/vault\/Videos\/Inbox\/A%20talk_\.md$/);
});

const TOKEN = 'c'.repeat(48);

test('the backend connection code sets address and token, and the token stays local', async () => {
  const { send, sync, local } = loadBackground();
  const context = { console, URL, URLSearchParams };
  context.self = context;
  vm.createContext(context);
  vm.runInContext(readFileSync(new URL('vendor/shared.global.js', dir), 'utf8'), context);
  vm.runInContext(readFileSync(new URL('utils.js', dir), 'utf8'), context);
  const U = context.VideoCaptureUtils;
  const code = U.parseConnectionCode(
    `http://127.0.0.1:5690/webhook/obsidian-video-summary#token=${TOKEN}`,
  );
  assert.equal(code.url, 'http://127.0.0.1:5690/webhook/obsidian-video-summary');
  assert.equal(code.token, TOKEN);
  assert.equal(U.parseConnectionCode('http://127.0.0.1:5678/webhook/x#token=short'), null);

  await send({
    type: 'SAVE_SETTINGS',
    settings: { n8nWebhookUrl: code.url, n8nToken: code.token },
  });
  assert.equal(local.n8nToken, TOKEN);
  assert.ok(!('n8nToken' in sync));
  assert.equal(sync.n8nWebhookUrl, code.url);
});

test('syncing Bilibili login posts a cookies.txt to the backend with the token header', async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), init });
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, cookies: 2 }) };
  };
  const { send } = loadBackground({
    sync: { n8nWebhookUrl: 'http://127.0.0.1:5690/webhook/obsidian-video-summary' },
    local: { n8nToken: TOKEN },
    fetchImpl,
    cookies: [
      {
        domain: '.bilibili.com',
        hostOnly: false,
        path: '/',
        secure: true,
        httpOnly: true,
        expirationDate: 1893456000.5,
        name: 'SESSDATA',
        value: 'fixture',
      },
      { domain: 'www.bilibili.com', hostOnly: true, path: '/', name: 'buvid3', value: 'v' },
    ],
  });
  const response = await send({ type: 'SYNC_COOKIES', platform: 'bilibili' });
  assert.equal(response.ok, true);
  assert.equal(response.result.count, 2);
  const [request] = requests;
  assert.equal(request.url, 'http://127.0.0.1:5690/webhook/obsidian-video-summary');
  assert.equal(request.init.headers['X-Video-Summary-Token'], TOKEN);
  const body = JSON.parse(request.init.body);
  assert.equal(body.name, 'save-cookies');
  assert.equal(body.metadata.platform, 'bilibili');
  assert.match(
    body.metadata.cookies,
    /^# Netscape HTTP Cookie File\n#HttpOnly_\.bilibili\.com\tTRUE\t\/\tTRUE\t1893456000\tSESSDATA\tfixture\nwww\.bilibili\.com\tFALSE\t\/\tFALSE\t0\tbuvid3\tv\n$/,
  );
});

test('syncing without a Bilibili login explains what to do', async () => {
  const { send } = loadBackground({
    local: { n8nToken: TOKEN },
    fetchImpl: async () => assert.fail('must not post'),
    cookies: [{ domain: '.bilibili.com', name: 'buvid3', value: 'v' }],
  });
  const response = await send({ type: 'SYNC_COOKIES', platform: 'bilibili' });
  assert.equal(response.ok, false);
  assert.match(response.error, /还没有登录/);
});

function loadUtils() {
  const context = { console, URL, URLSearchParams };
  context.self = context;
  vm.createContext(context);
  vm.runInContext(readFileSync(new URL('vendor/shared.global.js', dir), 'utf8'), context);
  vm.runInContext(readFileSync(new URL('utils.js', dir), 'utf8'), context);
  return context.VideoCaptureUtils;
}

const fixture = (name) =>
  readFileSync(new URL(`../tests/fixtures/lite/${name}`, import.meta.url), 'utf8');

test('YouTube json3 captions become timed passages, without scroll repeats', () => {
  const U = loadUtils();
  const lines = U.captionTranscriptFromJson3(fixture('captions-auto.json3')).split('\n');
  assert.deepEqual(lines, [
    "[00:01] we're no strangers to love you know the rules & so do I",
    "[00:25] a full commitment's what I'm thinking of",
  ]);
});

test('Japanese captions join without spaces and break at a sentence after 8 seconds', () => {
  const U = loadUtils();
  assert.equal(
    U.captionTranscriptFromJson3(fixture('captions-ja.json3')),
    '[00:00] こんにちは。\n[00:09] 今日は字幕の話をします。まず仕組みから。',
  );
  assert.equal(U.captionTranscriptFromJson3('not json'), '');
  assert.equal(U.captionTranscriptFromJson3('{"events":[]}'), '');
});

test('captions travel with the link: as a link parameter and as note frontmatter', async () => {
  const U = loadUtils();
  const { parse } = await import('yaml');
  const transcript = '[00:01] first line: with a colon\n[00:25] "quoted" # not a comment';
  const item = { title: 'Video', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', transcript };
  const uri = U.buildObsidianProcessUri('Vault', item, { defaultMode: 'summary' });
  assert.equal(new URL(uri).searchParams.get('transcript'), transcript);
  const note = U.buildPendingNoteContent(item, { quickAction: 'create-pending-note' });
  const frontmatter = parse(note.split('---\n')[1]);
  assert.equal(frontmatter.provided_transcript, transcript);
  const plain = U.buildPendingNoteContent({ ...item, transcript: '' }, {});
  assert.equal(plain.includes('provided_transcript'), false);
});

/** Runs the page-side caption reader against a fake YouTube player. */
async function readWithPlayer(response, { loadedLang } = {}) {
  const source = readFileSync(new URL('background.js', dir), 'utf8');
  const start = source.indexOf('async function readPlayerCaptions');
  const end = source.indexOf('\nfunction youTubeVideoId');
  const entries = [];
  const calls = [];
  const fetched = [];
  const player = {
    getPlayerResponse: () => response,
    loadModule: (name) => calls.push(['loadModule', name]),
    unloadModule: (name) => calls.push(['unloadModule', name]),
    setOption: (module, option, value) => {
      calls.push(['setOption', JSON.stringify(value)]);
      // The player fetches the chosen track with its proof token.
      if (value.languageCode) {
        entries.push({
          name: `https://www.youtube.com/api/timedtext?v=vid00000001&lang=${loadedLang || value.languageCode}&pot=TOKEN&fmt=srv3`,
        });
      }
    },
  };
  const context = {
    URL,
    document: { querySelector: () => player },
    performance: { getEntriesByType: () => entries },
    setTimeout: (fn) => setTimeout(fn, 0),
    fetch: async (url) => {
      fetched.push(url);
      return { ok: true, text: async () => '{"events":[{"tStartMs":0,"segs":[{"utf8":"hi"}]}]}' };
    },
  };
  vm.createContext(context);
  vm.runInContext(`${source.slice(start, end)}; this.read = readPlayerCaptions;`, context);
  const result = await context.read('vid00000001');
  return { result, calls, fetched };
}

const track = (languageCode, kind) => ({
  languageCode,
  ...(kind ? { kind } : {}),
  baseUrl: `https://www.youtube.com/api/timedtext?lang=${languageCode}&exp=xpe`,
});

test('the caption reader picks the spoken language, not the viewer’s', async () => {
  const response = (tracks, audioTracks, defaultAudioTrackIndex = 0) => ({
    videoDetails: { videoId: 'vid00000001' },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: tracks,
        audioTracks,
        defaultAudioTrackIndex,
      },
    },
  });
  // A written English track beats a Chinese translation the player recommends to a Chinese viewer.
  const en = await readWithPlayer(
    response([track('zh'), track('en'), track('en', 'asr')], [{ defaultCaptionTrackIndex: 0 }]),
  );
  assert.equal(en.result.lang, 'en');
  assert.equal(en.result.kind, '');
  // Dubbed: one automatic track per dub; the mark for the original audio decides.
  const dubbed = await readWithPlayer(
    response(
      [track('pl', 'asr'), track('ja', 'asr'), track('en', 'asr')],
      [{ defaultCaptionTrackIndex: 2 }, { defaultCaptionTrackIndex: 2 }],
      1,
    ),
  );
  assert.equal(dubbed.result.lang, 'en');
  assert.equal(dubbed.result.kind, 'asr');
  // No automatic captions: the marked track.
  const marked = await readWithPlayer(
    response([track('de'), track('en')], [{ defaultCaptionTrackIndex: 1 }]),
  );
  assert.equal(marked.result.lang, 'en');
  const none = await readWithPlayer(response([], []));
  assert.deepEqual({ ...none.result }, { ok: false, reason: 'no-captions' });
});

test('the reader asks the page’s player for the track, refetches it as json3 and switches captions off again', async () => {
  const { result, calls, fetched } = await readWithPlayer({
    videoDetails: { videoId: 'vid00000001' },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: [track('ja', 'asr')] } },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls[0], ['loadModule', 'captions']);
  assert.deepEqual(calls.at(-1), ['unloadModule', 'captions']);
  const url = new URL(fetched[0]);
  assert.equal(url.searchParams.get('fmt'), 'json3');
  assert.equal(url.searchParams.get('pot'), 'TOKEN');
  assert.equal(url.searchParams.get('kind'), 'asr');
  // Another video's player response is never read.
  const other = await readWithPlayer({ videoDetails: { videoId: 'different01' } });
  assert.equal(other.result.reason, 'no-player');
});
