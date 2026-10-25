
import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  isExactHostOrSubdomain,
  safeExternalHttpUrl,
  safeInlineRasterDataUrl,
  safeManagedVaultImagePath,
  safeRemoteImageUrl,
  safeVaultRelativeMediaPath,
} from '../utils/SafeExternalUrl';
import { buildTimestampUrl } from '../core/KnowledgeModel';

test('external links accept only credential-free HTTP(S) URLs', () => {
  assert.equal(
    safeExternalHttpUrl('https://example.com/watch?v=1'),
    'https://example.com/watch?v=1',
  );
  assert.equal(
    safeExternalHttpUrl('http://127.0.0.1:8787/dashboard'),
    'http://127.0.0.1:8787/dashboard',
  );
  for (const unsafe of [
    'javascript:alert(1)',
    'data:text/html,boom',
    'file:///etc/passwd',
    'https://user:secret@example.com/',
    'https://example.com/\nmalformed',
    'not a url',
  ]) {
    assert.equal(safeExternalHttpUrl(unsafe), undefined, unsafe);
  }
});

test('video timestamp links require an exact supported HTTP(S) host', () => {
  assert.match(buildTimestampUrl('https://www.youtube.com/watch?v=abc', 12) || '', /t=12s/);
  assert.equal(buildTimestampUrl('https://youtube.com.evil.test/watch?v=abc', 12), undefined);
  assert.equal(buildTimestampUrl('ftp://youtube.com/watch?v=abc', 12), undefined);
  assert.equal(isExactHostOrSubdomain('player.bilibili.com', 'bilibili.com'), true);
  assert.equal(isExactHostOrSubdomain('bilibili.com.evil.test', 'bilibili.com'), false);
});

test('inline images require a trusted HTTPS media origin or bounded raster data', () => {
  assert.equal(
    safeRemoteImageUrl('https://i.ytimg.com/vi/abc123/hqdefault.jpg'),
    'https://i.ytimg.com/vi/abc123/hqdefault.jpg',
  );
  assert.equal(
    safeRemoteImageUrl('https://sns-webpic-qc.xhscdn.com/example.webp'),
    'https://sns-webpic-qc.xhscdn.com/example.webp',
  );
  for (const unsafe of [
    'http://i.ytimg.com/cover.jpg',
    'https://127.0.0.1:8787/private.png',
    'https://localhost/private.png',
    'https://example.com/backend-controlled.png',
    'https://ytimg.com.evil.test/cover.jpg',
    'data:image/svg+xml,<svg onload=alert(1)>',
  ]) {
    assert.equal(safeRemoteImageUrl(unsafe), undefined, unsafe);
  }

  assert.equal(
    safeInlineRasterDataUrl('data:image/png;base64,iVBORw0KGgo='),
    'data:image/png;base64,iVBORw0KGgo=',
  );
  assert.equal(safeInlineRasterDataUrl('data:image/svg+xml;base64,PHN2Zz4='), undefined);

  assert.equal(
    safeManagedVaultImagePath(
      '课程/_video-summary-assets/artifact-001/frame-001.jpg',
      '课程/_video-summary-assets',
    ),
    '课程/_video-summary-assets/artifact-001/frame-001.jpg',
  );
  for (const unsafePath of [
    '/private/tmp/frame.jpg',
    '../_video-summary-assets/frame.jpg',
    '_video-summary-assets/artifact/nested/frame.jpg',
    '_video-summary-assets/frame.svg',
    '_video-summary-assets/frame.jpg]] ![x](https://example.com/x)',
  ]) {
    assert.equal(
      safeManagedVaultImagePath(unsafePath, '课程/_video-summary-assets'),
      undefined,
      unsafePath,
    );
  }
  assert.equal(
    safeManagedVaultImagePath(
      '别处/_video-summary-assets/artifact-001/frame-001.jpg',
      '课程/_video-summary-assets',
    ),
    undefined,
  );

  assert.equal(safeVaultRelativeMediaPath('Media/Lesson 01.mp4'), 'Media/Lesson 01.mp4');
  for (const unsafeMedia of [
    '/Users/example/private.mp4',
    'C:\\Users\\example\\private.mp4',
    'http://127.0.0.1:8787/private.mp4',
    'https://example.com/tracker.mp4',
    'file:///etc/passwd',
    'app://local/private.mp4',
    '../private.mp4',
  ]) {
    assert.equal(safeVaultRelativeMediaPath(unsafeMedia), undefined, unsafeMedia);
  }
});
