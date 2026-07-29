import type { DataAdapter, ListedFiles } from 'obsidian';
import type { UserHighlight, VideoKnowledgeArtifact } from '../types';

/**
 * Machine-readable knowledge artifacts live beside the plugin's other sidecars,
 * never in data.json. Callers should pass the plugin data directory as rootPath,
 * for example `${plugin.manifest.dir}/data/knowledge-artifacts`.
 */
export const VIDEO_KNOWLEDGE_ARTIFACT_SCHEMA_VERSION = 3;

const ARTIFACT_FILE_SUFFIX = '.json';
const SAFE_ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/;
const HASH_VALUE = /^[a-f0-9]{8,128}$/;
const TIMING_QUALITY = new Set(['exact', 'aligned', 'estimated', 'none']);

export type ArtifactStoreAdapter = Pick<
  DataAdapter,
  'exists' | 'list' | 'read' | 'write' | 'mkdir' | 'remove' | 'rename'
> & {
  /**
   * Obsidian's current adapter exposes process() as an atomic read-modify-write.
   * It is optional here so older adapters and pure tests can use rename fallback.
   */
  process?: DataAdapter['process'];
};

export interface ArtifactStoreOptions {
  /** Migrate and rewrite old sidecars when they are read. Defaults to true. */
  migrateOnLoad?: boolean;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
}

export interface ArtifactListOptions {
  /**
   * By default corrupt entries are skipped with a warning so one broken sidecar
   * does not hide the rest of the library. Strict mode fails on the first error.
   */
  strict?: boolean;
}

export type HighlightUpdater =
  | readonly UserHighlight[]
  | ((current: readonly UserHighlight[]) => readonly UserHighlight[]);

export interface ArtifactMigrationResult {
  artifact: VideoKnowledgeArtifact;
  migratedFrom?: number;
  changed: boolean;
}

export interface ArtifactValidationIssue {
  path: string;
  message: string;
}

export class ArtifactValidationError extends Error {
  readonly issues: ArtifactValidationIssue[];

  constructor(issues: ArtifactValidationIssue[]) {
    super(
      `Video knowledge artifact validation failed: ${issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join('; ')}`,
    );
    this.name = 'ArtifactValidationError';
    this.issues = issues;
  }
}

export class ArtifactNotFoundError extends Error {
  constructor(artifactId: string) {
    super(`Video knowledge artifact not found: ${artifactId}`);
    this.name = 'ArtifactNotFoundError';
  }
}

/**
 * Versioned, local sidecar store for rich video knowledge.
 *
 * The store is content-addressed by a stable source hash. Saving the same
 * YouTube/Bilibili video through equivalent URL shapes resolves to the same
 * artifact id. Existing artifacts are updated atomically with adapter.process;
 * new files use a same-directory temporary file followed by rename.
 */
export class ArtifactStore {
  private readonly adapter: ArtifactStoreAdapter;
  private readonly rootPath: string;
  private readonly migrateOnLoad: boolean;
  private readonly now: () => Date;
  private readonly locks = new Map<string, Promise<unknown>>();
  private tempSequence = 0;

  constructor(adapter: ArtifactStoreAdapter, rootPath: string, options: ArtifactStoreOptions = {}) {
    this.adapter = adapter;
    this.rootPath = normalizeAdapterPath(rootPath);
    if (!this.rootPath) {
      throw new Error('ArtifactStore rootPath must not be empty');
    }
    this.migrateOnLoad = options.migrateOnLoad !== false;
    this.now = options.now || (() => new Date());
  }

  /**
   * Save an artifact after canonicalizing its source identity, hashes and id.
   * The input object is never mutated.
   */
  async save(input: VideoKnowledgeArtifact): Promise<VideoKnowledgeArtifact> {
    const normalized = await normalizeForSave(input, this.now());
    validateVideoKnowledgeArtifact(normalized);
    const path = this.pathFor(normalized.artifact_id);
    return this.withLock(path, async () => {
      await this.ensureRoot();
      await this.atomicWrite(path, serializeArtifact(normalized));
      return cloneArtifact(normalized);
    });
  }

