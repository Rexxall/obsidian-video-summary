import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ListedFiles } from 'obsidian';
import {
  createReproducibilityManifest,
  ReproducibilityManifest,
} from '../core/ReproducibilityManifest';
import {
  ReproducibilityManifestNotFoundError,
  ReproducibilityStore,
  ReproducibilityStoreAdapter,
  ReproducibilityStoreValidationError,
} from '../core/ReproducibilityStore';

const ROOT = '.obsidian/plugins/video-summary/data/reproducibility';

test('save/load/list persist versioned manifests across store restarts', async () => {
  const adapter = new MemoryAdapter();
  const firstStore = new ReproducibilityStore(adapter, ROOT);
  const older = await makeManifest('artifact-older', '2026-07-29T10:00:00.000Z');
  const newer = await makeManifest('artifact-newer', '2026-07-29T12:00:00.000Z');

  await firstStore.save(older);
  await firstStore.save(newer);
  older.model = 'mutated-after-save';

  const restarted = new ReproducibilityStore(adapter, ROOT);
  const loaded = await restarted.load('artifact-older');
  const listed = await restarted.list({ strict: true });

  assert.equal(loaded.schema_version, 1);
  assert.equal(loaded.model, 'fixture-model');
  assert.deepEqual(
    listed.map((manifest) => manifest.artifact_id),
    ['artifact-newer', 'artifact-older'],
  );
  assert.equal(await adapter.exists(`${ROOT}/artifact-older.json`), true);
  assert.equal(
    Array.from(adapter.files.keys()).some(
      (path) => path.includes('.tmp-') || path.endsWith('.bak'),
    ),
    false,
  );
});

test('save and load reject tampered raw snapshots instead of trusting stored hashes', async () => {
  const adapter = new MemoryAdapter();
  const store = new ReproducibilityStore(adapter, ROOT);
  const manifest = await makeManifest('artifact-integrity');
  const changedBeforeSave = structuredClone(manifest);
  changedBeforeSave.raw.transcript = 'Tampered before save';

  await assert.rejects(() => store.save(changedBeforeSave), /transcript_hash mismatch/);
  await store.save(manifest);

  const path = `${ROOT}/artifact-integrity.json`;
  const stored = JSON.parse(await adapter.read(path)) as ReproducibilityManifest;
  stored.raw.evidence_claims[0].claim = 'Tampered after save';
  await adapter.write(path, JSON.stringify(stored));

  await assert.rejects(() => store.load('artifact-integrity'), /evidence_hash mismatch/);
  assert.deepEqual(await store.list(), []);
  await assert.rejects(() => store.list({ strict: true }), /evidence_hash mismatch/);
});

test('safe ids, Vault-relative roots, filename identity, and missing files fail closed', async () => {
  const adapter = new MemoryAdapter();
  assert.throws(
    () => new ReproducibilityStore(adapter, '../outside'),
    ReproducibilityStoreValidationError,
  );
  assert.throws(
    () => new ReproducibilityStore(adapter, '/absolute/path'),
    ReproducibilityStoreValidationError,
  );

  const store = new ReproducibilityStore(adapter, ROOT);
  const manifest = await makeManifest('artifact-safe');
  await store.save(manifest);
  await assert.rejects(() => store.load('../artifact-safe'), ReproducibilityStoreValidationError);
  await assert.rejects(() => store.load('artifact-missing'), ReproducibilityManifestNotFoundError);

  await adapter.write(
    `${ROOT}/artifact-other.json`,
    JSON.stringify({ ...manifest, artifact_id: 'artifact-safe' }),
  );
  await assert.rejects(
    () => store.load('artifact-other'),
    /filename artifact_id artifact-other does not match manifest artifact-safe/,
  );
});

test('failed atomic updates preserve the previous valid manifest', async () => {
  const adapter = new MemoryAdapter();
  const store = new ReproducibilityStore(adapter, ROOT);
  const original = await makeManifest('artifact-atomic');
  await store.save(original);

  const changed = structuredClone(original);
  changed.model = 'replacement-model';
  adapter.failNextProcess = true;
  await assert.rejects(() => store.save(changed), /Injected process failure/);

  const recovered = await store.load('artifact-atomic');
  assert.equal(recovered.model, 'fixture-model');
});

async function makeManifest(
  artifactId: string,
  generatedAt = '2026-07-29T11:00:00.000Z',
): Promise<ReproducibilityManifest> {
  return createReproducibilityManifest({
    source: { url: `https://example.com/videos/${artifactId}` },
    artifact_id: artifactId,
    transcript: 'Stable transcript.',
    segments: [
      {
        id: 'segment-one',
        start: 4,
        end: 8,
        text: 'Stable transcript.',
        source: 'speech',
        timing_quality: 'exact',
      },
    ],
    evidence_claims: [
      {
        id: 'claim-one',
        claim: 'The transcript is stable.',
        evidence: [{ segment_id: 'segment-one', source: 'speech' }],
      },
    ],
    backend: 'codex-worker',
    model: 'fixture-model',
    prompt: 'fixture-prompt',
    version: 'fixture-v1',
    depth: 'evidence',
    generated_at: generatedAt,
  });
}

class MemoryAdapter implements ReproducibilityStoreAdapter {
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
    if (this.failNextProcess) {
      this.failNextProcess = false;
      throw new Error('Injected process failure');
    }
    const next = fn(await this.read(path));
    this.files.set(path, next);
    return next;
  }
}
