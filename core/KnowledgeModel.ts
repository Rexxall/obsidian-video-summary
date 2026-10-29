import type {
  ArtifactProvenance,
  AttentionAssessment,
  AttentionRange,
  ContentRoutingDecision,
  EvidenceClaim,
  EvidenceReference,
  EvidenceSourceType,
  LearningPackage,
  MediaAssetReference,
  ProcessingDepth,
  ProcessingResult,
  RelatedNoteSuggestion,
  RequestedContentType,
  TimingQuality,
  VideoSegment,
  VisualEvidence,
} from '../types';
import { isExactHostOrSubdomain, safeExternalHttpUrl } from '../utils/SafeExternalUrl';
import { resolveContentRoute } from './ContentRouter';
import { asArray, asRecord, asText, isRecord } from '../utils/json';

export const VIDEO_ARTIFACT_SCHEMA_VERSION = 3;

export interface RichResultContext {
  sourceUrl?: string;
  backend?: string;
  model?: string;
  processingDepth?: ProcessingDepth;
  promptProfile?: string;
  promptVersion?: string;
  requestedContentType?: RequestedContentType;
  autoRoute?: boolean;
  chapters?: unknown;
}

const EVIDENCE_SOURCES = new Set<EvidenceSourceType>([
  'speech',
  'screen',
  'comment',
  'user',
  'ai-inference',
]);

const TIMING_QUALITY = new Set<TimingQuality>(['exact', 'aligned', 'estimated', 'none']);

/**
 * Keep rich backend fields while accepting older flat responses. The function
 * never invents exact timestamps: untimed text receives `timing_quality: none`.
 */
export function normalizeRichProcessingResult(
  base: ProcessingResult,
  payload: unknown,
  context: RichResultContext = {},
): ProcessingResult {
  const p = asRecord(payload);
  const sourceUrl = context.sourceUrl || readString(payload, ['source_url', 'video_url', 'link']);
  const transcript =
    base.video_transcript ||
    readString(payload, ['video_transcript', 'transcript', 'provided_transcript']);
  const rawSegments =
    readArray(payload, ['video_segments', 'segments', 'transcript_segments', 'cues']) ||
    readArray(p.artifact, ['video_segments', 'segments', 'transcript_segments', 'cues']);
  const fallbackQuality = normalizeTimingQuality(
    p.timing_quality || asRecord(p.artifact).timing_quality,
    'none',
  );
  const segments = normalizeSegments(rawSegments, transcript, sourceUrl, fallbackQuality);
  const timingQuality = aggregateTimingQuality(
    segments,
    normalizeTimingQuality(p.timing_quality || asRecord(p.artifact).timing_quality, 'none'),
  );
  const claims = normalizeClaims(
    readArray(payload, ['evidence_claims', 'claims']) ||
      readArray(p.artifact, ['evidence_claims', 'claims']),
    segments,
  );
  const visualEvidence = normalizeVisualEvidence(
    readArray(payload, ['visual_evidence', 'visual_observations', 'keyframes']) ||
      readArray(p.artifact, ['visual_evidence', 'visual_observations', 'keyframes']),
  );
  const backendRouting =
    objectOrUndefined(p.content_routing) ||
    objectOrUndefined(p.routing) ||
    objectOrUndefined(asRecord(p.artifact).content_routing);
  const contentRouting = resolveContentRoute({
    requestedType: context.requestedContentType,
    autoRoute: context.autoRoute,
    backendType:
      p.content_type ||
      p.resolved_content_type ||
      asRecord(p.artifact).content_type ||
      backendRouting?.type ||
      backendRouting?.content_type,
    backendConfidence:
      backendRouting?.confidence ?? p.content_type_confidence ?? p.routing_confidence,
    backendReasons: backendRouting?.reasons ?? p.content_type_reasons ?? p.routing_reasons,
    title: base.video_title || readString(payload, ['video_title', 'title', 'name']),
    author:
      base.video_author ||
      readString(payload, ['video_author', 'author', 'channel', 'creator', 'uploader']),
    transcript,
    chapters: context.chapters || p.video_chapters || p.chapters || asRecord(p.artifact).chapters,
  });
  const attention = normalizeAttention(
    p.attention || p.attention_assessment || asRecord(p.artifact).attention,
  );
  const learning = normalizeLearning(
    p.learning || p.learning_package || asRecord(p.artifact).learning,
  );
  const provenance = normalizeProvenance(
    payload,
    context,
    sourceUrl,
    timingQuality,
    contentRouting,
  );

  return {
    ...base,
    video_id: base.video_id || readString(payload, ['video_id', 'id']),
    video_platform: base.video_platform || readString(payload, ['video_platform', 'platform']),
    video_published_at:
      base.video_published_at || readString(payload, ['video_published_at', 'published_at']),
    transcript_source:
      base.transcript_source ||
      readString(payload, ['transcript_source']) ||
      provenance.transcript_source,
    timing_quality: timingQuality,
    video_segments: segments,
    evidence_claims: claims,
    visual_evidence: visualEvidence,
    content_type: contentRouting.type,
    content_routing: contentRouting,
    attention,
    learning,
    artifact: provenance,
    related_notes: normalizeRelatedNotes(p.related_notes || asRecord(p.artifact).related_notes),
  };
}

