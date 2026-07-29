// agent: codex (2026-07-29)
import { canonicalizeVideoUrl } from '../shared';
import type {
  ProcessingBackend,
  ProcessingDepth,
  ProcessingMode,
  RequestedContentType,
  SupportedLanguage,
  VideoInput,
} from '../types';

export const ARTIFACT_FINGERPRINT_VERSION = 2;
export const ARTIFACT_FINGERPRINT_PREFIX = 'video-summary:fingerprint:v2';

export type VisualFingerprintMode = 'off' | 'keyframes' | 'deep';
export type LegacyCacheCompatibility = 'lookup-candidate' | 'unsafe' | 'not-applicable';

export interface ArtifactFingerprintRequest {
  input: VideoInput;
  mode: ProcessingMode;
  language: SupportedLanguage;
  model: string;
  backend: ProcessingBackend;
  schemaVersion: number;
  processingDepth: ProcessingDepth;
  requestedContentType: RequestedContentType;
  autoRoute: boolean;
  visual: boolean | VisualFingerprintMode;
  attention: boolean;
  learning: boolean;
  promptVersion: string;
  /**
   * Optional content digests for local files, keyed by either the original path
   * or its normalized slash-separated form. Without one, the path identity is
   * hashed; callers that can read the file should always provide a content hash.
   */
  localFileHashes?: Readonly<Record<string, string>>;
  /** Use when the transcript was already hashed by an extraction stage. */
  transcriptHash?: string;
}

export interface FingerprintLocalSource {
  position: number;
  path_hash: string;
  content_hash: string | null;
}

export interface ArtifactSourceFingerprint {
  url_hash: string | null;
  local_hash: string | null;
  local_sources: FingerprintLocalSource[];
  transcript_hash: string | null;
  source_hash: string;
}

export interface ArtifactRunFingerprint {
  mode: ProcessingMode;
  language: SupportedLanguage;
  model: string;
  backend: ProcessingBackend;
  schema_version: number;
  processing_depth: ProcessingDepth;
  requested_content_type: RequestedContentType;
  auto_route: boolean;
  visual: VisualFingerprintMode;
  attention: boolean;
  learning: boolean;
  prompt_version: string;
}

export interface LegacyCacheCandidate {
  key: string;
  /** Filename stem produced by CacheManager's historical 32-bit key hash. */
  file_stem: string;
}

export interface LegacyCacheMarker {
  scheme: 'url|mode|language';
  compatibility: LegacyCacheCompatibility;
  candidates: LegacyCacheCandidate[];
  /**
   * The historical key omits model/backend/schema/prompt and all rich modes, so
   * even a lookup candidate must have its stored provenance validated.
   */
  reuse_requires_validation: true;
  reason: string;
}

export interface ArtifactFingerprint {
  version: typeof ARTIFACT_FINGERPRINT_VERSION;
  algorithm: 'sha256';
  key: string;
  digest: string;
  source: ArtifactSourceFingerprint;
  run: ArtifactRunFingerprint;
  run_hash: string;
  /** Canonical, stable-key-order input used to calculate `digest`. */
  serialized: string;
  legacy: LegacyCacheMarker;
}

interface FingerprintEnvelope {
  fingerprint_version: typeof ARTIFACT_FINGERPRINT_VERSION;
  source: ArtifactSourceFingerprint;
  run: ArtifactRunFingerprint;
}

/**
 * Build the complete identity of one generated artifact.
 *
 * Raw transcript text and local paths never enter the serialized fingerprint;
 * only their digests do. This keeps cache/index material compact and avoids
 * leaking source content while still invalidating when an input changes.
 */
