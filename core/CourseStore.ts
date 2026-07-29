import type {
  PlaylistInfo,
  PlaylistPlatform,
  PlaylistSourceType,
} from '../utils/PlaylistProcessor';

export const COURSE_MANIFEST_SCHEMA_VERSION = 1;

export type CourseProgressStatus = 'pending' | 'queued' | 'processing' | 'complete' | 'error';

export interface CourseItemProgress {
  status: CourseProgressStatus;
  percent: number;
  note_path?: string;
  artifact_id?: string;
  updated_at: string;
}

export interface CourseManifestItem {
  item_id: string;
  platform: PlaylistPlatform;
  video_id: string;
  canonical_key: string;
  canonical_url: string;
  title: string;
  author: string;
  duration?: string;
  original_position: number;
  recommended_position: number;
  prerequisites: string[];
  progress: CourseItemProgress;
  duplicate_of?: string;
  missing_concepts: string[];
  removed_from_source: boolean;
}

export interface CourseDuplicate {
  canonical_key: string;
  kept_position: number;
  duplicate_positions: number[];
}

export interface CourseManifest {
  schema_version: typeof COURSE_MANIFEST_SCHEMA_VERSION;
  course_id: string;
  source: {
    platform: PlaylistPlatform;
    source_type: PlaylistSourceType;
    source_id: string;
    canonical_url: string;
    original_url: string;
  };
  title: string;
  description?: string;
  created_at: string;
  updated_at: string;
  import_count: number;
  index_note_path?: string;
  original_order: string[];
  recommended_order: string[];
  prerequisite_dependencies: Record<string, string[]>;
  progress: {
    pending: number;
    queued: number;
    processing: number;
    complete: number;
    error: number;
    removed: number;
  };
  duplicates: CourseDuplicate[];
  missing_concepts: string[];
  items: CourseManifestItem[];
}

export interface CourseStoreAdapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  rename(oldPath: string, newPath: string): Promise<void>;
  remove(path: string): Promise<void>;
  process?(path: string, fn: (data: string) => string): Promise<string>;
}

export interface CourseStoreOptions {
  now?: () => Date;
}

export class CourseStore {
  private readonly adapter: CourseStoreAdapter;
  private readonly root: string;
  private readonly now: () => Date;
  private readonly locks = new Map<string, Promise<unknown>>();
  private tempSequence = 0;

  constructor(adapter: CourseStoreAdapter, root: string, options: CourseStoreOptions = {}) {
    this.adapter = adapter;
    this.root = normalizePath(root);
    this.now = options.now ?? (() => new Date());
  }

  async save(manifest: CourseManifest): Promise<CourseManifest> {
    validateCourseManifest(manifest);
    const candidate = clone(manifest);
    return this.withLock(candidate.course_id, async () => {
      const path = this.pathFor(candidate.course_id);
      const merged = (await this.adapter.exists(path))
        ? mergeCourseSave(candidate, parseManifest(await this.adapter.read(path), path))
        : candidate;
      const normalized = normalizeManifest(merged, this.now());
      await this.ensureRoot();
      await this.atomicWrite(path, serializeManifest(normalized));
      return clone(normalized);
    });
  }

  async load(courseId: string): Promise<CourseManifest | null> {
    assertCourseId(courseId);
    const path = this.pathFor(courseId);
    if (!(await this.adapter.exists(path))) return null;
    const parsed = parseManifest(await this.adapter.read(path), path);
    validateCourseManifest(parsed);
    return clone(parsed);
  }

  /**
   * Read-modify-write one course while holding the same course lock. Callers
   * updating different lessons concurrently cannot overwrite each other's
   * progress with stale manifest snapshots.
   */
  async update(
    courseId: string,
    transform: (manifest: CourseManifest) => CourseManifest | void | Promise<CourseManifest | void>,
  ): Promise<CourseManifest | null> {
    assertCourseId(courseId);
    return this.withLock(courseId, async () => {
      const path = this.pathFor(courseId);
      if (!(await this.adapter.exists(path))) return null;
      const current = parseManifest(await this.adapter.read(path), path);
      validateCourseManifest(current);
      const draft = clone(current);
      const transformed = await transform(draft);
      const candidate = transformed || draft;
      validateCourseManifest(candidate);
      const normalized = normalizeManifest(candidate, this.now());
      await this.ensureRoot();
      await this.atomicWrite(path, serializeManifest(normalized));
      return clone(normalized);
    });
  }

