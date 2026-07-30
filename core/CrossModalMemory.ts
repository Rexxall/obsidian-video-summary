import type {
  EvidenceClaim,
  MediaAssetReference,
  RelatedNoteSuggestion,
  VideoKnowledgeArtifact,
  VideoSegment,
} from '../types';
import type { ArtifactStore } from './ArtifactStore';
import { claimSimilarity, compareResolvedClaims, resolveArtifactClaim } from './ClaimLab';

export const CROSS_MODAL_MEMORY_CONTRACT_VERSION = 'cross-modal-memory-v1';
export const CROSS_MODAL_MEMORY_LIMITS = Object.freeze({
  artifacts: 2_000,
  recordsPerArtifact: 600,
  textCharactersPerRecord: 4_000,
  searchResults: 100,
});

export type MemoryEvidenceType =
  | 'title'
  | 'transcript'
  | 'visual-text'
  | 'visual-evidence'
  | 'ocr'
  | 'claim';

export type MemoryDateField = 'generated' | 'updated' | 'either';

export interface MemorySearchFilters {
  author?: string;
  platform?: string;
  date_from?: string;
  date_to?: string;
  date_field?: MemoryDateField;
  content_type?: VideoKnowledgeArtifact['content_type'];
  course_id?: string;
  artifact_id?: string;
}

export interface MemorySearchOptions {
  filters?: MemorySearchFilters;
  limit?: number;
}

export interface TextHighlightRange {
  start: number;
  end: number;
}

export interface MemoryScoreComponent {
  name: 'phrase' | 'coverage' | 'field' | 'timestamp' | 'frequency';
  value: number;
  explanation: string;
}

export interface MemorySearchResult {
  record_id: string;
  artifact_id: string;
  title: string;
  author?: string;
  platform?: string;
  content_type?: VideoKnowledgeArtifact['content_type'];
  course_ids: string[];
  source_url?: string;
  note_path?: string;
  timestamp: number | null;
  timestamp_url?: string;
  evidence_type: MemoryEvidenceType;
  evidence_id?: string;
  /** Present for claim records so inference is never displayed as verified evidence. */
  claim_review_state?: EvidenceClaim['review_state'];
  keyframe?: MediaAssetReference;
  text: string;
  snippet: string;
  highlights: TextHighlightRange[];
  score: number;
  score_explanation: MemoryScoreComponent[];
  generated_at: string;
  updated_at: string;
}

interface MemoryRecord extends Omit<
  MemorySearchResult,
  'snippet' | 'highlights' | 'score' | 'score_explanation'
> {
  normalized_text: string;
  tokens: Set<string>;
}

export type SuggestedArtifactRelation = 'supplement' | 'repeat' | 'conflict' | 'update' | 'related';

export interface ArtifactRelationSuggestion {
  source_artifact_id: string;
  target_artifact_id: string;
  target_title: string;
  target_note_path: string;
  relation: SuggestedArtifactRelation;
  reason: string;
  confidence: number;
  evidence_pairs: Array<{
    source_claim_id: string;
    target_claim_id: string;
    relation: 'agreement' | 'conflict' | 'update' | 'unique' | 'unknown';
    similarity: number;
  }>;
}

export interface ReviewedRelationResult {
  persisted: boolean;
  artifact: VideoKnowledgeArtifact;
  suggestion: ArtifactRelationSuggestion;
}

/**
 * A bounded in-memory index rebuilt from ArtifactStore sidecars on startup.
 * It has no network dependency and no opaque vector score: every result exposes
 * the exact phrase/coverage/field/frequency contributions used to rank it.
 */
export class CrossModalMemoryIndex {
  private records: MemoryRecord[] = [];
  private artifacts = new Map<string, VideoKnowledgeArtifact>();
  private rebuildWarnings: string[] = [];

