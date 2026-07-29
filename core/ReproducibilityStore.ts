import type { DataAdapter, ListedFiles } from 'obsidian';
import {
  restoreReprocessPayload,
  serializeReproducibilityManifest,
  validateManifestShape,
} from './ReproducibilityManifest';
import type { ReproducibilityManifest } from './ReproducibilityManifest';

const MANIFEST_FILE_SUFFIX = '.json';
const SAFE_ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/;

export type ReproducibilityStoreAdapter = Pick<
  DataAdapter,
  'exists' | 'list' | 'read' | 'write' | 'mkdir' | 'remove' | 'rename'
> & {
  process?: DataAdapter['process'];
};

export interface ReproducibilityListOptions {
  /**
   * By default one damaged sidecar does not hide the remaining manifests.
   * Strict mode fails on the first invalid filename or manifest.
   */
  strict?: boolean;
}

export class ReproducibilityManifestNotFoundError extends Error {
  constructor(artifactId: string) {
    super(`Reproducibility manifest not found: ${artifactId}`);
    this.name = 'ReproducibilityManifestNotFoundError';
  }
}

export class ReproducibilityStoreValidationError extends Error {
  constructor(message: string) {
    super(`Reproducibility store: ${message}`);
    this.name = 'ReproducibilityStoreValidationError';
  }
}

/**
 * Versioned local sidecars for raw-input reprocessing.
 *
 * Each manifest is addressed by artifact_id and is integrity-checked both
 * before it is written and after it is read. Existing files use
 * DataAdapter.process when available; adapters without process use a
 * same-directory temporary file and recoverable backup rename.
 */
export class ReproducibilityStore {
  private readonly adapter: ReproducibilityStoreAdapter;
  private readonly rootPath: string;
  private readonly locks = new Map<string, Promise<unknown>>();
  private tempSequence = 0;

  constructor(adapter: ReproducibilityStoreAdapter, rootPath: string) {
    this.adapter = adapter;
    this.rootPath = normalizeRootPath(rootPath);
  }

  async save(manifest: ReproducibilityManifest): Promise<ReproducibilityManifest> {
    assertArtifactId(manifest?.artifact_id);
    await verifyManifest(manifest);
    const serialized = serializeReproducibilityManifest(manifest);
    const path = this.pathFor(manifest.artifact_id);

    return this.withLock(path, async () => {
      await this.ensureRoot();
      await this.atomicWrite(path, serialized);
      return clone(manifest);
    });
  }

  async load(artifactId: string): Promise<ReproducibilityManifest> {
    assertArtifactId(artifactId);
    const path = this.pathFor(artifactId);
    if (!(await this.adapter.exists(path))) {
      throw new ReproducibilityManifestNotFoundError(artifactId);
    }

    return this.withLock(path, async () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await this.adapter.read(path));
      } catch (error) {
        throw new ReproducibilityStoreValidationError(
          `invalid JSON for ${artifactId} (${errorMessage(error)})`,
        );
      }

