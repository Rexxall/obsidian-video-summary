import { canonicalSourceIdentity, sha256Hex, stableArtifactId } from './ArtifactStore';

export const CAPTURE_INBOX_SCHEMA_VERSION = 1;

export type CaptureInboxAction = 'capture-only' | 'capture-and-process';
export type CapturePlatform = 'youtube' | 'bilibili' | 'web' | 'local';
export type CaptureStatus = 'inbox' | 'processing';

export interface CaptureInboxInput {
  url?: string;
  local_file?: string;
  title?: string;
  action: CaptureInboxAction;
  output_folder?: string;
  captured_at?: string;
}

export interface CanonicalCaptureSource {
  identity: string;
  source_hash: string;
  artifact_id: string;
  source_type: 'video';
  platform: CapturePlatform;
  canonical_url?: string;
  local_file?: string;
  source_id?: string;
}

export type CapturePropertyValue = string | boolean | null | string[];

export interface CaptureNoteDraft {
  schema_version: number;
  source: CanonicalCaptureSource;
  action: CaptureInboxAction;
  path: string;
  title: string;
  properties: Record<string, CapturePropertyValue>;
  content: string;
}

export interface CaptureInboxEntry {
  path: string;
  source_hash: string;
  source_identity: string;
  status?: string;
}

export interface CaptureInboxRepositoryResult {
  created: boolean;
  entry: CaptureInboxEntry;
}

/**
 * Implementations must perform source_hash lookup and creation as one logical
 * operation. This lets capture callers avoid duplicate notes even when two
 * capture requests arrive together.
 */
export interface CaptureInboxRepository {
  putIfAbsent(sourceHash: string, draft: CaptureNoteDraft): Promise<CaptureInboxRepositoryResult>;
}

export interface CaptureInboxResult {
  status: 'created' | 'existing';
  action: CaptureInboxAction;
  entry: CaptureInboxEntry;
  draft: CaptureNoteDraft;
  should_process: boolean;
}

export class CaptureInboxError extends Error {
  constructor(message: string) {
    super(`Capture Inbox: ${message}`);
    this.name = 'CaptureInboxError';
  }
}

/**
 * Offline capture coordinator. Canonicalization, dedupe and note generation do
 * not fetch the source URL; network processing is a separate, explicit action.
 */
export class CaptureInbox {
  constructor(private readonly repository: CaptureInboxRepository) {}

  async capture(input: CaptureInboxInput): Promise<CaptureInboxResult> {
    const draft = await createCaptureNoteDraft(input);
    const stored = await this.repository.putIfAbsent(draft.source.source_hash, draft);
    validateRepositoryResult(stored, draft.source);
    return {
      status: stored.created ? 'created' : 'existing',
      action: input.action,
      entry: { ...stored.entry },
      draft,
      should_process: input.action === 'capture-and-process',
    };
  }
}

export async function createCaptureNoteDraft(input: CaptureInboxInput): Promise<CaptureNoteDraft> {
  validateAction(input.action);
  const capturedAt = normalizeIso(input.captured_at);
  const source = await canonicalizeCaptureSource(input);
  const title = normalizeTitle(input.title, source);
  // Capture succeeds before a backend job exists. JobService changes the
  // status only once a queued job really starts, so an offline backend cannot
  // leave this note permanently claiming it is processing.
  const status: CaptureStatus = 'inbox';
  const properties: Record<string, CapturePropertyValue> = {
    video_summary: true,
    source_type: 'video',
    video_summary_status: status,
    video_review_due: null,
    video_title: title,
    video_platform: source.platform,
    video_source_identity: source.identity,
    video_source_hash: source.source_hash,
    // A predicted id is useful for queue hand-off, but video_artifact_id means
    // a real persisted artifact and must stay empty until processing succeeds.
    video_artifact_id: null,
    video_expected_artifact_id: source.artifact_id,
    video_capture_action: input.action,
    video_captured_at: capturedAt,
    link: source.canonical_url || '',
    local_file: source.local_file || null,
    tags: ['video-summary/inbox'],
  };
  const folder = normalizeVaultFolder(input.output_folder || 'Video Inbox');
  const suffix = source.source_id || source.source_hash.slice(0, 10);
  const filename =
    sanitizeFilename(`${title} - ${suffix}`) || `video-${source.source_hash.slice(0, 10)}`;
  const path = `${folder}/${filename}.md`;
  return {
    schema_version: CAPTURE_INBOX_SCHEMA_VERSION,
    source,
    action: input.action,
    path,
    title,
    properties,
    content: buildCaptureNoteContent(title, properties, source),
  };
}

