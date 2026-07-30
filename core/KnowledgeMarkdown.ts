import {
  AttentionRange,
  EvidenceClaim,
  EvidenceSourceType,
  ProcessingMode,
  ProcessingResult,
  VideoSegment,
  VisualEvidence,
} from '../types';
import * as yaml from 'js-yaml';
import { buildTimestampUrl, formatTimestamp, stableHash } from './KnowledgeModel';

export type ManagedBlockKind = 'generated' | 'evidence' | 'attention' | 'learning';
export type SafeFrontmatterScalar = string | number | boolean | null;

export interface ManagedKnowledgeWriteOptions {
  updateGenerated?: boolean;
  updateEvidence?: boolean;
  updateAttention?: boolean;
  updateLearning?: boolean;
}

const SOURCE_LABELS: Record<EvidenceSourceType, string> = {
  speech: '口述',
  screen: '屏幕',
  comment: '评论',
  user: '用户',
  'ai-inference': 'AI 推断',
};

export function upsertManagedBlock(body: string, kind: ManagedBlockKind, markdown: string): string {
  const start = `<!-- video-summary-${kind}:start -->`;
  const end = `<!-- video-summary-${kind}:end -->`;
  const expression = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`, 'g');
  const cleanMarkdown = markdown.trim();
  const replacement = cleanMarkdown ? `${start}\n${cleanMarkdown}\n${end}` : '';

  if (expression.test(body)) return body.replace(expression, replacement);
  if (!replacement) return body;

  const withoutPlaceholder = removeLegacyPlaceholder(body, kind);
  if (!withoutPlaceholder) return `${replacement}\n`;
  const separator = withoutPlaceholder.endsWith('\n\n')
    ? ''
    : withoutPlaceholder.endsWith('\n')
      ? '\n'
      : '\n\n';
  return `${withoutPlaceholder}${separator}${replacement}\n`;
}

/**
 * Pure Markdown transform shared by new-note creation and reprocessing.
 * Only marker-delimited plugin blocks are replaced; everything outside them is
 * byte-for-byte preserved.
 */
export function writeManagedKnowledgeMarkdown(
  body: string,
  result: ProcessingResult,
  sourceUrl = '',
  options: ManagedKnowledgeWriteOptions = {},
): string {
  const {
    updateGenerated = true,
    updateEvidence = true,
    updateAttention = true,
    updateLearning = true,
  } = options;
  let next = body;
  if (updateGenerated) {
    next = upsertManagedBlock(next, 'generated', renderGeneratedMarkdown(result));
  }
  if (updateEvidence) {
    const hasEvidence =
      !!result.video_segments?.length ||
      !!result.evidence_claims?.length ||
      !!result.visual_evidence?.length;
    next = upsertManagedBlock(
      next,
      'evidence',
      hasEvidence ? renderEvidenceMarkdown(result, sourceUrl) : '',
    );
  }
  if (updateAttention) {
    next = upsertManagedBlock(
      next,
      'attention',
      result.attention ? renderAttentionMarkdown(result, sourceUrl) : '',
    );
  }
  if (updateLearning) {
    next = upsertManagedBlock(
      next,
      'learning',
      result.learning ? renderLearningMarkdown(result) : '',
    );
  }
  return next;
}

export function managedWriteOptionsForMode(mode: ProcessingMode): ManagedKnowledgeWriteOptions {
  if (mode === 'summary') return {};
  if (mode === 'transcript-only') {
    return {
      updateGenerated: false,
      updateEvidence: true,
      updateAttention: false,
      updateLearning: false,
    };
  }
  return {
    updateGenerated: false,
    updateEvidence: false,
    updateAttention: false,
    updateLearning: false,
  };
}

/**
 * Rich result objects stay in the sidecar artifact. Frontmatter receives only
 * query-friendly scalar projections so YAML remains portable and safe.
 */
export function buildRichFrontmatterFields(
  result: ProcessingResult,
): Record<string, SafeFrontmatterScalar> {
  const fields: Record<string, SafeFrontmatterScalar> = {};
  assignNonEmptyString(fields, 'video_title', result.video_title);
  assignNonEmptyString(fields, 'video_author', result.video_author);
  assignNonEmptyString(fields, 'video_duration', result.video_duration);
  assignNonEmptyString(fields, 'video_cover', result.video_cover);
  assignNonEmptyString(fields, 'summary', result.summary);
  assignNonEmptyString(fields, 'video_transcript', result.video_transcript);
  assignNonEmptyString(fields, 'video_artifact_id', result.artifact?.artifact_id);
  assignNonEmptyString(fields, 'video_content_type', result.content_type);
  assignNonEmptyString(fields, 'video_attention_action', result.attention?.action);
  assignNonEmptyString(fields, 'video_processing_depth', result.artifact?.processing_depth);
  const learningItems =
    (result.learning?.flashcards?.length || 0) + (result.learning?.questions?.length || 0);
  if (learningItems > 0) fields.video_learning_items = learningItems;
  return fields;
}

export function serializeScalarFrontmatter(fields: Record<string, SafeFrontmatterScalar>): string {
  for (const [key, value] of Object.entries(fields)) {
    if (!isSafeFrontmatterScalar(value)) {
      throw new TypeError(`Frontmatter field "${key}" must be a scalar value.`);
    }
  }
  return yaml
    .dump(fields, {
      lineWidth: 1000,
      noRefs: true,
      sortKeys: false,
    })
    .trimEnd();
}

export function renderGeneratedMarkdown(result: ProcessingResult): string {
  return (result.note || result.summary || '').trim();
}

export function renderEvidenceMarkdown(
  result: ProcessingResult,
  sourceUrl = '',
  limits: { claims?: number; segments?: number; visual?: number } = {},
): string {
  const claims = (result.evidence_claims || []).slice(0, limits.claims ?? 20);
  const segments = result.video_segments || [];
  const segmentById = new Map(segments.map((segment) => [segment.id, segment]));
  const visual = (result.visual_evidence || []).slice(0, limits.visual ?? 12);
  const lines: string[] = ['## 证据地图'];
  const allowTimestamps = result.timing_quality !== 'none';

  if (result.timing_quality === 'none') {
    lines.push(
      '',
      '> [!warning] 当前文稿没有可靠时间轴',
      '> 文本仍可核对，但插件不会伪造可点击的时间戳。',
    );
  } else if (result.timing_quality === 'estimated') {
    lines.push('', '> [!warning] 部分时间点为估算值', '> 引用前请回看原视频确认。');
  }

  const warnings = result.artifact?.warnings || [];
  if (warnings.length > 0) {
    lines.push('', '> [!info] 处理限制');
    warnings.slice(0, 5).forEach((warning) => lines.push(`> - ${escapeInline(warning)}`));
  }

  if (claims.length > 0) {
    lines.push('', '### 关键主张');
    claims.forEach((claim) => renderClaim(lines, claim, segmentById, sourceUrl, allowTimestamps));
  } else if (segments.length > 0) {
    lines.push('', '### 可核对片段');
    segments.slice(0, limits.segments ?? 40).forEach((segment) => {
      const prefix = segmentLink(segment, sourceUrl, allowTimestamps);
      lines.push(`- ${prefix} ${escapeInline(segment.text)} ^${segment.id}`);
      const meta = segmentMeta(segment);
      if (meta) lines.push(`  - ${meta}`);
    });
  } else {
    lines.push('', '> [!info] 这次结果没有返回结构化证据。');
  }

  if (visual.length > 0) {
    lines.push('', '### 画面证据');
    visual.forEach((item) => renderVisual(lines, item, sourceUrl, allowTimestamps));
  }

  return lines.join('\n');
}

export function renderAttentionMarkdown(result: ProcessingResult, sourceUrl = ''): string {
  const assessment = result.attention;
  if (!assessment) return '';
  const actionLabel = {
    watch: '值得观看',
    skim: '建议选段浏览',
    skip: '可以跳过',
  }[assessment.action];
  const lines = [
    '## 观看价值判断',
    '',
    `> [!summary] ${actionLabel}`,
    `> ${escapeInline(assessment.rationale)}`,
  ];
  const metrics = [
    ['综合分', assessment.score],
    ['置信度', assessment.confidence],
    ['信息密度', assessment.information_density],
    ['原创性', assessment.originality],
    ['可操作性', assessment.actionability],
    ['与当前知识库相关度', assessment.vault_relevance],
    ['推广内容占比', assessment.promotional_ratio],
  ].filter((item): item is [string, number] => typeof item[1] === 'number');
  if (metrics.length > 0) {
    lines.push('', '| 维度 | 结果 |', '| --- | ---: |');
    metrics.forEach(([label, value]) => lines.push(`| ${label} | ${Math.round(value * 100)}% |`));
  }
  if (assessment.estimated_useful_seconds !== undefined) {
    lines.push('', `预计高价值内容：约 ${formatDuration(assessment.estimated_useful_seconds)}`);
  }
  const allowTimestamps = result.timing_quality !== 'none';
  appendRanges(lines, '建议观看', assessment.must_watch, sourceUrl, allowTimestamps);
  appendRanges(lines, '可以略过', assessment.skippable, sourceUrl, allowTimestamps);
  if (assessment.limitations?.length) {
    lines.push('', '### 判断限制');
    assessment.limitations.forEach((item) => lines.push(`- ${escapeInline(item)}`));
  }
  return lines.join('\n');
}

export function renderLearningMarkdown(result: ProcessingResult): string {
  const learning = result.learning;
  if (!learning) return '';
  const lines: string[] = ['## 学习练习'];
  if (learning.flashcards?.length) {
    lines.push('', '### 闪卡');
    learning.flashcards.forEach((card) => {
      lines.push(`- **问：${escapeInline(card.front)}** ^${sanitizeBlockId(card.id)}`);
      lines.push(`  - 答：${escapeInline(card.back)}`);
      if (card.evidence_segment_ids?.length) {
        lines.push(`  - 证据：${card.evidence_segment_ids.map((id) => `#^${id}`).join('、')}`);
      }
    });
  }
  if (learning.questions?.length) {
    lines.push('', '### 自测题');
    learning.questions.forEach((question, index) => {
      lines.push(`${index + 1}. ${escapeInline(question.prompt)} ^${sanitizeBlockId(question.id)}`);
      if (question.choices?.length) {
        question.choices.forEach((choice) => lines.push(`   - ${escapeInline(choice)}`));
      }
      lines.push(`   - 答案：||${escapeInline(question.answer)}||`);
      if (question.explanation) lines.push(`   - 解释：${escapeInline(question.explanation)}`);
    });
  }
  if (learning.feynman_prompts?.length) {
    lines.push('', '### 费曼解释');
    learning.feynman_prompts.forEach((prompt) => lines.push(`- [ ] ${escapeInline(prompt)}`));
  }
  return lines.join('\n');
}

function renderClaim(
  lines: string[],
  claim: EvidenceClaim,
  segments: Map<string, VideoSegment>,
  sourceUrl: string,
  allowTimestamps: boolean,
) {
  const firstSegment = claim.evidence
    .map((reference) => segments.get(reference.segment_id))
    .find(Boolean);
  const start = allowTimestamps ? (claim.start ?? firstSegment?.start ?? null) : null;
  const timestampUrl = buildTimestampUrl(sourceUrl, start);
  const timestamp =
    start === null
      ? '文本证据'
      : timestampUrl
        ? `[${formatTimestamp(start)}](${timestampUrl})`
        : formatTimestamp(start);
  const review =
    claim.review_state === 'needs-review'
      ? ' · **需复核**'
      : claim.review_state === 'inference'
        ? ' · AI 推断'
        : '';
  lines.push(`- ${timestamp} ${escapeInline(claim.claim)}${review} ^${sanitizeBlockId(claim.id)}`);
  if (claim.evidence.length === 0) {
    lines.push('  - 没有可验证的来源引用');
    return;
  }
  claim.evidence.forEach((reference) => {
    const segment = segments.get(reference.segment_id);
    const label = SOURCE_LABELS[reference.source];
    const quote = reference.quote || segment?.text;
    const segmentTimestamp = segment
      ? segmentLink(segment, sourceUrl, allowTimestamps)
      : '来源缺失';
    lines.push(`  - ${label} · ${segmentTimestamp}${quote ? `：${escapeInline(quote)}` : ''}`);
  });
}

function renderVisual(
  lines: string[],
  item: VisualEvidence,
  sourceUrl: string,
  allowTimestamps: boolean,
) {
  if (!allowTimestamps) {
    lines.push(
      `- 画面证据（时间未对齐） ${escapeInline(item.description)} ^${sanitizeBlockId(item.id)}`,
    );
    if (item.ocr_text) lines.push(`  - 屏幕文字：${escapeInline(item.ocr_text)}`);
    appendKeyframe(lines, item);
    return;
  }
  const timestampUrl = buildTimestampUrl(sourceUrl, item.start);
  const timestamp = timestampUrl
    ? `[${formatTimestamp(item.start)}](${timestampUrl})`
    : formatTimestamp(item.start);
  lines.push(`- ${timestamp} ${escapeInline(item.description)} ^${sanitizeBlockId(item.id)}`);
  if (item.ocr_text) lines.push(`  - 屏幕文字：${escapeInline(item.ocr_text)}`);
  appendKeyframe(lines, item);
}

function appendKeyframe(lines: string[], item: VisualEvidence): void {
  const path = item.keyframe?.path?.trim();
  if (path && !isAbsoluteMediaPath(path)) {
    lines.push(`  - ![[${path.replace(/\|/g, '\\|')}]]`);
    return;
  }
  const url = item.keyframe?.url?.trim() || (path ? `file://${encodeURI(path)}` : '');
  if (url) lines.push(`  - ![关键帧](<${escapeMarkdownDestination(url)}>)`);
}

