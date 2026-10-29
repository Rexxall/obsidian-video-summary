import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { VideoUtils } from '../utils/VideoUtils';

void test('collecting links from a note reads properties and body, once per video', () => {
  const note = [
    '---',
    'source: "https://www.youtube.com/watch?v=abc123"',
    '---',
    'Watch [this talk](https://www.youtube.com/watch?v=abc123&t=90s) and',
    'https://www.bilibili.com/video/BV1xx411c7mD?p=2,',
    'not a video: https://example.com/page',
  ].join('\n');
  const urls = VideoUtils.extractVideoUrls(note);
  assert.equal(urls.length, 2);
  assert.ok(urls[0].startsWith('https://www.youtube.com/watch?v=abc123'));
  assert.equal(urls[1], 'https://www.bilibili.com/video/BV1xx411c7mD?p=2');
});