  /**
   * Load one artifact. Old schemas are migrated and, by default, rewritten to
   * the canonical current id only after the new sidecar has been saved safely.
   */
  async load(artifactId: string): Promise<VideoKnowledgeArtifact> {
    assertArtifactId(artifactId);
    const originalPath = this.pathFor(artifactId);
    if (!(await this.adapter.exists(originalPath))) {
      throw new ArtifactNotFoundError(artifactId);
    }

    return this.withLock(originalPath, async () => {
      const raw = await this.readJson(originalPath);
      const migration = await migrateVideoKnowledgeArtifact(raw, this.now());
      validateVideoKnowledgeArtifact(migration.artifact);

      if (this.migrateOnLoad && migration.changed) {
        const targetPath = this.pathFor(migration.artifact.artifact_id);
        await this.ensureRoot();
        await this.atomicWrite(targetPath, serializeArtifact(migration.artifact));
        if (targetPath !== originalPath && (await this.adapter.exists(originalPath))) {
          await this.adapter.remove(originalPath);
        }
      }

      return cloneArtifact(migration.artifact);
    });
  }

  /**
   * List valid artifacts, most recently updated first. Temporary files and
   * unrelated JSON files are ignored.
   */
  async list(options: ArtifactListOptions = {}): Promise<VideoKnowledgeArtifact[]> {
    if (!(await this.adapter.exists(this.rootPath))) return [];
    const listing = await this.adapter.list(this.rootPath);
    const artifactIds = artifactIdsFromListing(listing, this.rootPath);
    const artifacts: VideoKnowledgeArtifact[] = [];

    for (const artifactId of artifactIds) {
      try {
        artifacts.push(await this.load(artifactId));
      } catch (error) {
        if (options.strict) throw error;
        console.warn(`[ArtifactStore] 跳过损坏的工件 ${artifactId}`, error);
      }
    }

    return artifacts.sort((left, right) => {
      const byTime = Date.parse(right.updated_at) - Date.parse(left.updated_at);
      return byTime || left.artifact_id.localeCompare(right.artifact_id);
    });
  }

  /**
   * Atomically replace or transform user highlights while preserving every
   * other field written by a newer processor. Highlight ids and segment
   * references are validated before the write commits.
   */
  async updateHighlights(
    artifactId: string,
    updater: HighlightUpdater,
  ): Promise<VideoKnowledgeArtifact> {
    assertArtifactId(artifactId);
    const path = this.pathFor(artifactId);
    return this.withLock(path, async () => {
      if (!(await this.adapter.exists(path))) {
        throw new ArtifactNotFoundError(artifactId);
      }

      // Bring legacy data to v3 before entering the synchronous process callback.
      const loaded = await this.loadUnlocked(path);
      const canonicalPath = this.pathFor(loaded.artifact_id);
      if (canonicalPath !== path) {
        return this.updateHighlights(loaded.artifact_id, updater);
      }

      let updated: VideoKnowledgeArtifact | undefined;
      const apply = (currentText: string): string => {
        const current = parseCurrentArtifact(currentText);
        const requested =
          typeof updater === 'function' ? updater(cloneHighlights(current.highlights)) : updater;
        const highlights = normalizeHighlights(requested);
        assertHighlightReferences(highlights, current);
        updated = {
          ...current,
          highlights,
          updated_at: this.now().toISOString(),
        };
        validateVideoKnowledgeArtifact(updated);
        return serializeArtifact(updated);
      };

      if (this.adapter.process) {
        await this.adapter.process(path, apply);
      } else {
        const currentText = await this.adapter.read(path);
        await this.atomicWrite(path, apply(currentText));
      }

      if (!updated) {
        throw new Error(`Artifact highlight update did not produce a result: ${artifactId}`);
      }
      return cloneArtifact(updated);
    });
  }

  /**
   * Compute the canonical source hash used by artifact ids. The hash describes
   * source identity, not the generated summary, so it survives reprocessing.
   */
  static sourceHash(source: VideoKnowledgeArtifact['source']): Promise<string> {
    return stableSourceHash(source);
  }

  static artifactId(sourceHash: string): string {
    return stableArtifactId(sourceHash);
  }