export function buildArtifactFingerprint(request: ArtifactFingerprintRequest): ArtifactFingerprint {
  validateSchemaVersion(request.schemaVersion);

  const canonicalUrl = canonicalSourceUrl(request.input.sourceUrl || request.input.url);
  const localPaths = collectLocalPaths(request.input);
  const normalizedTranscript = normalizeTranscript(request.input.transcript);
  const urlHash = canonicalUrl ? sha256Hex(canonicalUrl) : null;
  const transcriptHash = request.transcriptHash
    ? normalizeProvidedHash(request.transcriptHash)
    : normalizedTranscript
      ? sha256Hex(normalizedTranscript)
      : null;
  const localSources = localPaths.map((path, position) => {
    const normalizedPath = normalizeLocalPath(path);
    const providedHash =
      request.localFileHashes?.[path] ?? request.localFileHashes?.[normalizedPath];
    return {
      position,
      path_hash: sha256Hex(normalizedPath),
      content_hash: providedHash ? normalizeProvidedHash(providedHash) : null,
    };
  });
  const localHash = localSources.length > 0 ? sha256Hex(stableSerialize(localSources)) : null;

  if (!urlHash && !localHash && !transcriptHash) {
    throw new Error('Artifact fingerprint requires a URL, local file, or transcript.');
  }

  const sourceIdentity = {
    url_hash: urlHash,
    local_hash: localHash,
    transcript_hash: transcriptHash,
  };
  const source: ArtifactSourceFingerprint = {
    ...sourceIdentity,
    local_sources: localSources,
    source_hash: sha256Hex(stableSerialize(sourceIdentity)),
  };
  const run: ArtifactRunFingerprint = {
    mode: request.mode,
    language: request.language,
    model: normalizeLabel(request.model, 'unspecified'),
    backend: request.backend,
    schema_version: request.schemaVersion,
    processing_depth: request.processingDepth,
    requested_content_type: request.requestedContentType,
    auto_route: request.autoRoute === true,
    visual: normalizeVisualMode(request.visual, request.processingDepth),
    attention: request.attention === true,
    learning: request.learning === true,
    prompt_version: normalizeLabel(request.promptVersion, 'unversioned'),
  };
  const runHash = sha256Hex(stableSerialize(run));
  const envelope: FingerprintEnvelope = {
    fingerprint_version: ARTIFACT_FINGERPRINT_VERSION,
    source,
    run,
  };
  const serialized = stableSerialize(envelope);
  const digest = sha256Hex(serialized);

  return {
    version: ARTIFACT_FINGERPRINT_VERSION,
    algorithm: 'sha256',
    key: `${ARTIFACT_FINGERPRINT_PREFIX}:${digest}`,
    digest,
    source,
    run,
    run_hash: runHash,
    serialized,
    legacy: buildLegacyCacheMarker(
      request.input,
      canonicalUrl,
      request.mode,
      request.language,
      localSources.length > 0,
      transcriptHash !== null,
    ),
  };
}

/** Historical CacheManager key, exposed for an explicit migration bridge. */
export function buildLegacyCacheKey(
  url: string,
  mode: ProcessingMode,
  language: SupportedLanguage,
): string {
  return `${url}|${mode}|${language}`;
}

/** Historical CacheManager filename hash; do not use for new fingerprints. */
export function legacyCacheFileStem(key: string): string {
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash << 5) - hash + key.charCodeAt(index);
    hash &= hash;
  }
  return Math.abs(hash).toString(36);
}

/**
 * Deterministic JSON serialization. Object keys are sorted recursively; array
 * order is preserved because local-file/merge order can change the output.
 */
export function stableSerialize(value: unknown): string {
  return serializeStable(value, new Set<object>(), false);
}

/** Synchronous, dependency-free SHA-256 for browser, mobile, and desktop builds. */
export function sha256Hex(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;

  const bitLength = bytes.length * 8;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const s0 =
        rotateRight(words[index - 15], 7) ^
        rotateRight(words[index - 15], 18) ^
        (words[index - 15] >>> 3);
      const s1 =
        rotateRight(words[index - 2], 17) ^
        rotateRight(words[index - 2], 19) ^
        (words[index - 2] >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }

    let a = state[0];
    let b = state[1];
    let c = state[2];
    let d = state[3];
    let e = state[4];
    let f = state[5];
    let g = state[6];
    let h = state[7];

    for (let index = 0; index < 64; index += 1) {
      const sigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + sigma1 + choose + SHA256_CONSTANTS[index] + words[index]) >>> 0;
      const sigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sigma0 + majority) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    state[0] = (state[0] + a) >>> 0;
    state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0;
    state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0;
    state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0;
    state[7] = (state[7] + h) >>> 0;
  }

  return Array.from(state, (word) => word.toString(16).padStart(8, '0')).join('');
}