  async loadForPlaylist(playlist: PlaylistInfo): Promise<CourseManifest | null> {
    return this.load(stableCourseId(playlist));
  }

  async list(): Promise<CourseManifest[]> {
    if (!(await this.adapter.exists(this.root))) return [];
    const listed = await this.adapter.list(this.root);
    const manifests: CourseManifest[] = [];
    for (const path of listed.files.filter((file) => file.endsWith('.json')).sort()) {
      try {
        const parsed = parseManifest(await this.adapter.read(path), path);
        validateCourseManifest(parsed);
        manifests.push(parsed);
      } catch (error) {
        console.warn('[CourseStore] skipped invalid manifest', path, error);
      }
    }
    return manifests.map(clone);
  }

  private pathFor(courseId: string): string {
    return `${this.root}/${courseId}.json`;
  }

  private async ensureRoot(): Promise<void> {
    const parts = this.root.split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!(await this.adapter.exists(current))) await this.adapter.mkdir(current);
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
    const temp = this.tempPath(path);
    try {
      await this.adapter.write(temp, data);
      await this.adapter.rename(temp, path);
    } catch (error) {
      await this.removeIfExists(temp);
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
    const temp = this.tempPath(path);
    const backup = `${path}.bak`;
    await this.removeIfExists(temp);
    await this.removeIfExists(backup);
    await this.adapter.write(temp, data);
    let backedUp = false;
    try {
      if (await this.adapter.exists(path)) {
        await this.adapter.rename(path, backup);
        backedUp = true;
      }
      await this.adapter.rename(temp, path);
      if (backedUp) await this.removeIfExists(backup);
    } catch (error) {
      await this.removeIfExists(temp);
      if (backedUp && !(await this.adapter.exists(path)) && (await this.adapter.exists(backup))) {
        await this.adapter.rename(backup, path);
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
    const previous = this.locks.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.locks.set(key, current);
    try {
      return await current;
    } finally {
      if (this.locks.get(key) === current) this.locks.delete(key);
    }
  }
}

export function stableCourseId(
  playlist: Pick<PlaylistInfo, 'platform' | 'sourceType' | 'sourceId'>,
) {
  // Platform/type are enums; remote playlist ids are opaque and may be
  // case-sensitive (notably YouTube), so never case-fold the source id.
  const identity = `${playlist.platform.toLowerCase()}:${playlist.sourceType.toLowerCase()}:${playlist.sourceId.trim()}`;
  return `course-${stableHash(identity)}`;
}

export function emptyCourseProgress(updatedAt: string): CourseItemProgress {
  return {
    status: 'pending',
    percent: 0,
    updated_at: updatedAt,
  };
}

export function summarizeCourseProgress(items: CourseManifestItem[]): CourseManifest['progress'] {
  const summary: CourseManifest['progress'] = {
    pending: 0,
    queued: 0,
    processing: 0,
    complete: 0,
    error: 0,
    removed: 0,
  };
  for (const item of items) {
    if (item.removed_from_source) {
      summary.removed += 1;
      continue;
    }
    summary[item.progress.status] += 1;
  }
  return summary;
}

export function validateCourseManifest(value: unknown): asserts value is CourseManifest {
  if (!isRecord(value)) throw new Error('Course manifest must be an object');
  if (value.schema_version !== COURSE_MANIFEST_SCHEMA_VERSION) {
    throw new Error(`Unsupported course schema: ${String(value.schema_version)}`);
  }
  assertCourseId(value.course_id);
  if (!isRecord(value.source)) throw new Error('Course manifest source is required');
  if (!Array.isArray(value.items)) throw new Error('Course manifest items must be an array');
  const keys = new Set<string>();
  for (const item of value.items) {
    if (!isRecord(item)) throw new Error('Course item must be an object');
    const key = requiredString(item, 'canonical_key');
    if (keys.has(key)) throw new Error(`Duplicate course item: ${key}`);
    keys.add(key);
    requiredString(item, 'item_id');
    requiredString(item, 'canonical_url');
    requiredString(item, 'title');
    if (!isRecord(item.progress)) throw new Error(`Course item ${key} progress is required`);
    const status = requiredString(item.progress, 'status');
    if (!['pending', 'queued', 'processing', 'complete', 'error'].includes(status)) {
      throw new Error(`Course item ${key} has invalid progress status`);
    }
  }
}

function normalizeManifest(manifest: CourseManifest, now: Date): CourseManifest {
  const copy = clone(manifest);
  copy.updated_at = now.toISOString();
  copy.progress = summarizeCourseProgress(copy.items);
  return copy;
}

/**
 * A playlist preview can remain open while a lesson finishes in another view.
 * Saving that old preview must not roll a newer per-item progress record back.
 */
function mergeCourseSave(incoming: CourseManifest, stored: CourseManifest): CourseManifest {
  validateCourseManifest(stored);
  if (incoming.course_id !== stored.course_id) return incoming;
  const incomingTime = Date.parse(incoming.updated_at);
  const storedTime = Date.parse(stored.updated_at);
  const incomingIsOlder =
    incoming.import_count < stored.import_count ||
    (incoming.import_count === stored.import_count &&
      (Number.isFinite(incomingTime) ? incomingTime : 0) <
        (Number.isFinite(storedTime) ? storedTime : 0));
  // An older long-lived playlist preview must not delete lessons or reorder a
  // newer imported structure. Newer imports remain authoritative for
  // structure, while per-item progress is merged independently below.
  const merged = clone(incomingIsOlder ? stored : incoming);
  const other = incomingIsOlder ? incoming : stored;
  const otherByKey = new Map(other.items.map((item) => [item.canonical_key, item] as const));
  for (const item of merged.items) {
    const current = otherByKey.get(item.canonical_key);
    if (!current) continue;
    const itemTime = Date.parse(item.progress.updated_at);
    const currentTime = Date.parse(current.progress.updated_at);
    const itemRank = progressRank(item.progress.status);
    const currentRank = progressRank(current.progress.status);
    const currentIsNewer =
      (Number.isFinite(currentTime) ? currentTime : 0) > (Number.isFinite(itemTime) ? itemTime : 0);
    const tiedButMoreAdvanced = currentTime === itemTime && currentRank > itemRank;
    if (currentIsNewer || tiedButMoreAdvanced) {
      item.progress = clone(current.progress);
    }
  }
  merged.index_note_path ||= incoming.index_note_path || stored.index_note_path;
  merged.progress = summarizeCourseProgress(merged.items);
  return merged;
}

function progressRank(status: CourseProgressStatus): number {
  switch (status) {
    case 'complete':
      return 4;
    case 'processing':
      return 3;
    case 'queued':
      return 2;
    case 'error':
      return 1;
    case 'pending':
    default:
      return 0;
  }
}

function parseManifest(text: string, path: string): CourseManifest {
  try {
    return JSON.parse(text) as CourseManifest;
  } catch {
    throw new Error(`Invalid course manifest JSON: ${path}`);
  }
}

function serializeManifest(manifest: CourseManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function assertCourseId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^course-[a-z0-9]{16}$/.test(value)) {
    throw new Error(`Invalid course id: ${String(value)}`);
  }
}

function stableHash(value: string): string {
  // Two seeded FNV-1a lanes produce a deterministic 64-bit-looking identifier
  // without relying on Node-only crypto in the Obsidian renderer.
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    left ^= code;
    left = Math.imul(left, 0x01000193);
    right ^= code + index;
    right = Math.imul(right, 0x85ebca6b);
  }
  const a = (left >>> 0).toString(16).padStart(8, '0');
  const b = (right >>> 0).toString(16).padStart(8, '0');
  return `${a}${b}`;
}

function normalizePath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/|\/$/g, '');
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const result = value[key];
  if (typeof result !== 'string' || !result.trim()) {
    throw new Error(`Course manifest ${key} is required`);
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