  private async loadUnlocked(path: string): Promise<VideoKnowledgeArtifact> {
    const raw = await this.readJson(path);
    const migration = await migrateVideoKnowledgeArtifact(raw, this.now());
    validateVideoKnowledgeArtifact(migration.artifact);
    if (!this.migrateOnLoad || !migration.changed) return migration.artifact;

    const targetPath = this.pathFor(migration.artifact.artifact_id);
    await this.atomicWrite(targetPath, serializeArtifact(migration.artifact));
    if (targetPath !== path && (await this.adapter.exists(path))) {
      await this.adapter.remove(path);
    }
    return migration.artifact;
  }

  private async readJson(path: string): Promise<unknown> {
    const text = await this.adapter.read(path);
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new ArtifactValidationError([
        {
          path: '$',
          message: `invalid JSON (${error instanceof Error ? error.message : String(error)})`,
        },
      ]);
    }
  }

  private pathFor(artifactId: string): string {
    assertArtifactId(artifactId);
    return `${this.rootPath}/${artifactId}${ARTIFACT_FILE_SUFFIX}`;
  }

  private async ensureRoot(): Promise<void> {
    const parts = this.rootPath.split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!(await this.adapter.exists(current))) {
        try {
          await this.adapter.mkdir(current);
        } catch (error) {
          if (!(await this.adapter.exists(current))) throw error;
        }
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
      // Another writer may have won between exists() and rename().
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

export async function stableSourceHash(source: VideoKnowledgeArtifact['source']): Promise<string> {
  const identity = canonicalSourceIdentity(source);
  if (!identity) {
    const existing = String(source?.source_hash || '')
      .trim()
      .toLowerCase();
    if (HASH_VALUE.test(existing)) return existing;
    throw new ArtifactValidationError([
      {
        path: '$.source',
        message: 'requires url, local_file, note_path, or an existing source_hash',
      },
    ]);
  }
  return sha256Hex(identity);
}

export function stableArtifactId(sourceHash: string): string {
  const normalized = String(sourceHash || '')
    .trim()
    .toLowerCase();
  if (!HASH_VALUE.test(normalized)) {
    throw new ArtifactValidationError([
      { path: '$.source.source_hash', message: 'must be a lowercase hexadecimal hash' },
    ]);
  }
  return `vka-${normalized.slice(0, 32)}`;
}

export function canonicalSourceIdentity(
  source: Partial<VideoKnowledgeArtifact['source']> | null | undefined,
): string {
  if (!source) return '';
  const url = String(source.url || '').trim();
  if (url) return canonicalUrlIdentity(url);

  const localFile = normalizeLocalPath(String(source.local_file || ''));
  if (localFile) return `local:${localFile}`;

  const notePath = normalizeLocalPath(String(source.note_path || ''));
  if (notePath) return `note:${notePath}`;
  return '';
}

export async function sha256Hex(value: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('Web Crypto SHA-256 is unavailable in this Obsidian runtime');
  }
  const bytes = new TextEncoder().encode(value);
  const digest = await subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Accept v1/v2 legacy shapes plus current v3, then return one canonical v3
 * artifact. Unknown future schemas fail closed instead of being overwritten.
 */
export async function migrateVideoKnowledgeArtifact(
  raw: unknown,
  now = new Date(),
): Promise<ArtifactMigrationResult> {
  if (!isRecord(raw)) {
    throw new ArtifactValidationError([{ path: '$', message: 'must be an object' }]);
  }

  const original = JSON.stringify(raw);
  const detectedVersion = detectSchemaVersion(raw);
  if (detectedVersion > VIDEO_KNOWLEDGE_ARTIFACT_SCHEMA_VERSION) {
    throw new ArtifactValidationError([
      {
        path: '$.schema_version',
        message: `unsupported future schema ${detectedVersion}`,
      },
    ]);
  }

  let working: Record<string, unknown> = { ...raw };
  if (detectedVersion <= 1) working = migrateV1ToV2(working);
  if (detectedVersion <= 2) working = migrateV2ToV3(working);

  const sourceRaw = isRecord(working.source)
    ? working.source
    : {
        url: readString(working.source_url),
        local_file: readString(working.local_file),
        note_path: readString(working.note_path),
        source_hash: readString(working.source_hash),
      };
  const source = {
    url: readOptionalString(sourceRaw.url),
    local_file: readOptionalString(sourceRaw.local_file),
    note_path: readOptionalString(sourceRaw.note_path),
    source_hash: await stableSourceHash({
      url: readOptionalString(sourceRaw.url),
      local_file: readOptionalString(sourceRaw.local_file),
      note_path: readOptionalString(sourceRaw.note_path),
      source_hash: readString(sourceRaw.source_hash),
    }),
  };
  const artifactId = stableArtifactId(source.source_hash);
  const createdAt = validIso(working.created_at) || now.toISOString();
  const updatedAt = validIso(working.updated_at) || createdAt;
  const provenanceRaw = isRecord(working.provenance)
    ? working.provenance
    : isRecord(working.artifact)
      ? working.artifact
      : {};
  const transcript = readOptionalString(working.transcript);
  const transcriptHash =
    transcript && transcript.length > 0
      ? await sha256Hex(normalizeTranscriptForHash(transcript))
      : readOptionalString(provenanceRaw.transcript_hash);

  const artifact: VideoKnowledgeArtifact = {
    schema_version: VIDEO_KNOWLEDGE_ARTIFACT_SCHEMA_VERSION,
    artifact_id: artifactId,
    source,
    title: readOptionalString(working.title),
    author: readOptionalString(working.author),
    platform: readOptionalString(working.platform),
    duration: readOptionalString(working.duration),
    cover: readOptionalString(working.cover),
    content_type: working.content_type as VideoKnowledgeArtifact['content_type'],
    timing_quality: normalizeTimingQuality(working.timing_quality),
    transcript,
    segments: arrayOrEmpty(working.segments) as VideoKnowledgeArtifact['segments'],
    claims: arrayOrEmpty(working.claims) as VideoKnowledgeArtifact['claims'],
    visual_evidence: arrayOrEmpty(
      working.visual_evidence,
    ) as VideoKnowledgeArtifact['visual_evidence'],
    attention: isRecord(working.attention)
      ? (working.attention as unknown as VideoKnowledgeArtifact['attention'])
      : undefined,
    learning: isRecord(working.learning)
      ? (working.learning as unknown as VideoKnowledgeArtifact['learning'])
      : undefined,
    related_notes: arrayOrEmpty(working.related_notes) as VideoKnowledgeArtifact['related_notes'],
    highlights: normalizeHighlights(
      arrayOrEmpty(working.highlights) as unknown as readonly UserHighlight[],
    ),
    course_ids: uniqueStrings(working.course_ids),
    provenance: {
      ...(provenanceRaw as VideoKnowledgeArtifact['provenance']),
      schema_version: VIDEO_KNOWLEDGE_ARTIFACT_SCHEMA_VERSION,
      artifact_id: artifactId,
      source_url: source.url,
      source_hash: source.source_hash,
      transcript_hash: transcriptHash,
      generated_at: validIso(provenanceRaw.generated_at) || createdAt,
    },
    created_at: createdAt,
    updated_at: updatedAt,
  };

  stripUndefined(artifact);
  const changed = original !== JSON.stringify(artifact);
  return {
    artifact,
    migratedFrom:
      detectedVersion < VIDEO_KNOWLEDGE_ARTIFACT_SCHEMA_VERSION ? detectedVersion : undefined,
    changed,
  };
}

export function validateVideoKnowledgeArtifact(
  value: unknown,
): asserts value is VideoKnowledgeArtifact {
  const issues: ArtifactValidationIssue[] = [];
  if (!isRecord(value)) {
    throw new ArtifactValidationError([{ path: '$', message: 'must be an object' }]);
  }

  requireEqual(
    issues,
    '$.schema_version',
    value.schema_version,
    VIDEO_KNOWLEDGE_ARTIFACT_SCHEMA_VERSION,
  );
  requireString(issues, '$.artifact_id', value.artifact_id, SAFE_ARTIFACT_ID);
  requireRecord(issues, '$.source', value.source);
  if (isRecord(value.source)) {
    requireString(issues, '$.source.source_hash', value.source.source_hash, HASH_VALUE);
    if (
      !canonicalSourceIdentity(value.source) &&
      !HASH_VALUE.test(readString(value.source.source_hash))
    ) {
      issues.push({
        path: '$.source',
        message: 'requires a source locator or valid source_hash',
      });
    }
  }
  requireString(issues, '$.timing_quality', value.timing_quality);
  if (typeof value.timing_quality === 'string' && !TIMING_QUALITY.has(value.timing_quality)) {
    issues.push({ path: '$.timing_quality', message: 'has an unsupported value' });
  }
  requireIso(issues, '$.created_at', value.created_at);
  requireIso(issues, '$.updated_at', value.updated_at);
  requireArray(issues, '$.segments', value.segments);
  requireArray(issues, '$.claims', value.claims);
  requireArray(issues, '$.visual_evidence', value.visual_evidence);
  requireArray(issues, '$.related_notes', value.related_notes);
  requireArray(issues, '$.highlights', value.highlights);
  requireArray(issues, '$.course_ids', value.course_ids);
  requireRecord(issues, '$.provenance', value.provenance);

  const segmentIds = validateSegments(issues, value.segments);
  validateClaims(issues, value.claims, segmentIds);
  validateVisualEvidence(issues, value.visual_evidence);
  validateHighlights(issues, value.highlights, segmentIds);
  validateStringArray(issues, '$.course_ids', value.course_ids);

  if (isRecord(value.provenance)) {
    requireEqual(
      issues,
      '$.provenance.schema_version',
      value.provenance.schema_version,
      VIDEO_KNOWLEDGE_ARTIFACT_SCHEMA_VERSION,
    );
    if (
      typeof value.provenance.source_hash === 'string' &&
      isRecord(value.source) &&
      value.provenance.source_hash !== value.source.source_hash
    ) {
      issues.push({
        path: '$.provenance.source_hash',
        message: 'must match source.source_hash',
      });
    }
  }

  if (issues.length > 0) throw new ArtifactValidationError(issues);
}

async function normalizeForSave(
  input: VideoKnowledgeArtifact,
  now: Date,
): Promise<VideoKnowledgeArtifact> {
  const migration = await migrateVideoKnowledgeArtifact(cloneArtifact(input), now);
  const artifact = migration.artifact;
  artifact.updated_at = now.toISOString();
  if (!validIso(artifact.created_at)) artifact.created_at = artifact.updated_at;
  if (artifact.transcript) {
    artifact.provenance.transcript_hash = await sha256Hex(
      normalizeTranscriptForHash(artifact.transcript),
    );
  }
  artifact.provenance.artifact_id = artifact.artifact_id;
  artifact.provenance.source_hash = artifact.source.source_hash;
  return artifact;
}

function migrateV1ToV2(raw: Record<string, unknown>): Record<string, unknown> {
  return {
    ...raw,
    schema_version: 2,
    artifact_id: raw.artifact_id || raw.id,
    source: isRecord(raw.source)
      ? raw.source
      : {
          url: raw.source_url || raw.video_url || raw.link,
          local_file: raw.local_file,
          note_path: raw.note_path,
          source_hash: raw.source_hash,
        },
    transcript: raw.transcript || raw.video_transcript,
    segments: raw.segments || raw.video_segments || raw.transcript_segments || [],
    claims: raw.claims || raw.evidence_claims || [],
    visual_evidence: raw.visual_evidence || raw.visual_observations || raw.keyframes || [],
    related_notes: raw.related_notes || [],
    highlights: raw.highlights || [],
    course_ids: raw.course_ids || [],
    provenance: raw.provenance || raw.artifact || {},
  };
}

function migrateV2ToV3(raw: Record<string, unknown>): Record<string, unknown> {
  return {
    ...raw,
    schema_version: VIDEO_KNOWLEDGE_ARTIFACT_SCHEMA_VERSION,
    timing_quality: raw.timing_quality || 'none',
    segments: raw.segments || [],
    claims: raw.claims || [],
    visual_evidence: raw.visual_evidence || [],
    related_notes: raw.related_notes || [],
    highlights: raw.highlights || [],
    course_ids: raw.course_ids || [],
    provenance: isRecord(raw.provenance)
      ? {
          ...raw.provenance,
          schema_version: VIDEO_KNOWLEDGE_ARTIFACT_SCHEMA_VERSION,
        }
      : { schema_version: VIDEO_KNOWLEDGE_ARTIFACT_SCHEMA_VERSION },
  };
}

function parseCurrentArtifact(text: string): VideoKnowledgeArtifact {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ArtifactValidationError([
      {
        path: '$',
        message: `invalid JSON (${error instanceof Error ? error.message : String(error)})`,
      },
    ]);
  }
  validateVideoKnowledgeArtifact(parsed);
  return parsed;
}

