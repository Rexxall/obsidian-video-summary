import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { cookiesFromLoginUrl } from '../core/BilibiliCookies';

const NOW = 1_800_000_000;

test('the scan-login answer becomes a cookies.txt with the login cookies', () => {
  const url =
    'https://passport.biligame.com/x/passport-login/web/crossDomain?DedeUserID=123&DedeUserID__ckMd5=ab&Expires=1815000000&SESSDATA=fixture%2Cvalue&bili_jct=jct&gourl=https%3A%2F%2Fwww.bilibili.com';
  const text = cookiesFromLoginUrl(url, NOW);
  const lines = text.trim().split('\n');
  assert.equal(lines[0], '# Netscape HTTP Cookie File');
  assert.ok(
    lines.includes('#HttpOnly_.bilibili.com\tTRUE\t/\tTRUE\t1815000000\tSESSDATA\tfixture,value'),
  );
  assert.ok(lines.includes('.bilibili.com\tTRUE\t/\tFALSE\t1815000000\tbili_jct\tjct'));
  assert.ok(lines.some((line) => line.endsWith('\tDedeUserID\t123')));
  assert.ok(!text.includes('gourl'));
});

test('a login answer without SESSDATA gives nothing to upload', () => {
  assert.equal(cookiesFromLoginUrl('https://example.com/?bili_jct=x', NOW), '');
  assert.equal(cookiesFromLoginUrl('not a url', NOW), '');
});

test('a missing or past expiry falls back to 180 days', () => {
  const text = cookiesFromLoginUrl('https://x.bilibili.com/?SESSDATA=s&Expires=5', NOW);
  assert.match(text, new RegExp(`\\t${NOW + 180 * 24 * 60 * 60}\\tSESSDATA\\ts`));
});
