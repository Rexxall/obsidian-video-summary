import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildArtifactFingerprint, type ArtifactFingerprint } from '../core/ArtifactFingerprint';
import { CacheManager } from '../utils/CacheManager';

class MemoryAdapter {
  private readonly files = new Map<string, string>();
  private readonly directories = new Set<string>();

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.directories.has(path);
  }

  async mkdir(path: string): Promise<void> {
    this.directories.add(path);
  }

  async read(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`ENOENT: ${path}`);
    return value;
  }

  async write(path: string, value: string): Promise<void> {
    this.files.set(path, value);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
    this.directories.delete(path);
  }

  readFile(path: string): string {
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`ENOENT: ${path}`);
    return value;
  }

  writeFile(path: string, value: string): void {
    this.files.set(path, value);
  }
}

function fingerprint(
  overrides: Partial<Parameters<typeof buildArtifactFingerprint>[0]> = {},
): ArtifactFingerprint {
  return buildArtifactFingerprint({
    input: { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
    mode: 'summary',
    language: 'zh',
    model: 'Gemini 3.1',
    backend: 'n8n',
    schemaVersion: 3,
    processingDepth: 'evidence',
    requestedContentType: 'auto',
    autoRoute: true,
    visual: 'keyframes',
    attention: true,
    learning: false,
    promptVersion: 'video-knowledge-v3',
    ...overrides,
  });
}

function cacheWithAdapter(): { cache: CacheManager; adapter: MemoryAdapter } {
  const adapter = new MemoryAdapter();
  const vault = { configDir: '.obsidian', adapter };
  return {
    cache: new CacheManager(vault as never, '.obsidian/plugins/video-summary/data'),
    adapter,
  };
}

test('fingerprint cache writes, reads, and returns exact provenance', async () => {
  const { cache } = cacheWithAdapter();
  assert.equal(await cache.whenReady(), true);
  const identity = fingerprint();

  await cache.setByFingerprint(identity, { summary: 'exact result' }, identity.source.source_hash);

  assert.equal(cache.hasFingerprint(identity), true);
  const cached = await cache.getByFingerprint(identity);
  assert.equal(cached?.summary, 'exact result');
  assert.equal(cached?.artifact?.fingerprint, identity.key);
  assert.equal(cached?.artifact?.fingerprint_digest, identity.digest);
  assert.equal(cached?.artifact?.source_hash, identity.source.source_hash);
  assert.equal(cached?.artifact?.run_hash, identity.run_hash);

  const items = await cache.getAllItems();
  assert.equal(items.length, 1);
  assert.equal(items[0].scheme, 'fingerprint-v2');
  assert.equal(items[0].key, identity.key);
});

test('a changed processing dimension cannot reuse an existing cache artifact', async () => {
  const { cache } = cacheWithAdapter();
  await cache.whenReady();
  const original = fingerprint();
  const changed = fingerprint({ model: 'Gemini 3.2' });

  await cache.setByFingerprint(original, { summary: 'old model' });

  assert.notEqual(changed.key, original.key);
  assert.equal(cache.hasFingerprint(changed), false);
  assert.equal(await cache.getByFingerprint(changed), null);
  assert.equal((await cache.getByFingerprint(original))?.summary, 'old model');
});

test('legacy URL cache is never a silent fallback for a rich fingerprint lookup', async () => {
  const { cache } = cacheWithAdapter();
  await cache.whenReady();
  const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  const identity = fingerprint({ input: { url } });

  await cache.set(url, 'summary', 'zh', { summary: 'unverifiable legacy result' });

  // Explicit legacy preview remains backward compatible.
  assert.equal((await cache.get(url, 'summary', 'zh'))?.summary, 'unverifiable legacy result');
  // Processing lookup requires exact provenance and therefore refuses it.
  assert.equal(await cache.getByFingerprint(identity), null);
});

test('stored cache provenance is validated before reuse', async () => {
  const { cache, adapter } = cacheWithAdapter();
  await cache.whenReady();
  const identity = fingerprint();
  await cache.setByFingerprint(identity, { summary: 'will be tampered' });

  const indexPath = '.obsidian/plugins/video-summary/data/cache/index.json';
  const index = JSON.parse(adapter.readFile(indexPath)) as {
    items: Record<string, { path: string }>;
  };
  const itemPath = index.items[identity.key].path;
  const stored = JSON.parse(adapter.readFile(itemPath)) as {
    result: { artifact: { run_hash: string } };
  };
  stored.result.artifact.run_hash = 'not-the-requested-run';
  adapter.writeFile(itemPath, JSON.stringify(stored));

  assert.equal(await cache.getByFingerprint(identity), null);
});