function normalizeHighlights(highlights: readonly UserHighlight[]): UserHighlight[] {
  const normalized = highlights.map((highlight) => ({
    id: String(highlight?.id || '').trim(),
    segment_id: String(highlight?.segment_id || '').trim(),
    note:
      typeof highlight?.note === 'string' && highlight.note.trim()
        ? highlight.note.trim()
        : undefined,
    created_at: validIso(highlight?.created_at) || '',
  }));
  return normalized.sort((left, right) => {
    const byDate = left.created_at.localeCompare(right.created_at);
    return byDate || left.id.localeCompare(right.id);
  });
}

function assertHighlightReferences(
  highlights: UserHighlight[],
  artifact: VideoKnowledgeArtifact,
): void {
  const issues: ArtifactValidationIssue[] = [];
  validateHighlights(issues, highlights, new Set(artifact.segments.map((segment) => segment.id)));
  if (issues.length > 0) throw new ArtifactValidationError(issues);
}

function validateSegments(issues: ArtifactValidationIssue[], raw: unknown): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(raw)) return ids;
  raw.forEach((segment, index) => {
    const path = `$.segments[${index}]`;
    if (!isRecord(segment)) {
      issues.push({ path, message: 'must be an object' });
      return;
    }
    requireString(issues, `${path}.id`, segment.id);
    requireString(issues, `${path}.text`, segment.text);
    if (typeof segment.id === 'string') {
      if (ids.has(segment.id)) issues.push({ path: `${path}.id`, message: 'must be unique' });
      ids.add(segment.id);
    }
    if (segment.start !== null && !isNonNegativeNumber(segment.start)) {
      issues.push({ path: `${path}.start`, message: 'must be null or a non-negative number' });
    }
    if (
      segment.end !== undefined &&
      segment.end !== null &&
      (!isNonNegativeNumber(segment.end) ||
        (typeof segment.start === 'number' && segment.end < segment.start))
    ) {
      issues.push({ path: `${path}.end`, message: 'must not precede start' });
    }
  });
  return ids;
}

