import type { MediaAssetReference, ProcessingResult, VideoSegment, VisualEvidence } from '../types';

export interface BinaryAssetAdapter {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
}

export interface BinaryDownload {
  data: ArrayBuffer;
  contentType?: string;
}

export type BinaryFetcher = (url: string, signal: AbortSignal) => Promise<BinaryDownload>;

export interface MediaAssetLocalizerOptions {
  maxAssets?: number;
  maxAssetBytes?: number;
  maxTotalBytes?: number;
  timeoutMs?: number;
  fetchBinary?: BinaryFetcher;
  workerEndpoint?: string;
}

export interface MediaLocalizationResult {
  result: ProcessingResult;
  localized: number;
  warnings: string[];
}

const SAFE_ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/;

/**
 * Copies worker-served evidence images into a Vault-relative asset folder.
 *
 * Only URLs on the configured loopback Worker's exact origin and fixed asset
 * path contract are downloaded. Redirects and absolute worker paths are never
 * followed or read directly.
 */
export class MediaAssetLocalizer {
  private readonly adapter: BinaryAssetAdapter;
  private readonly rootPath: string;
  private readonly maxAssets: number;
  private readonly maxAssetBytes: number;
  private readonly maxTotalBytes: number;
  private readonly timeoutMs: number;
  private readonly fetchBinary: BinaryFetcher;
  private readonly allowedAssetOrigin?: string;

  constructor(
    adapter: BinaryAssetAdapter,
    rootPath: string,
    options: MediaAssetLocalizerOptions = {},
  ) {
    this.adapter = adapter;
    this.rootPath = normalizeVaultPath(rootPath);
    if (!this.rootPath || containsTraversal(this.rootPath)) {
      throw new Error('MediaAssetLocalizer rootPath must be a safe Vault-relative path');
    }
    this.maxAssets = boundedInteger(options.maxAssets, 1, 96, 48);
    this.maxAssetBytes = boundedInteger(options.maxAssetBytes, 64_000, 20_000_000, 3_000_000);
    this.maxTotalBytes = boundedInteger(
      options.maxTotalBytes,
      this.maxAssetBytes,
      100_000_000,
      30_000_000,
    );
    this.timeoutMs = boundedInteger(options.timeoutMs, 1_000, 120_000, 20_000);
    this.fetchBinary = options.fetchBinary || fetchLoopbackBinary;
    this.allowedAssetOrigin = allowedLoopbackWorkerOrigin(options.workerEndpoint);
  }

  async localizeResult(
    input: ProcessingResult,
    artifactId: string,
  ): Promise<MediaLocalizationResult> {
    if (!SAFE_ARTIFACT_ID.test(artifactId)) {
      throw new Error(`Unsafe visual artifact id: ${artifactId}`);
    }
    const warnings: string[] = [];
    const memo = new Map<string, Promise<MediaAssetReference>>();
    let localized = 0;
    let attempted = 0;
    let totalBytes = 0;

    const localize = async (asset: MediaAssetReference | undefined) => {
      if (!asset) return asset;
      const candidate = { ...asset };
      const existingPath = normalizeExistingAssetPath(asset.path);
      if (existingPath) {
        if (!isWithinManagedRoot(existingPath, this.rootPath)) {
          warnings.push(`visual_asset_path_outside_managed_root:${asset.id || 'unknown'}`);
          candidate.path = undefined;
        } else if (await this.adapter.exists(existingPath)) {
          return { ...candidate, path: existingPath };
        } else {
          warnings.push(`visual_asset_path_missing:${asset.id || 'unknown'}`);
          candidate.path = undefined;
        }
      } else if (asset.path) {
        // Codex Worker includes its absolute scratch path alongside a signed
        // loopback asset URL. We never read that path; a safe URL is enough to
        // localize it without surfacing a misleading warning to the user.
        const fallbackUrl = String(asset.url || '').trim();
        if (!isAllowedWorkerAssetUrl(fallbackUrl, this.allowedAssetOrigin)) {
          warnings.push(`visual_asset_path_rejected:${asset.id || 'unknown'}`);
        }
        candidate.path = undefined;
      }
      const url = String(candidate.url || '').trim();
      if (!url) return candidate;
      if (!isAllowedWorkerAssetUrl(url, this.allowedAssetOrigin)) {
        warnings.push(`visual_asset_not_localized_untrusted_origin:${asset.id || 'unknown'}`);
        return candidate;
      }
      const expected = normalizeSha256(asset.sha256);
      const declaredType = declaredImageType(asset.mime_type, url);
      if (expected && declaredType) {
        const knownPath = `${this.rootPath}/${artifactId}/${safeAssetStem(asset.id)}-${expected.slice(
          0,
          20,
        )}.${declaredType}`;
        if (await this.adapter.exists(knownPath)) {
          return {
            ...candidate,
            path: knownPath,
            mime_type: declaredType === 'jpg' ? 'image/jpeg' : 'image/png',
            sha256: expected,
          };
        }
      }

      let pending = memo.get(url);
      if (!pending) {
        if (attempted >= this.maxAssets) {
          warnings.push(`visual_asset_count_capped:${this.maxAssets}`);
          return candidate;
        }
        attempted += 1;
        pending = (async () => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), this.timeoutMs);
          try {
            const download = await this.fetchBinary(url, controller.signal);
            const bytes = download.data.byteLength;
            if (bytes <= 0) throw new Error('empty response');
            if (bytes > this.maxAssetBytes) {
              throw new Error(`asset exceeds ${this.maxAssetBytes} bytes`);
            }
            if (totalBytes + bytes > this.maxTotalBytes) {
              throw new Error(`batch exceeds ${this.maxTotalBytes} bytes`);
            }
            const detected = detectImageType(download.data);
            if (!detected) throw new Error('response is not a supported JPEG or PNG');
            if (
              download.contentType &&
              !/^image\/(?:jpeg|jpg|png)(?:\s*;|$)/i.test(download.contentType)
            ) {
              throw new Error(`unexpected content type ${download.contentType}`);
            }
            const digest = await sha256Buffer(download.data);
            if (expected && digest !== expected) throw new Error('sha256 mismatch');
            const filename = `${safeAssetStem(asset.id)}-${digest.slice(0, 20)}.${detected}`;
            const directory = `${this.rootPath}/${artifactId}`;
            const path = `${directory}/${filename}`;
            await ensureDirectory(this.adapter, directory);
            if (!(await this.adapter.exists(path))) {
              await this.adapter.writeBinary(path, download.data);
            }
            totalBytes += bytes;
            localized += 1;
            return {
              ...candidate,
              path,
              mime_type: detected === 'jpg' ? 'image/jpeg' : 'image/png',
              sha256: digest,
              bytes,
            };
          } finally {
            clearTimeout(timer);
          }
        })();
        memo.set(url, pending);
      }

      try {
        return await pending;
      } catch (error) {
        warnings.push(
          `visual_asset_localization_failed:${asset.id || 'unknown'}:${messageOf(error)}`,
        );
        return candidate;
      }
    };

    let segments: VideoSegment[] | undefined;
    if (input.video_segments) {
      segments = [];
      for (const segment of input.video_segments) {
        segments.push({ ...segment, keyframe: await localize(segment.keyframe) });
      }
    }
    let visualEvidence: VisualEvidence[] | undefined;
    if (input.visual_evidence) {
      visualEvidence = [];
      for (const evidence of input.visual_evidence) {
        visualEvidence.push({ ...evidence, keyframe: await localize(evidence.keyframe) });
      }
    }

    return {
      result: {
        ...input,
        video_segments: segments,
        visual_evidence: visualEvidence,
      },
      localized,
      warnings: uniqueStrings(warnings),
    };
  }
}

