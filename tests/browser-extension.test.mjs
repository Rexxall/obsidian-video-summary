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