  rebuild(inputArtifacts: readonly VideoKnowledgeArtifact[]): void {
    const artifacts = dedupeArtifacts(inputArtifacts).slice(0, CROSS_MODAL_MEMORY_LIMITS.artifacts);
    this.records = [];
    this.artifacts.clear();
    this.rebuildWarnings = [];
    if (inputArtifacts.length > CROSS_MODAL_MEMORY_LIMITS.artifacts) {
      this.rebuildWarnings.push(
        `索引只加载最近的 ${CROSS_MODAL_MEMORY_LIMITS.artifacts} 个持久化工件。`,
      );
    }

    artifacts.forEach((artifact) => {
      this.artifacts.set(artifact.artifact_id, artifact);
      this.records.push(...recordsForArtifact(artifact));
    });
  }

  async rebuildFromStore(store: Pick<ArtifactStore, 'list'>): Promise<void> {
    this.rebuild(await store.list());
  }

  /** Make a newly persisted artifact searchable immediately, without restart. */
  upsert(artifact: VideoKnowledgeArtifact): void {
    const existing = Array.from(this.artifacts.values()).filter(
      (item) => item.artifact_id !== artifact.artifact_id,
    );
    this.rebuild([artifact, ...existing]);
  }

  search(query: string, options: MemorySearchOptions = {}): MemorySearchResult[] {
    const normalizedQuery = normalizeSearchText(query);
    const queryTokens = searchTokens(query);
    if (!normalizedQuery || queryTokens.size === 0) return [];
    const filters = options.filters || {};
    const limit = clamp(options.limit ?? 30, 1, CROSS_MODAL_MEMORY_LIMITS.searchResults);

    return this.records
      .filter((record) => matchesFilters(record, filters))
      .map((record) => scoreRecord(record, normalizedQuery, queryTokens))
      .filter((result): result is MemorySearchResult => !!result)
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.generated_at.localeCompare(left.generated_at) ||
          left.record_id.localeCompare(right.record_id),
      )
      .slice(0, limit);
  }

  getArtifact(artifactId: string): VideoKnowledgeArtifact | undefined {
    return this.artifacts.get(artifactId);
  }

  getArtifacts(): VideoKnowledgeArtifact[] {
    return Array.from(this.artifacts.values());
  }

  getRecordCount(): number {
    return this.records.length;
  }

  getWarnings(): string[] {
    return [...this.rebuildWarnings];
  }
}

/**
 * Suggest a relationship between two artifacts without mutating either one.
 * The caller must explicitly pass the suggestion through
 * applyReviewedRelationSuggestion(..., true) before it can be persisted.
 */