export function mediaAssetRoot(outputFolder: string | undefined): string {
  const folder = normalizeVaultPath(outputFolder || '');
  if (!folder || containsTraversal(folder)) return '_video-summary-assets';
  return `${folder}/_video-summary-assets`;
}

async function fetchLoopbackBinary(url: string, signal: AbortSignal): Promise<BinaryDownload> {
  const response = await fetch(url, {
    method: 'GET',
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
    signal,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > 20_000_000) {
    throw new Error('declared asset size is too large');
  }
  return {
    data: await response.arrayBuffer(),
    contentType: response.headers.get('content-type') || undefined,
  };
}

async function ensureDirectory(adapter: BinaryAssetAdapter, directory: string): Promise<void> {
  const parts = directory.split('/').filter(Boolean);
  let current = '';
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!(await adapter.exists(current))) await adapter.mkdir(current);
  }
}

function normalizeExistingAssetPath(path: string | undefined): string | undefined {
  const value = String(path || '').trim();
  if (!value || value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) return undefined;
  const normalized = normalizeVaultPath(value);
  return !normalized || containsTraversal(normalized) ? undefined : normalized;
}

function isWithinManagedRoot(path: string, rootPath: string): boolean {
  return path === rootPath || path.startsWith(`${rootPath}/`);
}

function allowedLoopbackWorkerOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return undefined;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host !== '127.0.0.1' && host !== '::1') return undefined;
    if (url.username || url.password) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

function isAllowedWorkerAssetUrl(value: string, allowedOrigin: string | undefined): boolean {
  if (!allowedOrigin) return false;
  try {
    const url = new URL(value);
    if (url.origin !== allowedOrigin || url.username || url.password || url.search || url.hash) {
      return false;
    }
    return /^\/video-summary\/assets\/[A-Za-z0-9][A-Za-z0-9._-]{2,127}\/[A-Za-z0-9._-]+\.(?:png|jpe?g)$/i.test(
      url.pathname,
    );
  } catch {
    return false;
  }
}

function detectImageType(data: ArrayBuffer): 'jpg' | 'png' | undefined {
  const bytes = new Uint8Array(data);
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpg';
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'png';
  }
  return undefined;
}

function declaredImageType(mimeType: string | undefined, url: string): 'jpg' | 'png' | undefined {
  if (/^image\/(?:jpeg|jpg)(?:\s*;|$)/i.test(mimeType || '')) return 'jpg';
  if (/^image\/png(?:\s*;|$)/i.test(mimeType || '')) return 'png';
  try {
    const path = new URL(url).pathname.toLowerCase();
    if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'jpg';
    if (path.endsWith('.png')) return 'png';
  } catch {
    return undefined;
  }
  return undefined;
}

async function sha256Buffer(data: ArrayBuffer): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('Web Crypto SHA-256 is unavailable');
  const digest = await subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function normalizeSha256(value: string | undefined): string | undefined {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^sha256:/, '');
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : undefined;
}

function safeAssetStem(value: string | undefined): string {
  const normalized = String(value || 'keyframe')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return normalized || 'keyframe';
}

function normalizeVaultPath(value: string): string {
  return value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/{2,}/g, '/');
}

function containsTraversal(path: string): boolean {
  return path.split('/').some((part) => part === '..' || part === '.');
}

function boundedInteger(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(value as number)));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].slice(0, 50);
}

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\r?\n/g, ' ')
    .slice(0, 240);
}
