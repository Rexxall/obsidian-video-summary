import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const dir = new URL('../browser-extension/', import.meta.url);

function loadBackground({ sync = {}, local = {}, fetchImpl } = {}) {
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