export function suggestArtifactRelation(
  source: VideoKnowledgeArtifact,
  target: VideoKnowledgeArtifact,
): ArtifactRelationSuggestion {
  if (source.artifact_id === target.artifact_id) {
    throw new Error('Cannot suggest a relation from an artifact to itself');
  }
  const sourceClaims = source.claims.map((claim) => resolveArtifactClaim(source, claim));
  const targetClaims = target.claims.map((claim) => resolveArtifactClaim(target, claim));
  const pairs = sourceClaims
    .flatMap((left) =>
      targetClaims.map((right) => {
        const comparison = compareResolvedClaims(left, right, source, target);
        return {
          source_claim_id: left.claim.id,
          target_claim_id: right.claim.id,
          relation: comparison.relation,
          similarity: comparison.similarity,
          supported: left.evidence_state === 'supported' && right.evidence_state === 'supported',
        };
      }),
    )
    .filter((pair) => pair.supported)
    .sort(
      (left, right) =>
        relationPriority(right.relation) - relationPriority(left.relation) ||
        right.similarity - left.similarity ||
        left.source_claim_id.localeCompare(right.source_claim_id),
    )
    .slice(0, 12);

  const conflicts = pairs.filter((pair) => pair.relation === 'conflict');
  const updates = pairs.filter((pair) => pair.relation === 'update');
  const agreements = pairs.filter(
    (pair) => pair.relation === 'agreement' && pair.similarity >= 0.52,
  );
  const overlaps = pairs.filter((pair) => pair.similarity >= 0.22);
  let relation: SuggestedArtifactRelation;
  let reason: string;
  let confidence: number;

  if (conflicts.length > 0) {
    relation = 'conflict';
    confidence = average(conflicts.map((pair) => Math.max(0.55, pair.similarity)));
    reason = `${conflicts.length} 组主张均有真实证据段，并包含明确反向表述；仅作为待确认冲突建议。`;
  } else if (updates.length > 0) {
    relation = 'update';
    confidence = average(updates.map((pair) => Math.max(0.52, pair.similarity)));
    reason = `${updates.length} 组有证据主张涉及同一主题，较新的表述包含明确更新线索。`;
  } else if (agreements.length >= 2) {
    relation = 'repeat';
    confidence = average(agreements.map((pair) => pair.similarity));
    reason = `${agreements.length} 组有证据主张高度重合，可能是重复讲解。`;
  } else if (overlaps.length > 0) {
    relation = 'supplement';
    confidence = average(overlaps.map((pair) => Math.max(0.35, pair.similarity)));
    reason = `${overlaps.length} 组有证据主张主题相关但不足以判定重复，可能相互补充。`;
  } else {
    const metadataSimilarity = claimSimilarity(
      `${source.title || ''} ${source.content_type || ''}`,
      `${target.title || ''} ${target.content_type || ''}`,
    );
    relation = 'related';
    confidence = Math.max(0.2, metadataSimilarity * 0.6);
    reason = '未找到足够强的有证据主张关系；仅依据标题或内容类型给出低置信度相关建议。';
  }

  return {
    source_artifact_id: source.artifact_id,
    target_artifact_id: target.artifact_id,
    target_title: target.title || target.artifact_id,
    target_note_path: target.source.note_path || `artifact://${target.artifact_id}`,
    relation,
    reason,
    confidence: roundScore(confidence),
    evidence_pairs: pairs.map((pair) => ({
      source_claim_id: pair.source_claim_id,
      target_claim_id: pair.target_claim_id,
      relation: pair.relation,
      similarity: pair.similarity,
    })),
  };
}

/**
 * Explicit review gate. `confirmed=false` performs no write; `confirmed=true`
 * atomically updates related_notes through ArtifactStore.
 */
export async function applyReviewedRelationSuggestion(
  store: Pick<ArtifactStore, 'load' | 'updateRelatedNotes'>,
  suggestion: ArtifactRelationSuggestion,
  confirmed: boolean,
): Promise<ReviewedRelationResult> {
  if (!confirmed) {
    return {
      persisted: false,
      artifact: await store.load(suggestion.source_artifact_id),
      suggestion,
    };
  }
  const relatedNote = toStoredRelation(suggestion);
  const artifact = await store.updateRelatedNotes(suggestion.source_artifact_id, (current) => {
    const withoutTarget = current.filter((item) => item.note_path !== relatedNote.note_path);
    return [...withoutTarget, relatedNote];
  });
  return { persisted: true, artifact, suggestion };
}