function isAbsoluteMediaPath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path);
}

function escapeMarkdownDestination(value: string): string {
  return value.replace(/</g, '%3C').replace(/>/g, '%3E').replace(/\r?\n/g, '');
}

function segmentLink(segment: VideoSegment, sourceUrl: string, allowTimestamps: boolean): string {
  if (!allowTimestamps || segment.start === null || segment.timing_quality === 'none') {
    return '文本证据';
  }
  const url = segment.timestamp_url || buildTimestampUrl(sourceUrl, segment.start);
  const label = formatTimestamp(segment.start);
  return url ? `[${label}](${url})` : label;
}

function segmentMeta(segment: VideoSegment): string {
  const parts = [SOURCE_LABELS[segment.source]];
  if (segment.speaker) parts.push(segment.speaker);
  if (segment.timing_quality === 'estimated') parts.push('估算时间');
  if (segment.visual_text) parts.push(`屏幕：${escapeInline(segment.visual_text)}`);
  return parts.join(' · ');
}

function appendRanges(
  lines: string[],
  title: string,
  ranges: AttentionRange[] | undefined,
  sourceUrl: string,
  allowTimestamps: boolean,
) {
  if (!Array.isArray(ranges) || ranges.length === 0) return;
  lines.push('', `### ${title}`);
  ranges.forEach((range) => {
    if (!allowTimestamps) {
      lines.push(`- 时间未对齐 · ${escapeInline(range.reason)}`);
      return;
    }
    const url = buildTimestampUrl(sourceUrl, range.start);
    const time = `${formatTimestamp(range.start)}–${formatTimestamp(range.end)}`;
    lines.push(`- ${url ? `[${time}](${url})` : time} ${escapeInline(range.reason)}`);
  });
}

function removeLegacyPlaceholder(body: string, kind: ManagedBlockKind): string {
  if (kind !== 'generated') return body;
  return body.replace(/## 视频内容\s*\n<!-- 视频总结将在这里生成 -->\s*/g, '');
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return minutes > 0 ? `${minutes} 分 ${remainder} 秒` : `${remainder} 秒`;
}

function escapeInline(value: string): string {
  return String(value || '')
    .replace(/\r?\n+/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
}

function sanitizeBlockId(value: string): string {
  const raw = String(value || '').trim();
  const normalized = raw.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!normalized) return `video-evidence-${stableHash(raw || 'missing')}`;
  return normalized === raw ? normalized : `${normalized}-${stableHash(raw)}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function assignNonEmptyString(
  fields: Record<string, SafeFrontmatterScalar>,
  key: string,
  value: unknown,
): void {
  if (typeof value === 'string' && value.trim()) fields[key] = value;
}

function isSafeFrontmatterScalar(value: unknown): value is SafeFrontmatterScalar {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}