function validateClaims(
  issues: ArtifactValidationIssue[],
  raw: unknown,
  segmentIds: Set<string>,
): void {
  if (!Array.isArray(raw)) return;
  const ids = new Set<string>();
  raw.forEach((claim, index) => {
    const path = `$.claims[${index}]`;
    if (!isRecord(claim)) {
      issues.push({ path, message: 'must be an object' });
      return;
    }
    requireString(issues, `${path}.id`, claim.id);
    requireString(issues, `${path}.claim`, claim.claim);
    requireArray(issues, `${path}.evidence`, claim.evidence);
    if (typeof claim.id === 'string') {
      if (ids.has(claim.id)) issues.push({ path: `${path}.id`, message: 'must be unique' });
      ids.add(claim.id);
    }
    if (Array.isArray(claim.evidence)) {
      claim.evidence.forEach((reference, evidenceIndex) => {
        const evidencePath = `${path}.evidence[${evidenceIndex}]`;
        if (!isRecord(reference)) {
          issues.push({ path: evidencePath, message: 'must be an object' });
          return;
        }
        requireString(issues, `${evidencePath}.segment_id`, reference.segment_id);
        if (typeof reference.segment_id === 'string' && !segmentIds.has(reference.segment_id)) {
          issues.push({
            path: `${evidencePath}.segment_id`,
            message: 'must reference an existing segment',
          });
        }
      });
    }
  });
}