function recordsForArtifact(artifact: VideoKnowledgeArtifact): MemoryRecord[] {
  const output: MemoryRecord[] = [];
  const push = (
    type: MemoryEvidenceType,
    id: string | undefined,
    text: string | undefined,
    segment?: VideoSegment,
    keyframe?: MediaAssetReference,
    claimReviewState?: EvidenceClaim['review_state'],
  ) => {
    const boundedText = cleanText(text).slice(0, CROSS_MODAL_MEMORY_LIMITS.textCharactersPerRecord);
    if (!boundedText) return;
    const timestamp = segment?.start ?? null;
    const recordId = `${artifact.artifact_id}:${type}:${id || output.length}`;
    output.push({
      record_id: recordId,
      artifact_id: artifact.artifact_id,
      title: cleanText(artifact.title) || artifact.artifact_id,
      author: cleanOptional(artifact.author),
      platform: cleanOptional(artifact.platform),
      content_type: artifact.content_type,
      course_ids: [...artifact.course_ids],
      source_url: artifact.source.url,
      note_path: artifact.source.note_path,
      timestamp,
      timestamp_url: segment?.timestamp_url || buildTimestampUrl(artifact.source.url, timestamp),
      evidence_type: type,
      evidence_id: id,
      claim_review_state: claimReviewState,
      keyframe: keyframe || segment?.keyframe,
      text: boundedText,
      normalized_text: normalizeSearchText(boundedText),
      tokens: searchTokens(boundedText),
      generated_at: artifact.provenance.generated_at || artifact.created_at,
      updated_at: artifact.updated_at,
    });
  };

  push('title', undefined, artifact.title);
  artifact.segments.forEach((segment) => {
    push('transcript', segment.id, segment.text, segment);
    push('visual-text', segment.id, segment.visual_text, segment);
  });
  if (artifact.segments.length === 0) {
    push('transcript', 'untimed-transcript', artifact.transcript);
  }
  artifact.visual_evidence.forEach((visual) => {
    const syntheticSegment: VideoSegment = {
      id: visual.id,
      start: visual.start,
      end: visual.end,
      text: visual.description,
      source: 'screen',
      keyframe: visual.keyframe,
    };
    push('visual-evidence', visual.id, visual.description, syntheticSegment, visual.keyframe);
    push('ocr', visual.id, visual.ocr_text, syntheticSegment, visual.keyframe);
  });
  const segments = new Map(artifact.segments.map((segment) => [segment.id, segment]));
  artifact.claims.forEach((claim) => {
    const evidenceSegment = claim.evidence
      .map((reference) => segments.get(reference.segment_id))
      .find((segment): segment is VideoSegment => !!segment);
    push('claim', claim.id, claim.claim, evidenceSegment, undefined, claim.review_state);
  });
  return balancedRecordSample(output);
}

/**
 * Reserve space for every modality before allowing long transcripts to fill
 * the remaining budget. This keeps late OCR/visual/claim evidence searchable
 * even for 500+ segment lectures.
 */
function balancedRecordSample(records: MemoryRecord[]): MemoryRecord[] {
  const limit = CROSS_MODAL_MEMORY_LIMITS.recordsPerArtifact;
  if (records.length <= limit) return records;
  const quotas: Record<MemoryEvidenceType, number> = {
    title: 1,
    transcript: 350,
    'visual-text': 80,
    'visual-evidence': 60,
    ocr: 60,
    claim: 49,
  };
  const selected = new Set<string>();
  (Object.keys(quotas) as MemoryEvidenceType[]).forEach((type) => {
    records
      .filter((record) => record.evidence_type === type)
      .slice(0, quotas[type])
      .forEach((record) => selected.add(record.record_id));
  });
  for (const record of records) {
    if (selected.size >= limit) break;
    selected.add(record.record_id);
  }
  return records.filter((record) => selected.has(record.record_id)).slice(0, limit);
}