function canonicalSourceUrl(value?: string): string {
  const trimmed = value?.trim();
  return trimmed ? canonicalizeVideoUrl(trimmed, { keepP: true, keepTimestamp: false }).trim() : '';
}

function collectLocalPaths(input: VideoInput): string[] {
  const paths = [input.localFile, ...(input.localFiles ?? [])]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => normalizeLocalPath(value));
  return paths.filter((path, index) => paths.indexOf(path) === index);
}

function normalizeLocalPath(value: string): string {
  return value
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/');
}

function normalizeTranscript(value?: string): string {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

function normalizeProvidedHash(value: string): string {
  const trimmed = value.trim();
  const sha = trimmed.match(/^(?:sha256:)?([a-fA-F0-9]{64})$/);
  return sha ? sha[1].toLowerCase() : `external:${trimmed}`;
}

function normalizeLabel(value: string, fallback: string): string {
  return value.trim() || fallback;
}

function normalizeVisualMode(
  visual: boolean | VisualFingerprintMode,
  depth: ProcessingDepth,
): VisualFingerprintMode {
  if (visual === false || visual === 'off') return 'off';
  if (visual === 'deep') return 'deep';
  if (visual === 'keyframes') return 'keyframes';
  return depth === 'deep-visual' ? 'deep' : 'keyframes';
}

function buildLegacyCacheMarker(
  input: VideoInput,
  canonicalUrl: string,
  mode: ProcessingMode,
  language: SupportedLanguage,
  hasLocalSources: boolean,
  hasTranscript: boolean,
): LegacyCacheMarker {
  const originalUrl = input.url?.trim() ?? '';
  const urls = [originalUrl, canonicalUrl].filter(
    (url, index, candidates): url is string => url.length > 0 && candidates.indexOf(url) === index,
  );
  const candidates = urls.map((url) => {
    const key = buildLegacyCacheKey(url, mode, language);
    return { key, file_stem: legacyCacheFileStem(key) };
  });

  if (candidates.length === 0) {
    return {
      scheme: 'url|mode|language',
      compatibility: 'not-applicable',
      candidates,
      reuse_requires_validation: true,
      reason: 'Legacy cache keys require a URL.',
    };
  }
  if (hasLocalSources || hasTranscript) {
    return {
      scheme: 'url|mode|language',
      compatibility: 'unsafe',
      candidates,
      reuse_requires_validation: true,
      reason: 'Legacy keys ignore supplemental local files and transcripts.',
    };
  }
  return {
    scheme: 'url|mode|language',
    compatibility: 'lookup-candidate',
    candidates,
    reuse_requires_validation: true,
    reason:
      'Legacy keys omit model, backend, schema, depth, routing, feature flags, and prompt version.',
  };
}

function validateSchemaVersion(value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error('Artifact schemaVersion must be a positive integer.');
  }
}

function serializeStable(value: unknown, ancestors: Set<object>, inArray: boolean): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Cannot fingerprint a non-finite number.');
    return Object.is(value, -0) ? '0' : JSON.stringify(value);
  }
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return inArray ? 'null' : '';
  }
  if (typeof value === 'bigint') {
    throw new TypeError('Cannot fingerprint a bigint value.');
  }
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (typeof value !== 'object') {
    throw new TypeError(`Unsupported fingerprint value: ${typeof value}`);
  }
  if (ancestors.has(value)) throw new TypeError('Cannot fingerprint a circular value.');

  ancestors.add(value);
  let serialized: string;
  if (Array.isArray(value)) {
    serialized = `[${value.map((item) => serializeStable(item, ancestors, true)).join(',')}]`;
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      ancestors.delete(value);
      throw new TypeError('Only plain objects can be fingerprinted.');
    }
    const entries = Object.keys(value)
      .sort()
      .filter((key) => {
        const item = (value as Record<string, unknown>)[key];
        return item !== undefined && typeof item !== 'function' && typeof item !== 'symbol';
      })
      .map(
        (key) =>
          `${JSON.stringify(key)}:${serializeStable(
            (value as Record<string, unknown>)[key],
            ancestors,
            false,
          )}`,
      );
    serialized = `{${entries.join(',')}}`;
  }
  ancestors.delete(value);
  return serialized;
}

function rotateRight(value: number, shift: number): number {
  return (value >>> shift) | (value << (32 - shift));
}

const SHA256_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
