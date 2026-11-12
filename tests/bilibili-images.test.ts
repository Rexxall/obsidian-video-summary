import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { bilibiliRef, isBilibiliImage, parseSheetFrames } from '../core/BilibiliRef';

test('a Bilibili link gives its video and part', () => {
  assert.deepEqual(bilibiliRef('https://www.bilibili.com/video/BV1Jgf6YvE8e?p=19'), {
    bvid: 'BV1Jgf6YvE8e',
    part: 19,
  });
  assert.deepEqual(bilibiliRef('https://m.bilibili.com/video/BV1Jgf6YvE8e/'), {
    bvid: 'BV1Jgf6YvE8e',
    part: 1,
  });
  assert.equal(bilibiliRef('https://space.bilibili.com/123'), null);
  assert.equal(bilibiliRef('https://www.youtube.com/watch?v=x'), null);
  assert.equal(bilibiliRef(undefined), null);
});

test('frames from the extension are kept only as cuts of a Bilibili picture', () => {
  const good = {
    u: 'https://bimp.hdslb.com/videoshotpvhdboss/1_a-0001.jpg',
    x: 480,
    y: 270,
    w: 480,
    h: 270,
    t: 120,
  };
  assert.deepEqual(parseSheetFrames(JSON.stringify([good])), [good]);
  assert.deepEqual(
    parseSheetFrames(JSON.stringify([{ ...good, u: 'https://evil.example/a.jpg' }])),
    [],
  );
  assert.deepEqual(parseSheetFrames(JSON.stringify([{ ...good, w: 0 }])), []);
  assert.deepEqual(parseSheetFrames(JSON.stringify([{ ...good, x: 1.5 }])), []);
  assert.deepEqual(parseSheetFrames('not json'), []);
  assert.equal(parseSheetFrames(JSON.stringify(Array(9).fill(good))).length, 4);
  assert.equal(isBilibiliImage('http://i0.hdslb.com/bfs/archive/a.jpg'), true);
  assert.equal(isBilibiliImage('https://i0.hdslb.com.evil.com/a.jpg'), false);
});