function scoreRecord(
  record: MemoryRecord,
  normalizedQuery: string,
  queryTokens: Set<string>,
): MemorySearchResult | undefined {
  let matchingTokens = 0;
  let frequency = 0;
  queryTokens.forEach((token) => {
    if (record.tokens.has(token) || record.normalized_text.includes(token)) {
      matchingTokens += 1;
      frequency += occurrences(record.normalized_text, token);
    }
  });
  const phraseMatch = record.normalized_text.includes(normalizedQuery);
  if (!phraseMatch && matchingTokens === 0) return undefined;

  const coverage = matchingTokens / queryTokens.size;
  const fieldWeight = FIELD_WEIGHTS[record.evidence_type];
  const components: MemoryScoreComponent[] = [];
  if (phraseMatch) {
    components.push({
      name: 'phrase',
      value: 2.2,
      explanation: '包含完整查询短语 +2.20',
    });
  }
  components.push({
    name: 'coverage',
    value: roundScore(coverage * 1.5),
    explanation: `命中 ${matchingTokens}/${queryTokens.size} 个查询词`,
  });
  components.push({
    name: 'field',
    value: fieldWeight,
    explanation: `${record.evidence_type} 字段权重 ${fieldWeight.toFixed(2)}`,
  });
  if (record.timestamp !== null) {
    components.push({
      name: 'timestamp',
      value: 0.15,
      explanation: '可定位到真实时间段 +0.15',
    });
  }
  const frequencyScore = Math.min(0.4, frequency * 0.08);
  if (frequencyScore > 0) {
    components.push({
      name: 'frequency',
      value: roundScore(frequencyScore),
      explanation: `查询词共出现 ${frequency} 次`,
    });
  }
  const score = components.reduce((sum, component) => sum + component.value, 0);
  const snippet = makeSnippet(record.text, normalizedQuery, queryTokens);
  return {
    record_id: record.record_id,
    artifact_id: record.artifact_id,
    title: record.title,
    author: record.author,
    platform: record.platform,
    content_type: record.content_type,
    course_ids: [...record.course_ids],
    source_url: record.source_url,
    note_path: record.note_path,
    timestamp: record.timestamp,
    timestamp_url: record.timestamp_url,
    evidence_type: record.evidence_type,
    evidence_id: record.evidence_id,
    claim_review_state: record.claim_review_state,
    keyframe: record.keyframe,
    text: record.text,
    snippet,
    highlights: highlightRanges(snippet, normalizedQuery, queryTokens),
    score: Math.round(score * 1000) / 1000,
    score_explanation: components,
    generated_at: record.generated_at,
    updated_at: record.updated_at,
  };
}

const FIELD_WEIGHTS: Record<MemoryEvidenceType, number> = {
  title: 1,
  claim: 0.96,
  'visual-evidence': 0.92,
  ocr: 0.9,
  'visual-text': 0.88,
  transcript: 0.82,
};

function matchesFilters(record: MemoryRecord, filters: MemorySearchFilters): boolean {
  if (filters.artifact_id && record.artifact_id !== filters.artifact_id) return false;
  if (
    filters.author &&
    !normalizeSearchText(record.author || '').includes(normalizeSearchText(filters.author))
  ) {
    return false;
  }
  if (
    filters.platform &&
    normalizeSearchText(record.platform || '') !== normalizeSearchText(filters.platform)
  ) {
    return false;
  }
  if (filters.content_type && record.content_type !== filters.content_type) return false;
  if (filters.course_id && !record.course_ids.includes(filters.course_id)) return false;

  const from = filters.date_from ? dateBoundary(filters.date_from, false) : undefined;
  const to = filters.date_to ? dateBoundary(filters.date_to, true) : undefined;
  if (from !== undefined || to !== undefined) {
    const field = filters.date_field || 'either';
    const dates =
      field === 'generated'
        ? [Date.parse(record.generated_at)]
        : field === 'updated'
          ? [Date.parse(record.updated_at)]
          : [Date.parse(record.generated_at), Date.parse(record.updated_at)];
    const inRange = dates.some(
      (date) =>
        Number.isFinite(date) &&
        (from === undefined || date >= from) &&
        (to === undefined || date <= to),
    );
    if (!inRange) return false;
  }
  return true;
}

function makeSnippet(text: string, normalizedQuery: string, queryTokens: Set<string>): string {
  const normalizedText = normalizeSearchText(text);
  let matchIndex = normalizedText.indexOf(normalizedQuery);
  if (matchIndex < 0) {
    for (const token of queryTokens) {
      matchIndex = normalizedText.indexOf(token);
      if (matchIndex >= 0) break;
    }
  }
  if (text.length <= 360 || matchIndex < 0) return text;
  const start = Math.max(0, matchIndex - 120);
  const end = Math.min(text.length, start + 360);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

function highlightRanges(
  text: string,
  normalizedQuery: string,
  queryTokens: Set<string>,
): TextHighlightRange[] {
  const normalized = normalizeSearchText(text);
  const needles = normalized.includes(normalizedQuery)
    ? [normalizedQuery]
    : Array.from(queryTokens).sort((left, right) => right.length - left.length);
  const ranges: TextHighlightRange[] = [];
  needles.forEach((needle) => {
    let cursor = 0;
    while (needle && ranges.length < 24) {
      const index = normalized.indexOf(needle, cursor);
      if (index < 0) break;
      ranges.push({ start: index, end: index + needle.length });
      cursor = index + Math.max(1, needle.length);
    }
  });
  return mergeRanges(ranges.sort((left, right) => left.start - right.start));
}

function mergeRanges(ranges: readonly TextHighlightRange[]): TextHighlightRange[] {
  const output: TextHighlightRange[] = [];
  ranges.forEach((range) => {
    const previous = output[output.length - 1];
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      output.push({ ...range });
    }
  });
  return output;
}

