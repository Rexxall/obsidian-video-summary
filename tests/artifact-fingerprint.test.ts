import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  buildArtifactFingerprint,
  buildLegacyCacheKey,
  legacyCacheFileStem,
  sha256Hex,
  stableSerialize,
} from '../core/ArtifactFingerprint';

const BASE_REQUEST = {
  mode: 'summary' as const,
  language: 'zh' as const,
  model: 'Gemini 3.1',
  backend: 'codex-worker' as const,
  schemaVersion: 1,
  processingDepth: 'evidence' as const,
  requestedContentType: 'auto' as const,
  autoRoute: true,
  visual: 'keyframes' as const,
  attention: true,
  learning: false,
  promptVersion: 'knowledge-v3.1',
};

void test('sha256Hex matches standard SHA-256 vectors and Unicode input', () => {
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(
    sha256Hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  const unicode = '视频总结\nEvidence 🧠';
  assert.equal(sha256Hex(unicode), createHash('sha256').update(unicode).digest('hex'));
});

void test('stableSerialize recursively sorts object keys but preserves array order', () => {
  const first = { z: 1, nested: { b: true, a: 'x' }, rows: [2, 1] };
  const reordered = { rows: [2, 1], nested: { a: 'x', b: true }, z: 1 };
  assert.equal(stableSerialize(first), stableSerialize(reordered));
  assert.notEqual(stableSerialize(first), stableSerialize({ ...first, rows: [1, 2] }));
});

void test('equivalent URL and transcript formatting produce the same fingerprint', () => {
  const first = buildArtifactFingerprint({
    ...BASE_REQUEST,
    input: {
      url: 'https://youtu.be/dQw4w9WgXcQ?t=42',
      transcript: 'first line  \r\nsecond line\r\n',
    },
  });
  const second = buildArtifactFingerprint({
    ...BASE_REQUEST,
    input: {
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      transcript: 'first line\nsecond line',
    },
  });
  assert.equal(first.key, second.key);
  assert.equal(first.source.source_hash, second.source.source_hash);
  assert.equal(first.legacy.compatibility, 'unsafe');
});

void test('every requested run dimension invalidates the fingerprint', () => {
  const base = buildArtifactFingerprint({
    ...BASE_REQUEST,
    input: { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
  });
  const variants = [
    { model: 'Gemini 3.2' },
    { backend: 'n8n' as const },
    { schemaVersion: 2 },
    { processingDepth: 'deep-visual' as const },
    { requestedContentType: 'course' as const },
    { autoRoute: false },
    { visual: 'deep' as const },
    { attention: false },
    { learning: true },
    { promptVersion: 'knowledge-v3.2' },
    { mode: 'transcript-only' as const },
    { language: 'ja' as const },
  ];
  for (const variant of variants) {
    const fingerprint = buildArtifactFingerprint({
      ...BASE_REQUEST,
      ...variant,
      input: { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
    });
    assert.notEqual(fingerprint.key, base.key, JSON.stringify(variant));
  }
});

void test('local source order and content hashes participate in identity', () => {
  const first = buildArtifactFingerprint({
    ...BASE_REQUEST,
    input: { localFiles: ['/tmp/a.mp4', '/tmp/b.mp4'] },
    localFileHashes: {
      '/tmp/a.mp4': 'a'.repeat(64),
      '/tmp/b.mp4': 'b'.repeat(64),
    },
  });
  const reordered = buildArtifactFingerprint({
    ...BASE_REQUEST,
    input: { localFiles: ['/tmp/b.mp4', '/tmp/a.mp4'] },
    localFileHashes: {
      '/tmp/a.mp4': 'a'.repeat(64),
      '/tmp/b.mp4': 'b'.repeat(64),
    },
  });
  const changed = buildArtifactFingerprint({
    ...BASE_REQUEST,
    input: { localFiles: ['/tmp/a.mp4', '/tmp/b.mp4'] },
    localFileHashes: {
      '/tmp/a.mp4': 'c'.repeat(64),
      '/tmp/b.mp4': 'b'.repeat(64),
    },
  });
  assert.notEqual(first.key, reordered.key);
  assert.notEqual(first.key, changed.key);
});

void test('legacy marker exposes exact historical keys without claiming exact reuse', () => {
  const rawUrl = 'https://youtu.be/dQw4w9WgXcQ?t=42';
  const fingerprint = buildArtifactFingerprint({
    ...BASE_REQUEST,
    input: { url: rawUrl },
  });
  const key = buildLegacyCacheKey(rawUrl, 'summary', 'zh');
  assert.equal(fingerprint.legacy.compatibility, 'lookup-candidate');
  assert.equal(fingerprint.legacy.reuse_requires_validation, true);
  assert.deepEqual(fingerprint.legacy.candidates[0], {
    key,
    file_stem: legacyCacheFileStem(key),
  });
  assert.equal(fingerprint.legacy.candidates.length, 2);
});

void test('requests without a source are rejected', () => {
  assert.throws(
    () => buildArtifactFingerprint({ ...BASE_REQUEST, input: {} }),
    /requires a URL, local file, or transcript/,
  );
});