function validateVisualEvidence(issues: ArtifactValidationIssue[], raw: unknown): void {
  if (!Array.isArray(raw)) return;
  const ids = new Set<string>();
  raw.forEach((item, index) => {
    const path = `$.visual_evidence[${index}]`;
    if (!isRecord(item)) {
      issues.push({ path, message: 'must be an object' });
      return;
    }
    requireString(issues, `${path}.id`, item.id);
    requireString(issues, `${path}.description`, item.description);
    if (!isNonNegativeNumber(item.start)) {
      issues.push({ path: `${path}.start`, message: 'must be a non-negative number' });
    }
    if (typeof item.id === 'string') {
      if (ids.has(item.id)) issues.push({ path: `${path}.id`, message: 'must be unique' });
      ids.add(item.id);
    }
  });
}

function validateHighlights(
  issues: ArtifactValidationIssue[],
  raw: unknown,
  segmentIds: Set<string>,
): void {
  if (!Array.isArray(raw)) return;
  const ids = new Set<string>();
  raw.forEach((highlight, index) => {
    const path = `$.highlights[${index}]`;
    if (!isRecord(highlight)) {
      issues.push({ path, message: 'must be an object' });
      return;
    }
    requireString(issues, `${path}.id`, highlight.id);
    requireString(issues, `${path}.segment_id`, highlight.segment_id);
    requireIso(issues, `${path}.created_at`, highlight.created_at);
    if (typeof highlight.id === 'string') {
      if (ids.has(highlight.id)) issues.push({ path: `${path}.id`, message: 'must be unique' });
      ids.add(highlight.id);
    }
    if (typeof highlight.segment_id === 'string' && !segmentIds.has(highlight.segment_id)) {
      issues.push({
        path: `${path}.segment_id`,
        message: 'must reference an existing segment',
      });
    }
  });
}

