import type {
  EvidenceClaim,
  ProcessingBackend,
  ProcessingDepth,
  VideoSegment,
  VisualEvidence,
} from '../types';
import {
  canonicalSourceIdentity,
  sha256Hex,
  stableArtifactId,
  stableSourceHash,
} from './ArtifactStore';

export const REPRODUCIBILITY_MANIFEST_VERSION = 1;

const SHA256 = /^[a-f0-9]{64}$/;

export interface ReproducibilitySource {
  url?: string;
  local_file?: string;
  note_path?: string;
  transcript_hash?: string;
  source_hash?: string;
}

export interface ReproducibilityManifestInput {
  source: ReproducibilitySource;
  artifact_id?: string;
  transcript: string;
  segments?: VideoSegment[];
  evidence_claims?: EvidenceClaim[];
  visual_evidence?: VisualEvidence[];
  backend: ProcessingBackend;
  model: string;
  /** Effective prompt text or stable prompt profile identifier. */
  prompt: string;
  /** Prompt/workflow version paired with prompt. */
  version: string;
  depth: ProcessingDepth;
  generated_at?: string;
}

export interface ReproducibilityManifest {
  schema_version: number;
  kind: 'video-summary-reprocess';
  artifact_id: string;
  source: ReproducibilitySource;
  source_identity?: string;
  source_hash: string;
  transcript_hash: string;
  evidence_hash: string;
  backend: ProcessingBackend;
  model: string;
  prompt: string;
  version: string;
  depth: ProcessingDepth;
  can_reprocess_without_source_fetch: true;
  raw: {
    transcript: string;
    segments: VideoSegment[];
    evidence_claims: EvidenceClaim[];
    visual_evidence: VisualEvidence[];
  };
  generated_at: string;
  warnings: string[];
}

export interface RestoredReprocessPayload {
  artifact_id: string;
  source: ReproducibilitySource;
  source_hash: string;
  transcript: string;
  video_segments: VideoSegment[];
  evidence_claims: EvidenceClaim[];
  visual_evidence: VisualEvidence[];
  processing: {
    backend: ProcessingBackend;
    model: string;
    prompt: string;
    version: string;
    depth: ProcessingDepth;
  };
  skip_source_fetch: true;
}

export class ReproducibilityManifestError extends Error {
  constructor(message: string) {
    super(`Reproducibility manifest: ${message}`);
    this.name = 'ReproducibilityManifestError';
  }
}

/**
 * Snapshot the raw transcript and evidence needed to run a new prompt/model
 * without downloading or transcribing the source video again.
 */
export async function createReproducibilityManifest(
  input: ReproducibilityManifestInput,
): Promise<ReproducibilityManifest> {
  validateInput(input);
  const sourceIdentity = canonicalSourceIdentity(input.source);
  const existingHash = normalizeHash(input.source.source_hash);
  const calculatedHash = sourceIdentity
    ? await stableSourceHash({
        ...input.source,
        source_hash: existingHash || '',
      })
    : existingHash;
  if (!calculatedHash) {
    throw new ReproducibilityManifestError('source requires identity fields or source_hash');
  }
  if (existingHash && sourceIdentity && existingHash !== calculatedHash) {
    throw new ReproducibilityManifestError('provided source_hash does not match source identity');
  }

  const raw = {
    transcript: input.transcript,
    segments: clone(input.segments || []),
    evidence_claims: clone(input.evidence_claims || []),
    visual_evidence: clone(input.visual_evidence || []),
  };
  const transcriptHash = await sha256Hex(raw.transcript);
  const evidenceHash = await sha256Hex(
    stableStringify({
      segments: raw.segments,
      evidence_claims: raw.evidence_claims,
      visual_evidence: raw.visual_evidence,
    }),
  );
  const warnings = evidenceWarnings(raw.segments, raw.evidence_claims);
  return {
    schema_version: REPRODUCIBILITY_MANIFEST_VERSION,
    kind: 'video-summary-reprocess',
    artifact_id: input.artifact_id?.trim() || stableArtifactId(calculatedHash),
    source: {
      url: cleanOptional(input.source.url),
      local_file: cleanOptional(input.source.local_file),
      note_path: cleanOptional(input.source.note_path),
      transcript_hash: cleanOptional(input.source.transcript_hash),
      source_hash: calculatedHash,
    },
    source_identity: sourceIdentity || undefined,
    source_hash: calculatedHash,
    transcript_hash: transcriptHash,
    evidence_hash: evidenceHash,
    backend: input.backend,
    model: input.model.trim(),
    prompt: input.prompt,
    version: input.version.trim(),
    depth: input.depth,
    can_reprocess_without_source_fetch: true,
    raw,
    generated_at: normalizeIso(input.generated_at),
    warnings,
  };
}

/**
 * Verify hashes before restoring raw inputs. A caller can submit `transcript`
 * directly as provided_transcript and keep skip_source_fetch=true.
 */