function toStoredRelation(suggestion: ArtifactRelationSuggestion): RelatedNoteSuggestion {
  const relationMap: Record<SuggestedArtifactRelation, RelatedNoteSuggestion['relation']> = {
    supplement: 'supplements',
    repeat: 'repeats',
    conflict: 'conflicts',
    update: 'updates',
    related: 'related',
  };
  return {
    note_path: suggestion.target_note_path,
    relation: relationMap[suggestion.relation],
    reason: suggestion.reason,
    confidence: suggestion.confidence,
  };
}

function relationPriority(relation: string): number {
  if (relation === 'conflict') return 4;
  if (relation === 'update') return 3;
  if (relation === 'agreement') return 2;
  return 1;
}

function dedupeArtifacts(artifacts: readonly VideoKnowledgeArtifact[]): VideoKnowledgeArtifact[] {
  const result = new Map<string, VideoKnowledgeArtifact>();
  artifacts
    .slice()
    .sort(
      (left, right) =>
        right.updated_at.localeCompare(left.updated_at) ||
        left.artifact_id.localeCompare(right.artifact_id),
    )
    .forEach((artifact) => {
      if (!result.has(artifact.artifact_id)) result.set(artifact.artifact_id, artifact);
    });
  return Array.from(result.values());
}

function searchTokens(value: string): Set<string> {
  const normalized = normalizeSearchText(value);
  const tokens = new Set<string>();
  (normalized.match(/[a-z0-9][a-z0-9_-]*/g) || []).forEach((token) => {
    if (token.length >= 2) tokens.add(token);
  });
  const cjkRuns =
    normalized.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu) || [];
  cjkRuns.forEach((run) => {
    const characters = Array.from(run);
    if (characters.length <= 3) {
      tokens.add(run);
      return;
    }
    for (let index = 0; index < characters.length - 1; index += 1) {
      tokens.add(characters.slice(index, index + 2).join(''));
    }
  });
  return tokens;
}

function normalizeSearchText(value: string): string {
  return cleanText(value)
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildTimestampUrl(
  sourceUrl: string | undefined,
  seconds: number | null,
): string | undefined {
  if (!sourceUrl || seconds === null || !Number.isFinite(seconds) || seconds < 0) return undefined;
  try {
    const url = new URL(sourceUrl);
    if (url.hostname === 'youtu.be' || url.hostname.endsWith('youtube.com')) {
      url.searchParams.set('t', `${Math.floor(seconds)}s`);
      return url.toString();
    }
    if (url.hostname === 'b23.tv' || url.hostname.endsWith('bilibili.com')) {
      url.searchParams.set('t', String(Math.floor(seconds)));
      return url.toString();
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function dateBoundary(value: string, endOfDay: boolean): number | undefined {
  const bareDate = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const parsed = Date.parse(
    bareDate ? `${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z` : value,
  );
  return Number.isFinite(parsed) ? parsed : undefined;
}

function occurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let cursor = 0;
  while (count < 20) {
    const index = haystack.indexOf(needle, cursor);
    if (index < 0) break;
    count += 1;
    cursor = index + Math.max(1, needle.length);
  }
  return count;
}

function average(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function cleanOptional(value: unknown): string | undefined {
  const cleaned = cleanText(value);
  return cleaned || undefined;
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

function roundScore(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 1000) / 1000;
}
