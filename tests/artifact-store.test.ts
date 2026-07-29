import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ListedFiles } from 'obsidian';
import {
  ArtifactNotFoundError,
  ArtifactStore,
  ArtifactStoreAdapter,
  ArtifactValidationError,
  VIDEO_KNOWLEDGE_ARTIFACT_SCHEMA_VERSION,
  migrateVideoKnowledgeArtifact,
  sha256Hex,
  stableArtifactId,
  stableSourceHash,
  validateVideoKnowledgeArtifact,
} from '../core/ArtifactStore';
import type { VideoKnowledgeArtifact } from '../types';

const FIXED_NOW = new Date('2026-07-29T12:00:00.000Z');

test('stable source hashes collapse equivalent YouTube URLs', async () => {
  const left = await stableSourceHash({
    url: 'https://youtu.be/dQw4w9WgXcQ?t=45',
    source_hash: '',
  });
  const right = await stableSourceHash({
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&utm_source=test',
    source_hash: '',
  });

  assert.equal(left, right);
  assert.equal(left.length, 64);
  assert.equal(stableArtifactId(left), `vka-${left.slice(0, 32)}`);
  assert.equal(
    await sha256Hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});

test('save/load/list use sidecar files and preserve a stable artifact id', async () => {
  const adapter = new MemoryAdapter();
  const store = new ArtifactStore(adapter, '.obsidian/plugins/video-summary/data/artifacts', {
    now: () => FIXED_NOW,
  });

  const saved = await store.save(makeArtifact());
  const loaded = await store.load(saved.artifact_id);
  const listed = await store.list({ strict: true });

  assert.equal(saved.artifact_id, loaded.artifact_id);
  assert.equal(saved.source.source_hash.length, 64);
  assert.equal(saved.provenance.artifact_id, saved.artifact_id);
  assert.equal(saved.provenance.source_hash, saved.source.source_hash);
  assert.equal(saved.provenance.transcript_hash?.length, 64);
  assert.deepEqual(
    listed.map((item) => item.artifact_id),
    [saved.artifact_id],
  );
  assert.equal(
    await adapter.exists(
      `.obsidian/plugins/video-summary/data/artifacts/${saved.artifact_id}.json`,
    ),
    true,
  );
  assert.equal(
    Array.from(adapter.files.keys()).some((path) => path.endsWith('/data.json')),
    false,
  );
});

test('updateHighlights is atomic, validates segment references, and supports transforms', async () => {
  const adapter = new MemoryAdapter();
  const store = new ArtifactStore(adapter, 'plugin-data/artifacts', {
    now: () => FIXED_NOW,
  });
  const saved = await store.save(makeArtifact());

  const updated = await store.updateHighlights(saved.artifact_id, (current) => [
    ...current,
    {
      id: 'highlight-one',
      segment_id: 'segment-one',
      note: '  My important point  ',
      created_at: '2026-07-29T11:00:00Z',
    },
  ]);

  assert.equal(updated.highlights.length, 1);
  assert.equal(updated.highlights[0].note, 'My important point');
  assert.equal(updated.updated_at, FIXED_NOW.toISOString());

  await assert.rejects(
    () =>
      store.updateHighlights(saved.artifact_id, [
        {
          id: 'highlight-bad',
          segment_id: 'missing-segment',
          created_at: FIXED_NOW.toISOString(),
        },
      ]),
    ArtifactValidationError,
  );
  assert.deepEqual((await store.load(saved.artifact_id)).highlights, updated.highlights);
});

test('v1 artifacts migrate to the current canonical id and sidecar path', async () => {
  const adapter = new MemoryAdapter();
  const root = 'plugin-data/artifacts';
  await adapter.mkdir('plugin-data');
  await adapter.mkdir(root);
  await adapter.write(
    `${root}/legacy-item.json`,
    JSON.stringify({
      schema_version: 1,
      id: 'legacy-item',
      source_url: 'https://www.bilibili.com/video/BV1xx411c7mD?p=2&spm_id_from=333',
      video_transcript: 'Legacy transcript',
      video_segments: [
        {
          id: 'legacy-segment',
          start: 0,
          text: 'Legacy transcript',
          source: 'speech',
          timing_quality: 'exact',
        },
      ],
      evidence_claims: [],
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    }),
  );
  const store = new ArtifactStore(adapter, root, { now: () => FIXED_NOW });

  const migrated = await store.load('legacy-item');

  assert.equal(migrated.schema_version, VIDEO_KNOWLEDGE_ARTIFACT_SCHEMA_VERSION);
  assert.match(migrated.artifact_id, /^vka-[a-f0-9]{32}$/);
  assert.equal(await adapter.exists(`${root}/legacy-item.json`), false);
  assert.equal(await adapter.exists(`${root}/${migrated.artifact_id}.json`), true);
  assert.equal(migrated.timing_quality, 'none');
});

test('validation rejects broken references and future schemas', async () => {
  const artifact = makeArtifact();
  artifact.highlights = [
    {
      id: 'broken',
      segment_id: 'not-there',
      created_at: FIXED_NOW.toISOString(),
    },
  ];
  assert.throws(() => validateVideoKnowledgeArtifact(artifact), ArtifactValidationError);

  await assert.rejects(
    () =>
      migrateVideoKnowledgeArtifact({
        schema_version: VIDEO_KNOWLEDGE_ARTIFACT_SCHEMA_VERSION + 1,
      }),
    ArtifactValidationError,
  );
});

test('failed atomic writes do not replace a valid existing artifact', async () => {
  const adapter = new MemoryAdapter();
  const store = new ArtifactStore(adapter, 'plugin-data/artifacts', {
    now: () => FIXED_NOW,
  });
  const saved = await store.save(makeArtifact());
  const before = await store.load(saved.artifact_id);

  adapter.failNextProcess = true;
  await assert.rejects(() => store.save({ ...before, title: 'Must not commit' }));

  assert.equal((await store.load(saved.artifact_id)).title, before.title);
});

test('missing artifacts fail explicitly', async () => {
  const store = new ArtifactStore(new MemoryAdapter(), 'plugin-data/artifacts');
  await assert.rejects(() => store.load('valid-missing-id'), ArtifactNotFoundError);
});

function makeArtifact(): VideoKnowledgeArtifact {
  return {
    schema_version: VIDEO_KNOWLEDGE_ARTIFACT_SCHEMA_VERSION,
    artifact_id: 'placeholder-artifact',
    source: {
      url: 'https://youtu.be/dQw4w9WgXcQ?t=20',
      note_path: 'Videos/Example.md',
      source_hash: 'deadbeef',
    },
    title: 'Example video',
    platform: 'youtube',
    timing_quality: 'exact',
    transcript: 'Hello from a timed segment.',
    segments: [
      {
        id: 'segment-one',
        start: 10,
        end: 15,
        text: 'Hello from a timed segment.',
        source: 'speech',
        timing_quality: 'exact',
      },
    ],
    claims: [
      {
        id: 'claim-one',
        claim: 'The speaker says hello.',
        evidence: [{ segment_id: 'segment-one', source: 'speech' }],
      },
    ],
    visual_evidence: [],
    related_notes: [],
    highlights: [],
    course_ids: [],
    provenance: {
      schema_version: VIDEO_KNOWLEDGE_ARTIFACT_SCHEMA_VERSION,
      source_hash: 'deadbeef',
      generated_at: '2026-07-29T10:00:00.000Z',
    },
    created_at: '2026-07-29T10:00:00.000Z',
    updated_at: '2026-07-29T10:00:00.000Z',
  };
}

class MemoryAdapter implements ArtifactStoreAdapter {
  readonly files = new Map<string, string>();
  readonly folders = new Set<string>();
  failNextProcess = false;

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.folders.has(path);
  }

  async list(path: string): Promise<ListedFiles> {
    const prefix = `${path.replace(/\/$/, '')}/`;
    return {
      files: Array.from(this.files.keys()).filter(
        (file) => file.startsWith(prefix) && !file.slice(prefix.length).includes('/'),
      ),
      folders: Array.from(this.folders).filter(
        (folder) => folder.startsWith(prefix) && !folder.slice(prefix.length).includes('/'),
      ),
    };
  }

  async read(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`Missing file: ${path}`);
    return value;
  }

  async write(path: string, data: string): Promise<void> {
    this.files.set(path, data);
  }

  async mkdir(path: string): Promise<void> {
    this.folders.add(path);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }

  async rename(path: string, newPath: string): Promise<void> {
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`Missing file: ${path}`);
    if (this.files.has(newPath)) throw new Error(`Target exists: ${newPath}`);
    this.files.set(newPath, value);
    this.files.delete(path);
  }

  async process(path: string, fn: (data: string) => string): Promise<string> {
    const current = await this.read(path);
    if (this.failNextProcess) {
      this.failNextProcess = false;
      throw new Error('Injected atomic process failure');
    }
    const next = fn(current);
    this.files.set(path, next);
    return next;
  }
}
