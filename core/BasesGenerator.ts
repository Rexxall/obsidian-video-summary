import { stableHash } from './KnowledgeModel';

export const VIDEO_SUMMARY_BASE_VERSION = 1;
export const VIDEO_SUMMARY_BASE_MARKER = '# video-summary-base: managed';

export type BaseUpsertStrategy = 'preserve-user' | 'replace-managed' | 'force';
export type BaseUpsertStatus = 'created' | 'unchanged' | 'updated' | 'preserved';

export interface VideoSummaryBaseOptions {
  /** Optional vault-relative folder restriction. */
  folder?: string;
}

export interface BaseUpsertResult {
  status: BaseUpsertStatus;
  content: string;
  generated_content: string;
  reason: string;
  previous_version?: number;
}

interface ManagedBaseHeader {
  version: number;
  signature: string;
  body: string;
}

/**
 * Generate an Obsidian Bases YAML file with five operational table views.
 * The comment header is legal YAML and lets upsert distinguish generated files
 * from user-authored `.base` files.
 */
export function generateVideoSummaryBase(options: VideoSummaryBaseOptions = {}): string {
  const body = buildBaseBody(options);
  const signature = stableHash(body);
  return [
    VIDEO_SUMMARY_BASE_MARKER,
    `# video-summary-base-version: ${VIDEO_SUMMARY_BASE_VERSION}`,
    `# video-summary-base-signature: ${signature}`,
    '',
    body,
  ].join('\n');
}

/**
 * Safe default: create a missing file and update an unchanged managed file,
 * but preserve any unmarked or manually modified Base. Destructive replacement
 * requires an explicit strategy from the caller.
 */
export function upsertVideoSummaryBase(
  existing: string | null | undefined,
  options: VideoSummaryBaseOptions = {},
  strategy: BaseUpsertStrategy = 'preserve-user',
): BaseUpsertResult {
  const generated = generateVideoSummaryBase(options);
  if (!existing || !existing.trim()) {
    return {
      status: 'created',
      content: generated,
      generated_content: generated,
      reason: '目标文件不存在，创建受管 Base。',
    };
  }
  if (existing === generated) {
    return {
      status: 'unchanged',
      content: existing,
      generated_content: generated,
      reason: '受管 Base 已是最新版本。',
      previous_version: VIDEO_SUMMARY_BASE_VERSION,
    };
  }
  if (strategy === 'force') {
    return {
      status: 'updated',
      content: generated,
      generated_content: generated,
      reason: '调用方显式选择 force，替换现有 Base。',
      previous_version: parseManagedBaseHeader(existing)?.version,
    };
  }

  const header = parseManagedBaseHeader(existing);
  if (!header) {
    return {
      status: 'preserved',
      content: existing,
      generated_content: generated,
      reason: '现有 Base 没有受管标记，按默认策略保留用户文件。',
    };
  }
  if (header.version > VIDEO_SUMMARY_BASE_VERSION) {
    return {
      status: 'preserved',
      content: existing,
      generated_content: generated,
      reason: '现有 Base 来自更高版本，拒绝降级覆盖。',
      previous_version: header.version,
    };
  }
  const bodyUnchanged = stableHash(header.body) === header.signature;
  if (!bodyUnchanged && strategy !== 'replace-managed') {
    return {
      status: 'preserved',
      content: existing,
      generated_content: generated,
      reason: '受管 Base 已被用户修改，默认不静默覆盖。',
      previous_version: header.version,
    };
  }
  return {
    status: 'updated',
    content: generated,
    generated_content: generated,
    reason: bodyUnchanged
      ? '旧受管 Base 未被修改，安全升级。'
      : '调用方显式选择 replace-managed，替换已修改的受管 Base。',
    previous_version: header.version,
  };
}

export function parseManagedBaseHeader(content: string): ManagedBaseHeader | undefined {
  const match = content.match(
    /^# video-summary-base: managed\r?\n# video-summary-base-version: (\d+)\r?\n# video-summary-base-signature: ([a-f0-9]{8})\r?\n\r?\n/,
  );
  if (!match) return undefined;
  return {
    version: Number(match[1]),
    signature: match[2],
    body: content.slice(match[0].length),
  };
}