export async function restoreReprocessPayload(
  manifest: ReproducibilityManifest,
): Promise<RestoredReprocessPayload> {
  validateManifestShape(manifest);
  const transcriptHash = await sha256Hex(manifest.raw.transcript);
  if (transcriptHash !== manifest.transcript_hash) {
    throw new ReproducibilityManifestError('transcript_hash mismatch; raw transcript was changed');
  }
  const evidenceHash = await sha256Hex(
    stableStringify({
      segments: manifest.raw.segments,
      evidence_claims: manifest.raw.evidence_claims,
      visual_evidence: manifest.raw.visual_evidence,
    }),
  );
  if (evidenceHash !== manifest.evidence_hash) {
    throw new ReproducibilityManifestError('evidence_hash mismatch; raw evidence was changed');
  }
  const identity = canonicalSourceIdentity(manifest.source);
  if (identity) {
    const sourceHash = await stableSourceHash({
      ...manifest.source,
      source_hash: manifest.source_hash,
    });
    if (sourceHash !== manifest.source_hash) {
      throw new ReproducibilityManifestError('source_hash mismatch; source identity was changed');
    }
  }

  return {
    artifact_id: manifest.artifact_id,
    source: clone(manifest.source),
    source_hash: manifest.source_hash,
    transcript: manifest.raw.transcript,
    video_segments: clone(manifest.raw.segments),
    evidence_claims: clone(manifest.raw.evidence_claims),
    visual_evidence: clone(manifest.raw.visual_evidence),
    processing: {
      backend: manifest.backend,
      model: manifest.model,
      prompt: manifest.prompt,
      version: manifest.version,
      depth: manifest.depth,
    },
    skip_source_fetch: true,
  };
}

export function serializeReproducibilityManifest(manifest: ReproducibilityManifest): string {
  validateManifestShape(manifest);
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function validateManifestShape(manifest: ReproducibilityManifest): void {
  if (!manifest || typeof manifest !== 'object') {
    throw new ReproducibilityManifestError('manifest must be an object');
  }
  if (
    manifest.schema_version !== REPRODUCIBILITY_MANIFEST_VERSION ||
    manifest.kind !== 'video-summary-reprocess'
  ) {
    throw new ReproducibilityManifestError('unsupported schema or kind');
  }
  if (!manifest.artifact_id?.trim()) {
    throw new ReproducibilityManifestError('artifact_id is required');
  }
  if (
    !SHA256.test(manifest.source_hash) ||
    !SHA256.test(manifest.transcript_hash) ||
    !SHA256.test(manifest.evidence_hash)
  ) {
    throw new ReproducibilityManifestError('hash fields must be lowercase SHA-256 values');
  }
  if (
    !manifest.raw ||
    typeof manifest.raw.transcript !== 'string' ||
    !Array.isArray(manifest.raw.segments) ||
    !Array.isArray(manifest.raw.evidence_claims) ||
    !Array.isArray(manifest.raw.visual_evidence)
  ) {
    throw new ReproducibilityManifestError('raw transcript/evidence snapshot is incomplete');
  }
  if (manifest.can_reprocess_without_source_fetch !== true) {
    throw new ReproducibilityManifestError(
      'manifest must explicitly permit raw-input reprocessing',
    );
  }
  validateBackend(manifest.backend);
  validateDepth(manifest.depth);
  if (!manifest.model?.trim() || !manifest.prompt?.trim() || !manifest.version?.trim()) {
    throw new ReproducibilityManifestError('backend metadata is incomplete');
  }
  if (!Number.isFinite(Date.parse(manifest.generated_at))) {
    throw new ReproducibilityManifestError('generated_at must be an ISO date');
  }
}

function validateInput(input: ReproducibilityManifestInput): void {
  if (!input || typeof input !== 'object') {
    throw new ReproducibilityManifestError('input must be an object');
  }
  if (!input.transcript?.trim()) {
    throw new ReproducibilityManifestError(
      'raw transcript is required for reprocessing without source fetch',
    );
  }
  validateBackend(input.backend);
  validateDepth(input.depth);
  if (!input.model?.trim() || !input.prompt?.trim() || !input.version?.trim()) {
    throw new ReproducibilityManifestError('model, prompt and version are required');
  }
}

function validateBackend(value: ProcessingBackend): void {
  if (value !== 'n8n' && value !== 'codex-worker') {
    throw new ReproducibilityManifestError(`unsupported backend ${String(value)}`);
  }
}

function validateDepth(value: ProcessingDepth): void {
  if (!['quick', 'evidence', 'deep-visual'].includes(value)) {
    throw new ReproducibilityManifestError(`unsupported depth ${String(value)}`);
  }
}

function evidenceWarnings(segments: VideoSegment[], claims: EvidenceClaim[]): string[] {
  const segmentIds = new Set(segments.map((segment) => segment.id));
  const missing = new Set<string>();
  claims.forEach((claim) => {
    claim.evidence.forEach((reference) => {
      if (!segmentIds.has(reference.segment_id)) missing.add(reference.segment_id);
    });
  });
  return missing.size > 0
    ? [`${missing.size} 个 claim evidence 引用了快照中不存在的 segment；保留原样供人工复核。`]
    : [];
}

function normalizeHash(value: string | undefined): string {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (!normalized) return '';
  if (!SHA256.test(normalized)) {
    throw new ReproducibilityManifestError('source_hash must be a lowercase SHA-256 value');
  }
  return normalized;
}

function normalizeIso(value: string | undefined): string {
  if (!value) return new Date().toISOString();
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new ReproducibilityManifestError('generated_at must be a valid date');
  }
  return new Date(timestamp).toISOString();
}

function cleanOptional(value: string | undefined): string | undefined {
  const normalized = String(value || '').trim();
  return normalized || undefined;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
