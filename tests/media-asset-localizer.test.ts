import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  MediaAssetLocalizer,
  mediaAssetRoot,
  type BinaryAssetAdapter,
} from '../core/MediaAssetLocalizer';
import type { ProcessingResult } from '../types';

class MemoryBinaryAdapter implements BinaryAssetAdapter {
  readonly directories = new Set<string>();
  readonly files = new Map<string, ArrayBuffer>();

  async exists(path: string): Promise<boolean> {
    return this.directories.has(path) || this.files.has(path);
  }

  async mkdir(path: string): Promise<void> {
    this.directories.add(path);
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.files.set(path, data.slice(0));
  }
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01, 0xff, 0xd9]).buffer;

void test('loopback keyframes are hash-checked, deduplicated, and stored as Vault-relative assets', async () => {
  const adapter = new MemoryBinaryAdapter();
  let fetches = 0;
  const localizer = new MediaAssetLocalizer(adapter, 'Video Notes/_video-summary-assets', {
    workerEndpoint: 'http://127.0.0.1:8787/video-summary/process-sync',
    fetchBinary: async () => {
      fetches += 1;
      return { data: JPEG, contentType: 'image/jpeg' };
    },
  });
  const shared = {
    id: 'frame-000012500',
    path: '/private/tmp/worker/frame-000012500.jpg',
    url: 'http://127.0.0.1:8787/video-summary/assets/visual-abc/frame-000012500.jpg',
    mime_type: 'image/jpeg',
  };
  const input: ProcessingResult = {
    video_segments: [
      {
        id: 'segment-1',
        start: 12.5,
        end: 13,
        text: '画面同步片段',
        source: 'screen',
        timing_quality: 'exact',
        keyframe: shared,
      },
    ],
    visual_evidence: [
      {
        id: 'visual-1',
        start: 12.5,
        description: '真实画面',
        keyframe: shared,
      },
    ],
  };

  const localized = await localizer.localizeResult(input, 'artifact-visual-test');
  const segmentPath = localized.result.video_segments?.[0].keyframe?.path;
  const visualPath = localized.result.visual_evidence?.[0].keyframe?.path;

  assert.equal(fetches, 1);
  assert.equal(localized.localized, 1);
  assert.equal(localized.warnings.length, 0);
  assert.equal(segmentPath, visualPath);
  assert.match(
    segmentPath || '',
    /^Video Notes\/_video-summary-assets\/artifact-visual-test\/frame-000012500-[a-f0-9]{20}\.jpg$/,
  );
  assert.equal(adapter.files.size, 1);
  assert.equal(input.visual_evidence?.[0].keyframe?.path, shared.path, 'input must not mutate');
});

void test('untrusted origins and digest mismatches remain remote with explicit warnings', async () => {
  const adapter = new MemoryBinaryAdapter();
  const localizer = new MediaAssetLocalizer(adapter, '_video-summary-assets', {
    workerEndpoint: 'http://127.0.0.1:8787/video-summary/process-sync',
    fetchBinary: async () => ({ data: JPEG, contentType: 'image/jpeg' }),
  });
  const result: ProcessingResult = {
    visual_evidence: [
      {
        id: 'visual-untrusted',
        start: 1,
        description: '外部图',
        keyframe: {
          id: 'external',
          url: 'https://example.com/frame.jpg',
        },
      },
      {
        id: 'visual-mismatch',
        start: 2,
        description: '哈希错误',
        keyframe: {
          id: 'mismatch',
          url: 'http://127.0.0.1:8787/video-summary/assets/visual-abc/frame-000002000.jpg',
          sha256: '0'.repeat(64),
        },
      },
    ],
  };

  const localized = await localizer.localizeResult(result, 'artifact-warning-test');

  assert.equal(localized.localized, 0);
  assert.equal(adapter.files.size, 0);
  assert.equal(
    localized.result.visual_evidence?.[0].keyframe?.url,
    'https://example.com/frame.jpg',
  );
  assert.ok(localized.warnings.some((warning) => warning.includes('untrusted_origin')));
  assert.ok(localized.warnings.some((warning) => warning.includes('sha256 mismatch')));
});

void test('asset fetches require the configured Worker origin and fixed asset path', async () => {
  const adapter = new MemoryBinaryAdapter();
  let fetches = 0;
  const localizer = new MediaAssetLocalizer(adapter, '_video-summary-assets', {
    workerEndpoint: 'http://127.0.0.1:8787/video-summary/process-sync',
    fetchBinary: async () => {
      fetches += 1;
      return { data: JPEG, contentType: 'image/jpeg' };
    },
  });
  const urls = [
    'http://127.0.0.1:8788/video-summary/assets/visual-abc/frame.jpg',
    'http://localhost:8787/video-summary/assets/visual-abc/frame.jpg',
    'http://127.0.0.1:8787/admin',
    'http://127.0.0.1:8787/video-summary/assets/visual-abc/frame.jpg?redirect=/admin',
    'http://127.0.0.1:8787/video-summary/assets/../admin/frame.jpg',
  ];
  const localized = await localizer.localizeResult(
    {
      visual_evidence: urls.map((url, index) => ({
        id: `visual-${index}`,
        start: index,
        description: '不应请求',
        keyframe: { id: `frame-${index}`, url },
      })),
    },
    'artifact-origin-test',
  );

  assert.equal(fetches, 0);
  assert.equal(localized.localized, 0);
  assert.equal(
    localized.warnings.filter((warning) => warning.includes('untrusted_origin')).length,
    urls.length,
  );
});

void test('media asset roots stay Vault-relative and reject traversal-shaped settings', () => {
  assert.equal(mediaAssetRoot('Video Notes'), 'Video Notes/_video-summary-assets');
  assert.equal(mediaAssetRoot(''), '_video-summary-assets');
  assert.equal(mediaAssetRoot('../outside'), '_video-summary-assets');
});

void test('pre-existing Vault paths must exist inside the managed asset root', async () => {
  const adapter = new MemoryBinaryAdapter();
  adapter.files.set('_video-summary-assets/artifact-existing/frame.jpg', JPEG);
  const localizer = new MediaAssetLocalizer(adapter, '_video-summary-assets');
  const localized = await localizer.localizeResult(
    {
      visual_evidence: [
        {
          id: 'outside',
          start: 1,
          description: 'Outside path',
          keyframe: { id: 'outside-frame', path: 'Private/secret.jpg' },
        },
        {
          id: 'missing',
          start: 2,
          description: 'Missing path',
          keyframe: {
            id: 'missing-frame',
            path: '_video-summary-assets/artifact-existing/missing.jpg',
          },
        },
        {
          id: 'existing',
          start: 3,
          description: 'Existing path',
          keyframe: {
            id: 'existing-frame',
            path: '_video-summary-assets/artifact-existing/frame.jpg',
          },
        },
      ],
    },
    'artifact-existing',
  );

  assert.equal(localized.result.visual_evidence?.[0].keyframe?.path, undefined);
  assert.equal(localized.result.visual_evidence?.[1].keyframe?.path, undefined);
  assert.equal(
    localized.result.visual_evidence?.[2].keyframe?.path,
    '_video-summary-assets/artifact-existing/frame.jpg',
  );
  assert.ok(localized.warnings.some((warning) => warning.includes('outside_managed_root')));
  assert.ok(localized.warnings.some((warning) => warning.includes('path_missing')));
});