export async function canonicalizeCaptureSource(
  input: Pick<CaptureInboxInput, 'url' | 'local_file'>,
): Promise<CanonicalCaptureSource> {
  const url = String(input.url || '').trim();
  const localFile = normalizeLocalPath(String(input.local_file || ''));
  if (url && localFile) {
    throw new CaptureInboxError('一次只能捕获 URL 或本地文件，不能同时提供');
  }
  if (!url && !localFile) {
    throw new CaptureInboxError('需要 URL 或本地文件');
  }

  if (localFile) {
    if (!isAbsolutePath(localFile)) {
      throw new CaptureInboxError('本地文件必须使用绝对路径');
    }
    const identity = canonicalSourceIdentity({ local_file: localFile });
    const sourceHash = await sha256Hex(identity);
    return {
      identity,
      source_hash: sourceHash,
      artifact_id: stableArtifactId(sourceHash),
      source_type: 'video',
      platform: 'local',
      local_file: localFile,
      source_id: sourceHash.slice(0, 10),
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CaptureInboxError('URL 必须是完整的 http/https 链接');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new CaptureInboxError('只允许 http/https 链接');
  }
  const identity = canonicalSourceIdentity({ url: parsed.toString() });
  const sourceHash = await sha256Hex(identity);
  const details = captureUrlDetails(identity);
  return {
    identity,
    source_hash: sourceHash,
    artifact_id: stableArtifactId(sourceHash),
    source_type: 'video',
    platform: details.platform,
    canonical_url: details.canonicalUrl,
    source_id: details.sourceId,
  };
}

export function buildCaptureNoteContent(
  title: string,
  properties: Record<string, CapturePropertyValue>,
  source: CanonicalCaptureSource,
): string {
  const frontmatter = Object.entries(properties)
    .map(([key, value]) => `${key}: ${yamlValue(value)}`)
    .join('\n');
  const sourceLink = source.canonical_url
    ? `[打开原视频](${escapeMarkdownDestination(source.canonical_url)})`
    : `本地文件：\`${String(source.local_file || '').replace(/`/g, '\\`')}\``;
  return [
    '---',
    frontmatter,
    '---',
    '',
    `# ${escapeMarkdownText(title)}`,
    '',
    '> [!info] Video Summary Inbox',
    '> 已离线捕获来源；处理、转写和写回会作为后续显式任务执行。',
    '',
    sourceLink,
    '',
  ].join('\n');
}

function captureUrlDetails(identity: string): {
  platform: Exclude<CapturePlatform, 'local'>;
  canonicalUrl: string;
  sourceId?: string;
} {
  if (identity.startsWith('youtube:')) {
    const id = identity.slice('youtube:'.length);
    return {
      platform: 'youtube',
      canonicalUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`,
      sourceId: id,
    };
  }
  if (identity.startsWith('bilibili:')) {
    const match = identity.match(/^bilibili:(BV[0-9A-Za-z]{10}):p(\d+)$/);
    if (!match) throw new CaptureInboxError('B站来源身份格式无效');
    const part = Number(match[2]);
    return {
      platform: 'bilibili',
      canonicalUrl: `https://www.bilibili.com/video/${match[1]}${part > 1 ? `?p=${part}` : ''}`,
      sourceId: part > 1 ? `${match[1]}-p${part}` : match[1],
    };
  }
  if (identity.startsWith('url:')) {
    const canonicalUrl = identity.slice('url:'.length);
    return { platform: 'web', canonicalUrl };
  }
  throw new CaptureInboxError('无法识别来源身份');
}

function validateRepositoryResult(
  result: CaptureInboxRepositoryResult,
  source: CanonicalCaptureSource,
): void {
  if (!result || typeof result.created !== 'boolean' || !result.entry) {
    throw new CaptureInboxError('repository 返回了无效结果');
  }
  if (!result.entry.path?.trim()) {
    throw new CaptureInboxError('repository 结果缺少笔记路径');
  }
  if (
    result.entry.source_hash !== source.source_hash ||
    result.entry.source_identity !== source.identity
  ) {
    throw new CaptureInboxError('repository 返回的来源身份与请求不一致');
  }
}

function normalizeTitle(value: string | undefined, source: CanonicalCaptureSource): string {
  const title = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (title) return title.slice(0, 160);
  if (source.platform === 'youtube') return `YouTube ${source.source_id}`;
  if (source.platform === 'bilibili') return `Bilibili ${source.source_id}`;
  if (source.platform === 'local') {
    const filename = source.local_file?.split('/').pop()?.trim();
    return filename || `本地视频 ${source.source_id}`;
  }
  return `视频链接 ${source.source_hash.slice(0, 10)}`;
}

function normalizeVaultFolder(value: string): string {
  const raw = String(value || '').trim();
  if (
    raw.startsWith('/') ||
    raw.startsWith('\\') ||
    raw === '~' ||
    raw.startsWith('~/') ||
    /^[A-Za-z]:[\\/]/.test(raw)
  ) {
    throw new CaptureInboxError('output_folder 必须是安全的 vault 相对路径');
  }
  const normalized = raw
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/{2,}/g, '/');
  if (
    !normalized ||
    normalized.split('/').some((part) => part === '.' || part === '..' || !part.trim())
  ) {
    throw new CaptureInboxError('output_folder 必须是安全的 vault 相对路径');
  }
  return normalized;
}

function sanitizeFilename(value: string): string {
  return value
    .replace(/[\\/:*?"<>|#^[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^\.+|\.+$/g, '')
    .trim()
    .slice(0, 120)
    .trim();
}

function normalizeLocalPath(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/\/$/, '');
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:\//.test(value);
}

function normalizeIso(value: string | undefined): string {
  if (!value) return new Date().toISOString();
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new CaptureInboxError('captured_at 必须是有效日期');
  return new Date(timestamp).toISOString();
}

function validateAction(value: CaptureInboxAction): void {
  if (value !== 'capture-only' && value !== 'capture-and-process') {
    throw new CaptureInboxError(`不支持的 action: ${String(value)}`);
  }
}

function yamlValue(value: CapturePropertyValue): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return JSON.stringify(value);
}

function escapeMarkdownText(value: string): string {
  return value.replace(/([\\`*_{}[\]<>()#+\-.!|])/g, '\\$1');
}

function escapeMarkdownDestination(value: string): string {
  return value.replace(/</g, '%3C').replace(/>/g, '%3E').replace(/\r?\n/g, '');
}