function buildBaseBody(options: VideoSummaryBaseOptions): string {
  const globalFilters = [
    `    - 'file.ext == "md"'`,
    `    - 'video_summary == true'`,
    `    - 'source_type == "video"'`,
  ];
  const folder = normalizeVideoSummaryBaseFolder(options.folder);
  if (folder) {
    const escaped = folder.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    globalFilters.push(`    - 'file.inFolder("${escaped}")'`);
  }

  const lines = [
    'filters:',
    '  and:',
    ...globalFilters,
    'properties:',
    '  video_summary:',
    '    displayName: Video Summary',
    '  source_type:',
    '    displayName: Source Type',
    '  video_summary_status:',
    '    displayName: Status',
    '  video_review_due:',
    '    displayName: Review Due',
    '  video_learning_items:',
    '    displayName: Learning Items',
    '  video_title:',
    '    displayName: Title',
    '  video_platform:',
    '    displayName: Platform',
    '  video_attention_action:',
    '    displayName: Attention',
    '  video_content_type:',
    '    displayName: Content Type',
    '  video_artifact_id:',
    '    displayName: Artifact',
    '  video_expected_artifact_id:',
    '    displayName: Expected Artifact',
    '  link:',
    '    displayName: Source',
    'views:',
  ];
  appendStatusView(lines, 'Inbox', ['inbox', 'pending']);
  appendStatusView(lines, 'Processing', ['processing', 'running']);
  appendReadyView(lines);
  appendStatusView(lines, 'Error', ['error']);
  appendReviewView(lines);
  return `${lines.join('\n')}\n`;
}

function appendStatusView(lines: string[], name: string, statuses: string[]): void {
  lines.push(
    '  - type: table',
    `    name: ${name}`,
    '    filters:',
    statuses.length === 1 ? '      and:' : '      or:',
    ...statuses.map((status) => `        - 'video_summary_status == "${status}"'`),
    '    order:',
    '      - file.name',
    '      - video_summary_status',
    '      - video_title',
    '      - video_platform',
    '      - video_content_type',
    '      - video_attention_action',
    '      - video_review_due',
    '      - link',
    '    sort:',
    '      - property: file.mtime',
    '        direction: DESC',
  );
}

function appendReadyView(lines: string[]): void {
  lines.push(
    '  - type: table',
    '    name: Ready',
    '    filters:',
    '      or:',
    `        - 'video_summary_status == "ready"'`,
    `        - 'video_summary_status == "success"'`,
    `        - 'video_artifact_id != null'`,
    '    order:',
    '      - file.name',
    '      - video_summary_status',
    '      - video_title',
    '      - video_platform',
    '      - video_content_type',
    '      - video_attention_action',
    '      - video_review_due',
    '      - video_artifact_id',
    '      - link',
    '    sort:',
    '      - property: file.mtime',
    '        direction: DESC',
  );
}

function appendReviewView(lines: string[]): void {
  lines.push(
    '  - type: table',
    '    name: Review',
    '    filters:',
    '      or:',
    `        - 'video_summary_status == "review"'`,
    '        - and:',
    `            - 'video_review_due != null'`,
    `            - 'video_review_due <= now()'`,
    '    order:',
    '      - file.name',
    '      - video_review_due',
    '      - video_learning_items',
    '      - video_summary_status',
    '      - video_title',
    '      - video_platform',
    '      - video_artifact_id',
    '      - link',
    '    sort:',
    '      - property: video_review_due',
    '        direction: ASC',
    '      - property: file.mtime',
    '        direction: DESC',
  );
}

export function normalizeVideoSummaryBaseFolder(value: string | undefined): string {
  if (!value) return '';
  const raw = value.trim();
  if (
    raw.startsWith('/') ||
    raw.startsWith('\\') ||
    raw === '~' ||
    raw.startsWith('~/') ||
    /^[A-Za-z]:[\\/]/.test(raw)
  ) {
    throw new Error('Base folder must be a safe vault-relative path');
  }
  const normalized = raw
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/{2,}/g, '/');
  if (!normalized || normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Base folder must be a safe vault-relative path');
  }
  return normalized;
}