export function normalizeSegments(
  rawSegments: unknown[] | undefined,
  transcript = '',
  sourceUrl = '',
  fallbackQuality: TimingQuality = 'none',
): VideoSegment[] {
  const normalized = (rawSegments || [])
    .map((raw, index) => normalizeSegment(raw, index, sourceUrl, fallbackQuality))
    .filter((segment): segment is VideoSegment => segment !== null);

  if (normalized.length > 0) {
    return normalized.sort(compareSegments);
  }

  return parseTranscriptSegments(transcript, sourceUrl);
}

export function parseTranscriptSegments(transcript: string, sourceUrl = ''): VideoSegment[] {
  const text = normalizeText(transcript);
  if (!text) return [];

  const cueSegments = parseCueTranscript(text, sourceUrl);
  if (cueSegments.length > 0) return cueSegments;

  const prefixed = parseTimestampPrefixedTranscript(text, sourceUrl);
  if (prefixed.length > 0) return prefixed;

  return splitUntimedTranscript(text).map((part, index) => ({
    id: stableSegmentId(sourceUrl, null, part, index),
    start: null,
    text: part,
    source: 'speech',
    timing_quality: 'none',
  }));
}

export function stableSegmentId(
  sourceUrl: string,
  start: number | null,
  text: string,
  fallbackIndex = 0,
): string {
  const timing = start === null ? `untimed-${fallbackIndex}` : start.toFixed(3);
  return `vs-${stableHash(`${normalizeSource(sourceUrl)}|${timing}|${normalizeText(text)}`)}`;
}

