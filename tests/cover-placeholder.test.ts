import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { isPlaceholderCover } from '../core/CoverPlaceholder';

void test('YouTube 120x90 grey fallback counts as no cover', () => {
  assert.equal(isPlaceholderCover('https://i.ytimg.com/vi/x/mqdefault.jpg', 120, 90), true);
});

void test('real YouTube covers and other hosts are kept', () => {
  assert.equal(isPlaceholderCover('https://i.ytimg.com/vi/x/mqdefault.jpg', 320, 180), false);
  assert.equal(isPlaceholderCover('https://i0.hdslb.com/cover.jpg', 120, 90), false);
  assert.equal(isPlaceholderCover('not a url', 120, 90), false);
});