function validateStringArray(issues: ArtifactValidationIssue[], path: string, raw: unknown): void {
  if (!Array.isArray(raw)) return;
  const values = new Set<string>();
  raw.forEach((item, index) => {
    if (typeof item !== 'string' || !item.trim()) {
      issues.push({ path: `${path}[${index}]`, message: 'must be a non-empty string' });
      return;
    }
    if (values.has(item)) {
      issues.push({ path: `${path}[${index}]`, message: 'must be unique' });
    }
    values.add(item);
  });
}

function canonicalUrlIdentity(value: string): string {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const youtubeId = youtubeVideoId(url, host);
    if (youtubeId) return `youtube:${youtubeId}`;
    const bilibili = bilibiliVideoId(url, host);
    if (bilibili) return bilibili;

    url.protocol = url.protocol.toLowerCase();
    url.hostname = host;
    url.hash = '';
    const kept = Array.from(url.searchParams.entries())
      .filter(([key]) => !isTrackingParameter(key))
      .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
        const byKey = leftKey.localeCompare(rightKey);
        return byKey || leftValue.localeCompare(rightValue);
      });
    url.search = '';
    for (const [key, item] of kept) url.searchParams.append(key, item);
    url.pathname = url.pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
    return `url:${url.toString()}`;
  } catch {
    return `url:${value.trim()}`;
  }
}

function youtubeVideoId(url: URL, host: string): string | undefined {
  let candidate = '';
  if (host === 'youtu.be') {
    candidate = url.pathname.split('/').filter(Boolean)[0] || '';
  } else if (host === 'youtube.com' || host === 'm.youtube.com') {
    candidate = url.searchParams.get('v') || '';
    if (!candidate) {
      const parts = url.pathname.split('/').filter(Boolean);
      if (['embed', 'shorts', 'live'].includes(parts[0])) candidate = parts[1] || '';
    }
  }
  return /^[A-Za-z0-9_-]{6,20}$/.test(candidate) ? candidate : undefined;
}

function bilibiliVideoId(url: URL, host: string): string | undefined {
  if (host !== 'bilibili.com' && !host.endsWith('.bilibili.com')) return undefined;
  const candidate =
    url.searchParams.get('bvid') ||
    url.pathname.match(/\/video\/(BV[0-9A-Za-z]{10})(?:\/|$)/i)?.[1] ||
    '';
  if (!/^BV[0-9A-Za-z]{10}$/i.test(candidate)) return undefined;
  const normalized = `BV${candidate.slice(2)}`;
  const part = Number(url.searchParams.get('p') || 1);
  return `bilibili:${normalized}:p${Number.isInteger(part) && part > 0 ? part : 1}`;
}