export function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function buildTimestampUrl(sourceUrl: string, seconds: number | null): string | undefined {
  if (!sourceUrl || seconds === null || !Number.isFinite(seconds) || seconds < 0) return undefined;
  try {
    const safeSource = safeExternalHttpUrl(sourceUrl);
    if (!safeSource) return undefined;
    const url = new URL(safeSource);
    if (
      isExactHostOrSubdomain(url.hostname, 'youtube.com') ||
      url.hostname === 'youtu.be' ||
      isExactHostOrSubdomain(url.hostname, 'bilibili.com')
    ) {
      url.searchParams.set('t', `${Math.floor(seconds)}s`);
      return url.toString();
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function formatTimestamp(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return '--:--';
  }
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${minutes}:${String(secs).padStart(2, '0')}`;
}

function normalizeSegment(
  raw: unknown,
  index: number,
  sourceUrl: string,
  fallbackQuality: TimingQuality,
): VideoSegment | null {
  if (typeof raw === 'string') {
    const text = normalizeText(raw);
    if (!text) return null;
    return {
      id: stableSegmentId(sourceUrl, null, text, index),
      start: null,
      text,
      source: 'speech',
      timing_quality: 'none',
    };
  }
  if (!isRecord(raw)) return null;
  const text = readString(raw, ['text', 'transcript', 'content', 'quote']);
  if (!text) return null;
  const start = readNumber(raw, ['start', 'start_seconds', 'startTime', 'offset']);
  const end = readNumber(raw, ['end', 'end_seconds', 'endTime']);
  const source = normalizeEvidenceSource(raw.source || raw.source_type || raw.kind, 'speech');
  const quality = normalizeTimingQuality(
    raw.timing_quality,
    start === null ? 'none' : fallbackQuality === 'none' ? 'estimated' : fallbackQuality,
  );
  const id =
    readString(raw, ['id', 'segment_id']) || stableSegmentId(sourceUrl, start, text, index);
  return {
    id: sanitizeId(id),
    start,
    end,
    text: normalizeText(text),
    speaker: readString(raw, ['speaker', 'speaker_name', 'speaker_label']),
    source,
    timing_quality: quality,
    timestamp_url:
      safeExternalHttpUrl(readString(raw, ['timestamp_url', 'timestamp_link'])) ||
      buildTimestampUrl(sourceUrl, start),
    keyframe: normalizeAsset(raw.keyframe || raw.asset || raw.image, `${id}-frame`),
    visual_text: readString(raw, ['visual_text', 'ocr_text', 'screen_text']),
    confidence: normalizeRatio(raw.confidence),
  };
}

function parseCueTranscript(text: string, sourceUrl: string): VideoSegment[] {
  const lines = text.split('\n');
  const result: VideoSegment[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const timing = parseTimingLine(lines[index]);
    if (!timing) continue;
    const body: string[] = [];
    index += 1;
    while (index < lines.length && !parseTimingLine(lines[index])) {
      const line = cleanCueText(lines[index]);
      if (line && !/^\d+$/.test(line) && line !== 'WEBVTT') body.push(line);
      if (!lines[index].trim() && body.length > 0) break;
      index += 1;
    }
    const content = normalizeText(body.join(' '));
    if (!content) continue;
    const id = stableSegmentId(sourceUrl, timing.start, content, result.length);
    result.push({
      id,
      start: timing.start,
      end: timing.end,
      text: content,
      source: 'speech',
      timing_quality: 'exact',
      timestamp_url: buildTimestampUrl(sourceUrl, timing.start),
    });
    index -= 1;
  }
  return dedupeRollingCues(result);
}

function parseTimestampPrefixedTranscript(text: string, sourceUrl: string): VideoSegment[] {
  const result: VideoSegment[] = [];
  // Handle pasted captions such as [00:00]first[00:02]second without line breaks.
  const expanded = text.replace(/(\[(?:\d{1,2}:)?\d{1,2}:\d{2}(?:[,.]\d{1,3})?\])\s*/g, '\n$1 ');
  for (const line of expanded.split('\n')) {
    const match = line.match(
      /^\s*(?:\[|\()?((?:\d{1,2}:)?\d{1,2}:\d{2}(?:[,.]\d{1,3})?)(?:\]|\))?\s+(.+)$/,
    );
    if (!match) continue;
    const start = parseClock(match[1]);
    const content = normalizeText(match[2]);
    if (start === null || !content) continue;
    const previous = result[result.length - 1];
    if (previous && previous.end === undefined) previous.end = start;
    const id = stableSegmentId(sourceUrl, start, content, result.length);
    result.push({
      id,
      start,
      text: content,
      source: 'speech',
      timing_quality: 'exact',
      timestamp_url: buildTimestampUrl(sourceUrl, start),
    });
  }
  return result;
}

function normalizeClaims(
  rawClaims: unknown[] | undefined,
  segments: VideoSegment[],
): EvidenceClaim[] {
  const segmentsById = new Map(segments.map((segment) => [segment.id, segment]));
  return (rawClaims || [])
    .map((raw: unknown, index): EvidenceClaim | null => {
      if (!isRecord(raw)) return null;
      const claim = readString(raw, ['claim', 'text', 'summary', 'title']);
      if (!claim) return null;
      const explicitEvidence = Array.isArray(raw.evidence) ? raw.evidence : [];
      const legacyIds = Array.isArray(raw.segment_ids)
        ? raw.segment_ids
        : Array.isArray(raw.evidence_segment_ids)
          ? raw.evidence_segment_ids
          : [];
      const fallbackSource = normalizeEvidenceSource(raw.source || raw.source_type, 'ai-inference');
      let rejectedEvidence = false;
      const evidenceCandidates: Array<EvidenceReference | null> = explicitEvidence.map(
        (item: unknown) => normalizeEvidenceReference(item, fallbackSource),
      );
      const evidence: EvidenceReference[] = evidenceCandidates
        .filter((item: EvidenceReference | null): item is EvidenceReference => {
          if (!item) {
            rejectedEvidence = true;
            return false;
          }
          if (!segmentsById.has(item.segment_id)) {
            rejectedEvidence = true;
            return false;
          }
          return true;
        })
        .filter(
          (item: EvidenceReference, itemIndex: number, items: EvidenceReference[]) =>
            items.findIndex(
              (candidate: EvidenceReference) =>
                candidate.segment_id === item.segment_id && candidate.source === item.source,
            ) === itemIndex,
        );
      for (const segmentId of legacyIds) {
        const rawId = String(segmentId || '').trim();
        if (!rawId) {
          rejectedEvidence = true;
          continue;
        }
        const id = sanitizeId(rawId);
        const segment = segmentsById.get(id);
        if (!segment) {
          rejectedEvidence = true;
          continue;
        }
        if (evidence.some((item) => item.segment_id === id)) continue;
        evidence.push({
          segment_id: id,
          source: segment.source || fallbackSource,
          quote: segment.text,
          asset_id: segment.keyframe?.id,
        });
      }
      const start = readNumber(raw, ['start', 'start_seconds', 'timestamp']);
      if (start !== null) {
        const nearest = nearestSegment(segments, start);
        if (evidence.length === 0 && nearest) {
          evidence.push({
            segment_id: nearest.id,
            source: nearest.source,
            quote: nearest.text,
            asset_id: nearest.keyframe?.id,
          });
        } else if (
          !nearest ||
          (evidence.length > 0 && !evidence.some((item) => item.segment_id === nearest.id))
        ) {
          // A timestamp is not evidence by itself. Never bind a wildly
          // out-of-range model timestamp to whichever segment happens to be
          // closest in the transcript.
          rejectedEvidence = true;
        }
      }
      const id =
        readString(raw, ['id', 'claim_id']) ||
        `claim-${stableHash(`${claim}|${evidence.map((item) => item.segment_id).join('|')}|${index}`)}`;
      const reviewState: EvidenceClaim['review_state'] =
        rejectedEvidence || (explicitEvidence.length > 0 && evidence.length === 0)
          ? 'needs-review'
          : normalizeReviewState(raw.review_state, fallbackSource);
      return {
        id: sanitizeId(id),
        claim: normalizeText(claim),
        evidence,
        start,
        end: readNumber(raw, ['end', 'end_seconds']),
        confidence: normalizeRatio(raw.confidence),
        review_state: reviewState,
      } satisfies EvidenceClaim;
    })
    .filter((claim): claim is EvidenceClaim => claim !== null);
}

function normalizeVisualEvidence(rawItems: unknown[] | undefined): VisualEvidence[] {
  return (rawItems || [])
    .map((raw: unknown, index): VisualEvidence | null => {
      if (!isRecord(raw)) return null;
      const description = readString(raw, ['description', 'text', 'caption', 'summary']);
      const ocrText = readString(raw, ['ocr_text', 'visual_text', 'screen_text']);
      if (!description && !ocrText) return null;
      const start = readNumber(raw, ['start', 'start_seconds', 'timestamp']);
      if (start === null) return null;
      const id =
        readString(raw, ['id', 'evidence_id']) ||
        `visual-${stableHash(`${start}|${description}|${ocrText}|${index}`)}`;
      return {
        id: sanitizeId(id),
        start,
        end: readNumber(raw, ['end', 'end_seconds']) ?? undefined,
        description: normalizeText(description || ocrText),
        ocr_text: ocrText || undefined,
        keyframe: normalizeAsset(raw.keyframe || raw.asset || raw.image, `${id}-frame`),
        kind: normalizeVisualKind(raw.kind || raw.type),
        confidence: normalizeRatio(raw.confidence),
      } satisfies VisualEvidence;
    })
    .filter((item): item is VisualEvidence => item !== null);
}

function normalizeAttention(raw: unknown): AttentionAssessment | undefined {
  if (!isRecord(raw)) return undefined;
  const action = oneOf(raw.action, ['watch', 'skim', 'skip'] as const);
  const rationale = readString(raw, ['rationale', 'reason', 'summary']);
  if (!action || !rationale) return undefined;
  return {
    action,
    score: normalizeRatio(raw.score),
    confidence: normalizeRatio(raw.confidence),
    rationale,
    context: readString(raw, ['context', 'relevance_context']),
    information_density: normalizeRatio(raw.information_density),
    originality: normalizeRatio(raw.originality),
    actionability: normalizeRatio(raw.actionability),
    vault_relevance: normalizeRatio(raw.vault_relevance),
    promotional_ratio: normalizeRatio(raw.promotional_ratio),
    estimated_useful_seconds:
      readNumber(raw, ['estimated_useful_seconds', 'useful_seconds']) ?? undefined,
    evidence_segment_ids: normalizeStringArray(raw.evidence_segment_ids),
    limitations: normalizeStringArray(raw.limitations),
    must_watch: normalizeAttentionRanges(raw.must_watch),
    skippable: normalizeAttentionRanges(raw.skippable),
  };
}

function normalizeLearning(raw: unknown): LearningPackage | undefined {
  if (!isRecord(raw)) return undefined;
  const flashcards = Array.isArray(raw.flashcards)
    ? asArray(raw.flashcards)
        .map(asRecord)
        .map((item) => {
          const front = readString(item, ['front', 'question', 'prompt']);
          const back = readString(item, ['back', 'answer']);
          if (!front || !back) return null;
          const providerId = readString(item, ['id']);
          return {
            id: `card-${stableHash(`${normalizeText(front)}|${normalizeText(back)}`)}`,
            provider_id: providerId || undefined,
            front,
            back,
            evidence_segment_ids: normalizeStringArray(item.evidence_segment_ids),
            tags: normalizeStringArray(item.tags),
          };
        })
        .filter(Boolean)
    : undefined;
  const questions = Array.isArray(raw.questions)
    ? asArray(raw.questions)
        .map(asRecord)
        .map((item) => {
          const prompt = readString(item, ['prompt', 'question']);
          const rawAnswer = readString(item, ['answer', 'correct_answer']);
          const choices = normalizeStringArray(item.choices);
          const answer = resolveChoiceAnswer(rawAnswer, choices);
          if (!prompt || !answer) return null;
          const difficulty = oneOf(item.difficulty, ['easy', 'medium', 'hard'] as const);
          const providerId = readString(item, ['id']);
          return {
            id: `question-${stableHash(`${normalizeText(prompt)}|${normalizeText(answer)}`)}`,
            provider_id: providerId || undefined,
            prompt,
            choices,
            answer,
            explanation: readString(item, ['explanation', 'rationale']),
            evidence_segment_ids: normalizeStringArray(item.evidence_segment_ids),
            difficulty,
          };
        })
        .filter(Boolean)
    : undefined;
  const feynmanPrompts = normalizeStringArray(raw.feynman_prompts);
  if (!flashcards?.length && !questions?.length && !feynmanPrompts?.length) return undefined;
  return {
    flashcards: flashcards as LearningPackage['flashcards'],
    questions: questions as LearningPackage['questions'],
    feynman_prompts: feynmanPrompts,
  };
}

function resolveChoiceAnswer(answer: string, choices: string[] | undefined): string {
  const raw = String(answer || '').trim();
  if (!raw || !choices?.length) return raw;
  const normalized = raw.normalize('NFKC');
  const label = normalized.match(/^([A-Ha-h]|[1-9])(?:[.、:：)\]\s]|$)/)?.[1];
  if (!label) return raw;
  const index = /^\d$/.test(label)
    ? Number(label) - 1
    : label.toUpperCase().charCodeAt(0) - 'A'.charCodeAt(0);
  return choices[index] || raw;
}

function normalizeProvenance(
  payload: unknown,
  context: RichResultContext,
  sourceUrl: string,
  timingQuality: TimingQuality,
  contentRouting: ContentRoutingDecision,
): ArtifactProvenance {
  const source = asRecord(payload);
  const raw = asRecord(
    asRecord(source.artifact).provenance || source.provenance || source.artifact,
  );
  const sourceHash = readString(raw, ['source_hash']) || stableHash(normalizeSource(sourceUrl));
  const warnings = normalizeStringArray(raw.warnings) ?? [];
  if (timingQuality === 'estimated') {
    warnings?.push('部分时间点为估算值，引用前应回看原视频。');
  }
  if (timingQuality === 'none') {
    warnings?.push('当前文稿没有可靠时间轴，未生成可点击证据时间点。');
  }
  return {
    schema_version: VIDEO_ARTIFACT_SCHEMA_VERSION,
    artifact_id: readString(raw, ['artifact_id', 'id']),
    source_url: sourceUrl || undefined,
    source_hash: sourceHash,
    transcript_hash: readString(raw, ['transcript_hash']),
    backend: normalizeBackend(raw.backend || context.backend),
    model: readString(raw, ['model']) || context.model,
    prompt_profile:
      readString(raw, ['prompt_profile']) ||
      contentRouting.prompt_profile.id ||
      context.promptProfile,
    prompt_version: readString(raw, ['prompt_version']) || context.promptVersion,
    processing_depth:
      normalizeProcessingDepth(raw.processing_depth || context.processingDepth) ||
      context.processingDepth,
    content_routing: {
      source: contentRouting.source,
      confidence: contentRouting.confidence,
      reasons: contentRouting.reasons.map((reason) => reason.message),
      prompt_profile: contentRouting.prompt_profile.id,
    },
    generated_at: readString(raw, ['generated_at']) || new Date().toISOString(),
    transcript_source: readString(raw, ['transcript_source', 'source']),
    warnings: warnings.length > 0 ? Array.from(new Set(warnings)) : undefined,
  };
}

function normalizeEvidenceReference(
  raw: unknown,
  fallbackSource: EvidenceSourceType,
): EvidenceReference | null {
  if (typeof raw === 'string') {
    const segmentId = raw.trim();
    return segmentId ? { segment_id: sanitizeId(segmentId), source: fallbackSource } : null;
  }
  if (!isRecord(raw)) return null;
  const segmentId = readString(raw, ['segment_id', 'id']);
  if (!segmentId) return null;
  return {
    segment_id: sanitizeId(segmentId),
    source: normalizeEvidenceSource(raw.source || raw.source_type, fallbackSource),
    quote: readString(raw, ['quote', 'text']),
    asset_id: readString(raw, ['asset_id', 'keyframe_id']),
  };
}

function normalizeAsset(raw: unknown, fallbackId: string): MediaAssetReference | undefined {
  if (!raw) return undefined;
  if (typeof raw === 'string') {
    const url = safeExternalHttpUrl(raw);
    return url ? { id: sanitizeId(fallbackId), url } : undefined;
  }
  if (typeof raw !== 'object') return undefined;
  const url = safeExternalHttpUrl(readString(raw, ['url', 'source_url']));
  if (!url) return undefined;
  return {
    id: sanitizeId(readString(raw, ['id', 'asset_id']) || fallbackId),
    url,
    mime_type: readString(raw, ['mime_type', 'mimeType']),
    sha256: readString(raw, ['sha256', 'hash']),
    width: readNumber(raw, ['width']) ?? undefined,
    height: readNumber(raw, ['height']) ?? undefined,
    bytes: readNumber(raw, ['bytes', 'size']) ?? undefined,
  };
}

function normalizeRelatedNotes(raw: unknown): RelatedNoteSuggestion[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const allowed = new Set<RelatedNoteSuggestion['relation']>([
    'supplements',
    'repeats',
    'conflicts',
    'updates',
    'related',
  ]);
  const values = raw
    .map((item: unknown): RelatedNoteSuggestion | null => {
      if (!isRecord(item)) return null;
      const notePath = readString(item, ['note_path', 'path']);
      const reason = readString(item, ['reason', 'rationale']);
      const relation = allowed.has(item.relation as RelatedNoteSuggestion['relation'])
        ? (item.relation as RelatedNoteSuggestion['relation'])
        : 'related';
      if (!notePath || !reason) return null;
      return {
        note_path: notePath,
        relation,
        reason,
        confidence: normalizeRatio(item.confidence),
      };
    })
    .filter((item): item is RelatedNoteSuggestion => item !== null);
  return values.length > 0 ? values : undefined;
}

function normalizeAttentionRanges(raw: unknown): AttentionRange[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const values = raw
    .map((item: unknown) => {
      if (!isRecord(item)) return null;
      const start = readNumber(item, ['start', 'start_seconds']);
      const end = readNumber(item, ['end', 'end_seconds']);
      const reason = readString(item, ['reason', 'rationale']);
      if (start === null || end === null || end <= start || !reason) return null;
      return { start, end, reason };
    })
    .filter((item): item is AttentionRange => item !== null);
  return values.length > 0 ? values : undefined;
}

function parseTimingLine(line: string): { start: number; end: number } | null {
  const match = line.match(
    /((?:\d{1,2}:)?\d{1,2}:\d{2}(?:[,.]\d{1,3})?)\s*-->\s*((?:\d{1,2}:)?\d{1,2}:\d{2}(?:[,.]\d{1,3})?)/,
  );
  if (!match) return null;
  const start = parseClock(match[1]);
  const end = parseClock(match[2]);
  return start === null || end === null ? null : { start, end };
}

function parseClock(value: string): number | null {
  const normalized = value.trim().replace(',', '.');
  const parts = normalized.split(':').map(Number);
  if (parts.some((part) => !Number.isFinite(part)) || parts.length < 2 || parts.length > 3) {
    return null;
  }
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function dedupeRollingCues(segments: VideoSegment[]): VideoSegment[] {
  const result: VideoSegment[] = [];
  for (const segment of segments) {
    const previous = result[result.length - 1];
    if (
      previous &&
      previous.text.toLocaleLowerCase() === segment.text.toLocaleLowerCase() &&
      previous.start === segment.start
    ) {
      previous.end = Math.max(
        previous.end || previous.start || 0,
        segment.end || segment.start || 0,
      );
      continue;
    }
    result.push(segment);
  }
  return result;
}

function splitUntimedTranscript(text: string): string[] {
  const paragraphs = text
    .split(/\n{2,}/)
    .map(normalizeText)
    .filter(Boolean);
  if (paragraphs.length > 1) return paragraphs;
  const lines = text.split('\n').map(normalizeText).filter(Boolean);
  if (lines.length > 1) return lines;
  return text
    .split(/(?<=[。！？.!?])\s+/)
    .reduce<string[]>((chunks, sentence) => {
      const current = chunks[chunks.length - 1];
      if (!current || current.length + sentence.length > 500) chunks.push(sentence);
      else chunks[chunks.length - 1] = `${current} ${sentence}`;
      return chunks;
    }, [])
    .filter(Boolean);
}

function compareSegments(left: VideoSegment, right: VideoSegment): number {
  if (left.start === null && right.start === null) return 0;
  if (left.start === null) return 1;
  if (right.start === null) return -1;
  return left.start - right.start;
}

function aggregateTimingQuality(segments: VideoSegment[], fallback: TimingQuality): TimingQuality {
  if (segments.length === 0) return fallback;
  const values = segments.map((segment) => segment.timing_quality || 'none');
  if (values.every((value) => value === 'exact')) return 'exact';
  // Be conservative: a collection containing any untimed segment cannot claim
  // that the artifact as a whole is aligned. Per-segment quality still lets the
  // UI expose trustworthy timestamp links for the timed subset.
  if (values.some((value) => value === 'none')) return 'none';
  if (values.some((value) => value === 'estimated')) return 'estimated';
  if (values.some((value) => value === 'aligned')) return 'aligned';
  return fallback;
}

function nearestSegment(segments: VideoSegment[], seconds: number): VideoSegment | undefined {
  const MAX_ALIGNMENT_GAP_SECONDS = 5;
  let best: { segment: VideoSegment; distance: number } | undefined;
  for (const segment of segments) {
    if (segment.start === null || segment.timing_quality === 'none') continue;
    const end =
      segment.end !== undefined && segment.end !== null && segment.end >= segment.start
        ? segment.end
        : segment.start;
    const distance =
      seconds < segment.start ? segment.start - seconds : seconds > end ? seconds - end : 0;
    if (!best || distance < best.distance) best = { segment, distance };
  }
  return best && best.distance <= MAX_ALIGNMENT_GAP_SECONDS ? best.segment : undefined;
}

function normalizeTimingQuality(raw: unknown, fallback: TimingQuality): TimingQuality {
  return typeof raw === 'string' && TIMING_QUALITY.has(raw as TimingQuality)
    ? (raw as TimingQuality)
    : fallback;
}

function normalizeEvidenceSource(raw: unknown, fallback: EvidenceSourceType): EvidenceSourceType {
  const value = (asText(raw) ?? '').trim().toLowerCase();
  const aliases: Record<string, EvidenceSourceType> = {
    audio: 'speech',
    transcript: 'speech',
    voice: 'speech',
    visual: 'screen',
    ocr: 'screen',
    image: 'screen',
    comments: 'comment',
    inference: 'ai-inference',
    ai: 'ai-inference',
  };
  const normalized: string = aliases[value] || value;
  return [...EVIDENCE_SOURCES].find((source) => source === normalized) ?? fallback;
}

function normalizeReviewState(
  raw: unknown,
  source: EvidenceSourceType,
): NonNullable<EvidenceClaim['review_state']> {
  const state = oneOf(raw, ['supported', 'needs-review', 'inference'] as const);
  if (state) return state;
  return source === 'ai-inference' ? 'inference' : 'supported';
}

function normalizeVisualKind(raw: unknown): VisualEvidence['kind'] {
  const value = (asText(raw) ?? '').trim().toLowerCase();
  const allowed = new Set(['slide', 'chart', 'code', 'interface', 'object', 'scene', 'other']);
  return allowed.has(value) ? (value as VisualEvidence['kind']) : 'other';
}

function normalizeProcessingDepth(raw: unknown): ProcessingDepth | undefined {
  return oneOf(raw, ['quick', 'evidence', 'deep-visual'] as const);
}

/** The value when it is one of the allowed strings, otherwise undefined. */
function oneOf<T extends string>(raw: unknown, allowed: readonly T[]): T | undefined {
  return typeof raw === 'string' && (allowed as readonly string[]).includes(raw)
    ? (raw as T)
    : undefined;
}

function normalizeBackend(raw: unknown): ArtifactProvenance['backend'] {
  return raw === 'n8n' || raw === 'codex-worker' ? raw : undefined;
}

function normalizeRatio(raw: unknown): number | undefined {
  const value = Number(raw);
  if (!Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(1, value > 1 ? value / 100 : value));
}

function normalizeStringArray(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const values = raw.map((item) => String(item || '').trim()).filter(Boolean);
  return values.length > 0 ? Array.from(new Set(values)) : undefined;
}

function readArray(source: unknown, keys: string[]): unknown[] | undefined {
  if (!isRecord(source)) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (Array.isArray(value)) return value as unknown[];
  }
  return undefined;
}

function objectOrUndefined(source: unknown): Record<string, unknown> | undefined {
  return source && typeof source === 'object' && !Array.isArray(source)
    ? (source as Record<string, unknown>)
    : undefined;
}

function readString(source: unknown, keys: string[]): string {
  if (!isRecord(source)) return '';
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function readNumber(source: unknown, keys: string[]): number | null {
  if (!isRecord(source)) return null;
  for (const key of keys) {
    const raw = source[key];
    // Number(null), Number(''), and Number(false) are all zero. Treating those
    // placeholders as timestamps would fabricate a clickable 0:00 citation.
    if (
      raw === null ||
      raw === undefined ||
      typeof raw === 'boolean' ||
      (typeof raw === 'string' && !raw.trim())
    ) {
      continue;
    }
    const value = Number(raw);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function cleanCueText(value: string): string {
  return value
    .replace(/<[^>]+>/g, '')
    .replace(/\{\\[^}]+\}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeText(value: unknown): string {
  return (asText(value) ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function normalizeSource(value: string): string {
  return String(value || '')
    .trim()
    .replace(/#.*$/, '');
}

function sanitizeId(value: string): string {
  return (
    String(value || '')
      .trim()
      .replace(/[^a-zA-Z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || `vs-${stableHash(value)}`
  );
}
