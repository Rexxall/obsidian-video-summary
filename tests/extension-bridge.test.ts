import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bridgePairingCode,
  decideBridgeRequest,
  parseBridgePairingCode,
} from '../core/ExtensionBridge';

const token = 'a'.repeat(48);
const capture = (extra: Partial<Parameters<typeof decideBridgeRequest>[0]> = {}) =>
  decideBridgeRequest(
    {
      method: 'POST',
      path: '/video-summary/capture',
      token,
      body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=x', process: '1' }),
      ...extra,
    },
    token,
    '9.9.9',
  );

test('the pairing code carries the port and the secret', () => {
  assert.deepEqual(parseBridgePairingCode(bridgePairingCode(27183, token)), {
    port: 27183,
    token,
  });
  assert.equal(parseBridgePairingCode('vsb1.27183.short'), null);
  assert.equal(parseBridgePairingCode('https://example.com'), null);
});

test('a capture with the secret from the extension is accepted with its fields', () => {
  const decision = capture({ origin: 'chrome-extension://abcdef' });
  assert.equal(decision.status, 202);
  assert.ok('params' in decision);
  assert.equal(decision.params.url, 'https://www.youtube.com/watch?v=x');
  assert.equal(decision.params.process, '1');
});

test('web pages and wrong secrets are turned away', () => {
  assert.equal(capture({ origin: 'https://evil.example' }).status, 403);
  assert.equal(capture({ token: 'b'.repeat(48) }).status, 401);
  assert.equal(capture({ token: undefined }).status, 401);
  assert.equal(decideBridgeRequest({ method: 'GET', path: '/x', token }, '', '1').status, 401);
});

test('malformed captures are rejected', () => {
  assert.equal(capture({ body: '{' }).status, 400);
  assert.equal(capture({ body: '[]' }).status, 400);
  assert.equal(capture({ body: '{"title":"no url"}' }).status, 400);
  assert.equal(capture({ method: 'GET' }).status, 405);
  assert.equal(capture({ path: '/other' }).status, 404);
});

test('ping answers only with the secret', () => {
  const ok = decideBridgeRequest(
    { method: 'GET', path: '/video-summary/ping', token },
    token,
    '2.0.0',
  );
  assert.equal(ok.status, 200);
  assert.equal(ok.body.version, '2.0.0');
});