function isTrackingParameter(key: string): boolean {
  const normalized = key.toLowerCase();
  return (
    normalized.startsWith('utm_') ||
    ['fbclid', 'gclid', 'spm_id_from', 'share_source', 'share_medium', 'feature'].includes(
      normalized,
    )
  );
}

function normalizeLocalPath(value: string): string {
  const normalized = value
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/\/\.\//g, '/')
    .replace(/\/$/, '');
  return normalized.replace(/^([A-Z]):/, (_match, drive: string) => `${drive.toLowerCase()}:`);
}

function normalizeAdapterPath(value: string): string {
  return value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/{2,}/g, '/');
}

function normalizeTranscriptForHash(value: string): string {
  return value
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

function artifactIdsFromListing(listing: ListedFiles, rootPath: string): string[] {
  const prefix = `${rootPath}/`;
  return listing.files
    .filter((path) => path.startsWith(prefix) && path.endsWith(ARTIFACT_FILE_SUFFIX))
    .map((path) => path.slice(prefix.length, -ARTIFACT_FILE_SUFFIX.length))
    .filter((id) => SAFE_ARTIFACT_ID.test(id))
    .sort();
}

function detectSchemaVersion(raw: Record<string, unknown>): number {
  const value = Number(raw.schema_version);
  if (!Number.isFinite(value) || value < 1) return 1;
  return Math.floor(value);
}

function normalizeTimingQuality(raw: unknown): VideoKnowledgeArtifact['timing_quality'] {
  return typeof raw === 'string' && TIMING_QUALITY.has(raw)
    ? (raw as VideoKnowledgeArtifact['timing_quality'])
    : 'none';
}

function serializeArtifact(artifact: VideoKnowledgeArtifact): string {
  return `${JSON.stringify(artifact, null, 2)}\n`;
}

function cloneArtifact(artifact: VideoKnowledgeArtifact): VideoKnowledgeArtifact {
  return JSON.parse(JSON.stringify(artifact)) as VideoKnowledgeArtifact;
}

function cloneHighlights(highlights: readonly UserHighlight[]): UserHighlight[] {
  return JSON.parse(JSON.stringify(highlights)) as UserHighlight[];
}

function stripUndefined(value: unknown): void {
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) {
      delete value[key];
    } else if (isRecord(item)) {
      stripUndefined(item);
    }
  }
}

function uniqueStrings(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return Array.from(new Set(raw.map((item) => String(item || '').trim()).filter(Boolean))).sort();
}

function arrayOrEmpty(raw: unknown): unknown[] {
  return Array.isArray(raw) ? raw : [];
}

function validIso(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw.trim() || !Number.isFinite(Date.parse(raw))) {
    return undefined;
  }
  return new Date(raw).toISOString();
}

function readOptionalString(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

function readString(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

function assertArtifactId(artifactId: string): void {
  if (!SAFE_ARTIFACT_ID.test(artifactId)) {
    throw new ArtifactValidationError([
      {
        path: '$.artifact_id',
        message: 'contains unsupported characters or has an invalid length',
      },
    ]);
  }
}

function requireRecord(issues: ArtifactValidationIssue[], path: string, raw: unknown): void {
  if (!isRecord(raw)) issues.push({ path, message: 'must be an object' });
}

function requireArray(issues: ArtifactValidationIssue[], path: string, raw: unknown): void {
  if (!Array.isArray(raw)) issues.push({ path, message: 'must be an array' });
}

function requireString(
  issues: ArtifactValidationIssue[],
  path: string,
  raw: unknown,
  pattern?: RegExp,
): void {
  if (typeof raw !== 'string' || !raw.trim()) {
    issues.push({ path, message: 'must be a non-empty string' });
    return;
  }
  if (pattern && !pattern.test(raw)) issues.push({ path, message: 'has an invalid format' });
}

function requireIso(issues: ArtifactValidationIssue[], path: string, raw: unknown): void {
  if (!validIso(raw)) issues.push({ path, message: 'must be an ISO date-time string' });
}

function requireEqual(
  issues: ArtifactValidationIssue[],
  path: string,
  actual: unknown,
  expected: unknown,
): void {
  if (actual !== expected) issues.push({ path, message: `must equal ${String(expected)}` });
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