      const manifest = parsed as ReproducibilityManifest;
      await verifyManifest(manifest);
      if (manifest.artifact_id !== artifactId) {
        throw new ReproducibilityStoreValidationError(
          `filename artifact_id ${artifactId} does not match manifest ${String(
            manifest.artifact_id,
          )}`,
        );
      }
      return clone(manifest);
    });
  }

  async list(options: ReproducibilityListOptions = {}): Promise<ReproducibilityManifest[]> {
    if (!(await this.adapter.exists(this.rootPath))) return [];
    const listing = await this.adapter.list(this.rootPath);
    const candidates = manifestCandidates(listing, this.rootPath);
    const manifests: ReproducibilityManifest[] = [];

    for (const candidate of candidates) {
      if (!candidate.artifactId) {
        const error = new ReproducibilityStoreValidationError(
          `unsafe manifest filename ${candidate.path}`,
        );
        if (options.strict) throw error;
        console.warn('[ReproducibilityStore] skipped unsafe manifest filename', candidate.path);
        continue;
      }
      try {
        manifests.push(await this.load(candidate.artifactId));
      } catch (error) {
        if (options.strict) throw error;
        console.warn(
          `[ReproducibilityStore] skipped invalid manifest ${candidate.artifactId}`,
          error,
        );
      }
    }

    return manifests.sort((left, right) => {
      const byGeneratedAt = Date.parse(right.generated_at) - Date.parse(left.generated_at);
      return byGeneratedAt || left.artifact_id.localeCompare(right.artifact_id);
    });
  }

  private pathFor(artifactId: string): string {
    assertArtifactId(artifactId);
    return `${this.rootPath}/${artifactId}${MANIFEST_FILE_SUFFIX}`;
  }

  private async ensureRoot(): Promise<void> {
    const parts = this.rootPath.split('/');
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (await this.adapter.exists(current)) continue;
      try {
        await this.adapter.mkdir(current);
      } catch (error) {
        if (!(await this.adapter.exists(current))) throw error;
      }
    }
  }

  private async atomicWrite(path: string, data: string): Promise<void> {
    if (await this.adapter.exists(path)) {
      if (this.adapter.process) {
        await this.adapter.process(path, () => data);
        return;
      }
      await this.replaceWithRename(path, data);
      return;
    }

    const tempPath = this.tempPath(path);
    try {
      await this.adapter.write(tempPath, data);
      await this.adapter.rename(tempPath, path);
    } catch (error) {
      await this.removeIfExists(tempPath);
      // A second store instance may have created the same artifact meanwhile.
      if (await this.adapter.exists(path)) {
        if (this.adapter.process) {
          await this.adapter.process(path, () => data);
          return;
        }
        await this.replaceWithRename(path, data);
        return;
      }
      throw error;
    }
  }

  private async replaceWithRename(path: string, data: string): Promise<void> {
    const tempPath = this.tempPath(path);
    const backupPath = `${path}.bak`;
    await this.removeIfExists(tempPath);
    await this.removeIfExists(backupPath);
    await this.adapter.write(tempPath, data);
    let backedUp = false;

    try {
      if (await this.adapter.exists(path)) {
        await this.adapter.rename(path, backupPath);
        backedUp = true;
      }
      await this.adapter.rename(tempPath, path);
      if (backedUp) await this.removeIfExists(backupPath);
    } catch (error) {
      await this.removeIfExists(tempPath);
      if (
        backedUp &&
        !(await this.adapter.exists(path)) &&
        (await this.adapter.exists(backupPath))
      ) {
        await this.adapter.rename(backupPath, path);
      }
      throw error;
    }
  }

  private tempPath(path: string): string {
    this.tempSequence += 1;
    return `${path}.tmp-${Date.now().toString(36)}-${this.tempSequence.toString(36)}`;
  }

  private async removeIfExists(path: string): Promise<void> {
    if (await this.adapter.exists(path)) await this.adapter.remove(path);
  }

  private async withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) || Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.locks.set(key, current);
    try {
      return await current;
    } finally {
      if (this.locks.get(key) === current) this.locks.delete(key);
    }
  }
}

async function verifyManifest(manifest: ReproducibilityManifest): Promise<void> {
  validateManifestShape(manifest);
  // restoreReprocessPayload recomputes source/transcript/evidence hashes. The
  // returned payload is intentionally discarded; successful verification is
  // the store's write/read gate.
  await restoreReprocessPayload(manifest);
}

function manifestCandidates(
  listing: ListedFiles,
  rootPath: string,
): Array<{ path: string; artifactId?: string }> {
  const prefix = `${rootPath}/`;
  return listing.files
    .filter((path) => path.startsWith(prefix))
    .map((path) => ({ path, relative: path.slice(prefix.length) }))
    .filter(({ relative }) => !relative.includes('/') && relative.endsWith(MANIFEST_FILE_SUFFIX))
    .map(({ path, relative }) => {
      const artifactId = relative.slice(0, -MANIFEST_FILE_SUFFIX.length);
      return {
        path,
        artifactId: SAFE_ARTIFACT_ID.test(artifactId) ? artifactId : undefined,
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

function normalizeRootPath(value: string): string {
  const raw = String(value || '').trim();
  if (!raw) throw new ReproducibilityStoreValidationError('rootPath must not be empty');
  if (/^(?:\/|[A-Za-z]:[\\/])/.test(raw)) {
    throw new ReproducibilityStoreValidationError('rootPath must be Vault-relative');
  }
  const normalized = raw.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
  const parts = normalized.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.includes('\0'))) {
    throw new ReproducibilityStoreValidationError('rootPath contains an unsafe segment');
  }
  return parts.join('/');
}

function assertArtifactId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !SAFE_ARTIFACT_ID.test(value)) {
    throw new ReproducibilityStoreValidationError(`unsafe artifact_id ${JSON.stringify(value)}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
