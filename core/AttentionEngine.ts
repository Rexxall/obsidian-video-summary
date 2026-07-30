import type {
  AttentionAssessment,
  AttentionRange,
  EvidenceClaim,
  ProcessingResult,
  VideoInput,
  VideoContentType,
  VideoSegment,
} from '../types';

/**
 * The policy is exported so thresholds and weights remain inspectable and can
 * be regression-tested instead of becoming hidden product folklore.
 */
export const ATTENTION_ENGINE_POLICY = {
  formulaVersion: 'attention-v1',
  limits: {
    maxDurationSeconds: 24 * 60 * 60,
    maxSegments: 5_000,
    maxClaims: 1_000,
    maxPromotionalCues: 1_000,
    maxContextTerms: 100,
    maxSegmentCharacters: 5_000,
  },
  scoreWeights: {
    informationDensity: 0.34,
    originality: 0.24,
    actionability: 0.24,
    vaultRelevance: 0.18,
  },
  promotionalPenalty: 0.36,
  actionThresholds: {
    watch: 0.66,
    skip: 0.34,
    highPromotion: 0.65,
    highPromotionMaximumScore: 0.62,
    minimumDecisionConfidence: 0.38,
    shortVideoSeconds: 90,
    shortVideoWatchScore: 0.52,
  },
} as const;

export interface PromotionalCue {
  segment_id?: string;
  start?: number;
  end?: number;
  confidence?: number;
  reason?: string;
}

/**
 * Vault relevance is derived only from inspectable context evidence. The
 * engine intentionally does not accept a naked relevance score.
 */
export interface AttentionUserContext {
  query_terms?: string[];
  relevant_segment_ids?: string[];
  label?: string;
}

export interface AttentionEngineInput {
  segments?: readonly VideoSegment[];
  claims?: readonly EvidenceClaim[];
  durationSeconds?: number | null;
  repetitionRatio?: number | null;
  evidenceCoverage?: number | null;
  promotionalCues?: readonly PromotionalCue[];
  userContext?: AttentionUserContext;
  contentType?: VideoContentType;
  /** Untrusted LLM/backend output. It is used only after full core validation. */
  backendAssessment?: unknown;
}

export interface AttentionDiagnostics {
  source: 'backend' | 'local-fallback';
  formula_version: string;
  duration_seconds?: number;
  repetition_ratio: number;
  evidence_coverage?: number;
  timing_coverage: number;
  backend_rejection_reasons: string[];
  limitations: string[];
}

export interface AttentionEvaluation {
  assessment: AttentionAssessment;
  diagnostics: AttentionDiagnostics;
}

export type AttentionApplicationOptions = Omit<
  AttentionEngineInput,
  'segments' | 'claims' | 'durationSeconds' | 'backendAssessment'
>;

interface BoundedInput {
  segments: VideoSegment[];
  claims: EvidenceClaim[];
  durationSeconds?: number;
  repetitionRatio?: number;
  evidenceCoverage?: number;
  promotionalCues: PromotionalCue[];
  userContext?: AttentionUserContext;
  contentType?: VideoContentType;
  limitations: string[];
}

interface LocalSignals {
  informationDensity: number;
  originality: number;
  actionability: number;
  vaultRelevance?: number;
  promotionalRatio: number;
  repetitionRatio: number;
  evidenceCoverage?: number;
  confidence: number;
  timingCoverage: number;
  positiveScore: number;
  score: number;
  contextSegmentIds: Set<string>;
  promotionalSegmentIds: Set<string>;
  duplicatedSegmentIds: Set<string>;
}

interface BackendCore {
  informationDensity: number;
  originality: number;
  actionability: number;
  promotionalRatio: number;
  confidence: number;
  rationale: string;
  context?: string;
  action?: AttentionAssessment['action'];
  score?: number;
  evidenceSegmentIds?: string[];
  limitations?: string[];
  mustWatch?: AttentionRange[];
  skippable?: AttentionRange[];
}

const ACTION_PATTERNS = [
  /步骤|方法|首先|然后|接着|实践|设置|点击|安装|配置|使用|尝试|检查|需要|应该|操作|代码|示例/u,
  /\b(?:how to|step|install|configure|use|try|create|check|verify|run|build|should|must)\b/iu,
  /方法|手順|まず|次に|設定|使(?:う|い方)|確認|実行|作成|必要|してください|コード|例/u,
];

const PROMOTIONAL_PATTERNS = [
  /关注|点赞|订阅|下单|优惠|折扣|赞助|广告|购买|链接在|课程报名|扫码|私信|带货|福利/u,
  /\b(?:subscribe|sponsor(?:ed)?|discount|buy now|affiliate|promo code|sign up|limited offer)\b/iu,
  /\b(?:link in (?:the )?description|like and subscribe)\b/iu,
  /チャンネル登録|高評価|スポンサー|広告|割引|購入|概要欄|申し込|キャンペーン/u,
];

const LIMITATION_NO_VAULT =
  '未提供可核对的知识库上下文，未计算 vault relevance，也未用中性默认值代替。';
const LIMITATION_LOCAL_ORIGINALITY =
  '本地回退只能估算视频内部的非重复性，不能验证相对互联网或知识库的外部原创性。';

export function evaluateAttention(input: AttentionEngineInput): AttentionEvaluation {
  const bounded = boundInput(input);
  const local = calculateLocalSignals(bounded);
  const backendRejectionReasons: string[] = [];
  const backend = validateBackendCore(input.backendAssessment, bounded, backendRejectionReasons);
  const source: AttentionDiagnostics['source'] = backend ? 'backend' : 'local-fallback';
  const limitations = [...bounded.limitations];

  if (input.backendAssessment !== undefined && !backend) {
    limitations.push('后端观看价值结果缺失或未通过校验，已使用本地保守回退。');
  } else if (input.backendAssessment === undefined) {
    limitations.push('后端未返回观看价值结果，已使用本地保守回退。');
  }

  let informationDensity = local.informationDensity;
  let originality = local.originality;
  let actionability = local.actionability;
  let promotionalRatio = local.promotionalRatio;
  let confidence = local.confidence;
  let rationale = localRationale(local);
  let context: string | undefined;
  let backendEvidenceIds: string[] | undefined;
  let backendMustWatch: AttentionRange[] | undefined;
  let backendSkippable: AttentionRange[] | undefined;
  let backendAction: AttentionAssessment['action'] | undefined;
  let backendScore: number | undefined;

  if (backend) {
    informationDensity = backend.informationDensity;
    originality = backend.originality;
    actionability = backend.actionability;
    promotionalRatio = backend.promotionalRatio;
    confidence = Math.min(backend.confidence, reliabilityCeiling(bounded, local, true));
    rationale = backend.rationale;
    context = backend.context;
    backendEvidenceIds = backend.evidenceSegmentIds;
    backendMustWatch = backend.mustWatch;
    backendSkippable = backend.skippable;
    backendAction = backend.action;
    backendScore = backend.score;
    limitations.push(...(backend.limitations || []));
    if (confidence < backend.confidence) {
      limitations.push('后端置信度高于可用证据上限，已按本地数据完整度下调。');
    }
  } else {
    limitations.push(LIMITATION_LOCAL_ORIGINALITY);
  }

  const { positiveScore, score } = calculateScore({
    informationDensity,
    originality,
    actionability,
    vaultRelevance: local.vaultRelevance,
    promotionalRatio,
  });
  const action = chooseAction(score, confidence, promotionalRatio, bounded.durationSeconds);

  if (backendAction && backendAction !== action) {
    limitations.push('后端动作与透明阈值不一致，已按本地阈值重新判定。');
  }
  if (backendScore !== undefined && Math.abs(backendScore - score) > 0.15) {
    limitations.push('后端综合分与透明公式偏差过大，已重新计算综合分。');
  }

  const derivedRanges = deriveRanges(bounded, local);
  const mustWatch = backendMustWatch?.length ? backendMustWatch : derivedRanges.mustWatch;
  const skippable = backendSkippable?.length ? backendSkippable : derivedRanges.skippable;
  if (timedSegments(bounded.segments, bounded.durationSeconds).length === 0) {
    limitations.push('没有可靠的起止时间，未生成 must-watch 或 skippable 时间段。');
  }

  const evidenceSegmentIds = backendEvidenceIds?.length
    ? backendEvidenceIds
    : supportedEvidenceSegmentIds(bounded);
  const estimatedUsefulSeconds = estimateUsefulSeconds(
    bounded,
    positiveScore,
    promotionalRatio,
    limitations,
  );
  const uniqueLimitations = uniqueNonEmpty(limitations);

  return {
    assessment: {
      action,
      score,
      confidence,
      rationale,
      context,
      information_density: informationDensity,
      originality,
      actionability,
      vault_relevance: local.vaultRelevance,
      promotional_ratio: promotionalRatio,
      estimated_useful_seconds: estimatedUsefulSeconds,
      evidence_segment_ids: evidenceSegmentIds.length ? evidenceSegmentIds : undefined,
      limitations: uniqueLimitations.length ? uniqueLimitations : undefined,
      must_watch: mustWatch?.length ? mustWatch : undefined,
      skippable: skippable?.length ? skippable : undefined,
    },
    diagnostics: {
      source,
      formula_version: ATTENTION_ENGINE_POLICY.formulaVersion,
      duration_seconds: bounded.durationSeconds,
      repetition_ratio: local.repetitionRatio,
      evidence_coverage: local.evidenceCoverage,
      timing_coverage: local.timingCoverage,
      backend_rejection_reasons: backendRejectionReasons,
      limitations: uniqueLimitations,
    },
  };
}

export function assessAttention(input: AttentionEngineInput): AttentionAssessment {
  return evaluateAttention(input).assessment;
}

/**
 * Mainline integration point for JobService after response normalization.
 *
 * It is intentionally request-gated: an absent/invalid backend assessment gets
 * a conservative local fallback only when `input.attentionAssessment === true`.
 * The returned result is a copy, so callers can assign it without mutating
 * cached or preview objects.
 */
export function applyAttentionAssessment(
  result: ProcessingResult,
  input: Pick<VideoInput, 'attentionAssessment'>,
  options: AttentionApplicationOptions = {},
): ProcessingResult {
  if (input.attentionAssessment !== true) return result;
  const evaluation = evaluateAttention({
    ...options,
    segments: result.video_segments,
    claims: result.evidence_claims,
    durationSeconds: parseDurationSeconds(result.video_duration),
    backendAssessment: result.attention,
    contentType: options.contentType ?? result.content_type,
  });
  return { ...result, attention: evaluation.assessment };
}

export function parseDurationSeconds(value: string | number | undefined): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : undefined;
  }
  const normalized = normalizeText(value || '');
  if (!normalized) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(normalized)) {
    const seconds = Number(normalized);
    return seconds > 0 ? seconds : undefined;
  }
  const iso = normalized.match(
    /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/i,
  );
  if (iso) {
    const seconds = Number(iso[1] || 0) * 3600 + Number(iso[2] || 0) * 60 + Number(iso[3] || 0);
    return seconds > 0 ? seconds : undefined;
  }
  const parts = normalized.split(':').map(Number);
  if (
    (parts.length === 2 || parts.length === 3) &&
    parts.every((part) => Number.isFinite(part) && part >= 0) &&
    parts[parts.length - 1] < 60 &&
    (parts.length === 2 || parts[1] < 60)
  ) {
    const seconds =
      parts.length === 2 ? parts[0] * 60 + parts[1] : parts[0] * 3600 + parts[1] * 60 + parts[2];
    return seconds > 0 ? seconds : undefined;
  }
  return undefined;
}

export function calculateAttentionScore(metrics: {
  informationDensity: number;
  originality: number;
  actionability: number;
  vaultRelevance?: number;
  promotionalRatio: number;
}): number {
  return calculateScore(metrics).score;
}

export function chooseAttentionAction(
  score: number,
  confidence: number,
  promotionalRatio: number,
  durationSeconds?: number,
): AttentionAssessment['action'] {
  return chooseAction(score, confidence, promotionalRatio, durationSeconds);
}

function boundInput(input: AttentionEngineInput): BoundedInput {
  const limitations: string[] = [];
  const limits = ATTENTION_ENGINE_POLICY.limits;
  const segments = (input.segments || []).slice(0, limits.maxSegments);
  const claims = (input.claims || []).slice(0, limits.maxClaims);
  const promotionalCues = (input.promotionalCues || []).slice(0, limits.maxPromotionalCues);

  if ((input.segments?.length || 0) > limits.maxSegments) {
    limitations.push(`片段超过 ${limits.maxSegments} 条，仅使用前 ${limits.maxSegments} 条。`);
  }
  if ((input.claims?.length || 0) > limits.maxClaims) {
    limitations.push(`主张超过 ${limits.maxClaims} 条，仅使用前 ${limits.maxClaims} 条。`);
  }
  if ((input.promotionalCues?.length || 0) > limits.maxPromotionalCues) {
    limitations.push(`推广提示超过 ${limits.maxPromotionalCues} 条，已截断。`);
  }

  const rawDuration = input.durationSeconds;
  let durationSeconds: number | undefined;
  if (
    typeof rawDuration === 'number' &&
    Number.isFinite(rawDuration) &&
    rawDuration > 0 &&
    rawDuration <= limits.maxDurationSeconds
  ) {
    durationSeconds = rawDuration;
  } else if (rawDuration !== undefined && rawDuration !== null) {
    limitations.push('总时长无效或超出 24 小时边界，未用于评分。');
  }

  const repetitionRatio = validRatio(input.repetitionRatio);
  if (
    input.repetitionRatio !== undefined &&
    input.repetitionRatio !== null &&
    repetitionRatio === undefined
  ) {
    limitations.push('外部 repetition ratio 不在 0–1 范围，已改用本地估算。');
  }
  const evidenceCoverage = validRatio(input.evidenceCoverage);
  if (
    input.evidenceCoverage !== undefined &&
    input.evidenceCoverage !== null &&
    evidenceCoverage === undefined
  ) {
    limitations.push('外部 evidence coverage 不在 0–1 范围，已改用可核对引用估算。');
  }

  const rawTerms = input.userContext?.query_terms || [];
  const queryTerms = rawTerms
    .slice(0, limits.maxContextTerms)
    .map((term) => normalizeText(term).slice(0, 80))
    .filter((term) => term.length >= 2);
  const relevantSegmentIds = uniqueNonEmpty(
    (input.userContext?.relevant_segment_ids || []).slice(0, limits.maxSegments),
  );
  const userContext =
    queryTerms.length || relevantSegmentIds.length
      ? {
          query_terms: queryTerms,
          relevant_segment_ids: relevantSegmentIds,
          label: normalizeText(input.userContext?.label || '').slice(0, 160) || undefined,
        }
      : undefined;
  if (input.userContext && !userContext) {
    limitations.push('知识库上下文没有可核对的关键词或片段引用，未计算 vault relevance。');
  }
  if (!userContext) limitations.push(LIMITATION_NO_VAULT);

  return {
    segments,
    claims,
    durationSeconds,
    repetitionRatio,
    evidenceCoverage,
    promotionalCues,
    userContext,
    contentType: input.contentType,
    limitations,
  };
}

function calculateLocalSignals(input: BoundedInput): LocalSignals {
  const texts = input.segments.map((segment) =>
    normalizeText(segment.text).slice(0, ATTENTION_ENGINE_POLICY.limits.maxSegmentCharacters),
  );
  const totalUnits = texts.reduce((sum, text) => sum + contentUnits(text), 0);
  const repetitionRatio = input.repetitionRatio ?? estimateRepetition(texts);
  const evidenceCoverage = input.evidenceCoverage ?? deriveEvidenceCoverage(input);
  const timingCoverage = deriveTimingCoverage(input.segments, input.durationSeconds);
  const durationMinutes = input.durationSeconds ? input.durationSeconds / 60 : undefined;
  const supportedClaims = supportedClaimsForInput(input);

  const informationComponents: Array<[number, number | undefined]> = [
    [0.45, durationMinutes ? clamp01(totalUnits / durationMinutes / 300) : undefined],
    [
      0.25,
      durationMinutes
        ? clamp01(supportedClaims.length / Math.max(durationMinutes * 1.5, 0.5))
        : input.claims.length
          ? clamp01(supportedClaims.length / Math.max(input.claims.length, 1))
          : undefined,
    ],
    [0.2, evidenceCoverage],
    [0.1, 1 - repetitionRatio],
  ];
  const informationDensity = clamp01(
    weightedAvailable(informationComponents) * (1 - 0.35 * repetitionRatio),
  );

  const claimDiversity =
    input.claims.length > 0
      ? clamp01(uniqueClaimRatio(input.claims) * Math.min(1, supportedClaims.length / 4))
      : undefined;
  const originality = Math.min(
    0.78,
    weightedAvailable([
      [0.68, 1 - repetitionRatio],
      [0.32, claimDiversity],
    ]),
  );

  const actionability = calculateActionability(input, texts, supportedClaims);
  const { score: vaultRelevance, segmentIds: contextSegmentIds } = calculateVaultRelevance(input);
  const { ratio: promotionalRatio, segmentIds: promotionalSegmentIds } = calculatePromotionalRatio(
    input,
    texts,
  );
  const duplicatedSegmentIds = duplicateSegmentIds(input.segments);
  const baseConfidence = calculateConfidence(input, totalUnits, evidenceCoverage, timingCoverage);
  const confidence = Math.min(baseConfidence, reliabilityCeiling(input, undefined, false));
  const { positiveScore, score } = calculateScore({
    informationDensity,
    originality,
    actionability,
    vaultRelevance,
    promotionalRatio,
  });

  return {
    informationDensity,
    originality,
    actionability,
    vaultRelevance,
    promotionalRatio,
    repetitionRatio,
    evidenceCoverage,
    confidence,
    timingCoverage,
    positiveScore,
    score,
    contextSegmentIds,
    promotionalSegmentIds,
    duplicatedSegmentIds,
  };
}

function calculateActionability(
  input: BoundedInput,
  texts: string[],
  supportedClaims: EvidenceClaim[],
): number {
  const totalWeight = Math.max(
    1,
    texts.reduce((sum, text) => sum + Math.max(1, contentUnits(text)), 0),
  );
  const actionableWeight = texts.reduce(
    (sum, text) =>
      sum + (hasAnyPattern(text, ACTION_PATTERNS) ? Math.max(1, contentUnits(text)) : 0),
    0,
  );
  const actionableClaimRatio =
    supportedClaims.length > 0
      ? supportedClaims.filter((claim) => hasAnyPattern(claim.claim, ACTION_PATTERNS)).length /
        supportedClaims.length
      : undefined;
  const contentTypePrior =
    input.contentType === 'tutorial'
      ? 0.9
      : input.contentType === 'course'
        ? 0.7
        : input.contentType === 'review'
          ? 0.35
          : undefined;
  return weightedAvailable([
    [0.65, actionableWeight / totalWeight],
    [0.2, actionableClaimRatio],
    [0.15, contentTypePrior],
  ]);
}

function calculateVaultRelevance(input: BoundedInput): {
  score?: number;
  segmentIds: Set<string>;
} {
  const context = input.userContext;
  const matchedIds = new Set<string>();
  if (!context) return { segmentIds: matchedIds };
  const validIds = new Set(input.segments.map((segment) => segment.id));
  for (const id of context.relevant_segment_ids || []) {
    if (validIds.has(id)) matchedIds.add(id);
  }
  const terms = (context.query_terms || []).map(normalizeSearchText).filter(Boolean);
  for (const segment of input.segments) {
    const searchable = normalizeSearchText(segment.text);
    if (terms.some((term) => searchable.includes(term))) matchedIds.add(segment.id);
  }
  const totalWeight = input.segments.reduce((sum, segment) => sum + segmentWeight(segment), 0);
  if (totalWeight <= 0) return { score: 0, segmentIds: matchedIds };
  const matchedWeight = input.segments
    .filter((segment) => matchedIds.has(segment.id))
    .reduce((sum, segment) => sum + segmentWeight(segment), 0);
  return { score: clamp01(matchedWeight / totalWeight), segmentIds: matchedIds };
}

function calculatePromotionalRatio(
  input: BoundedInput,
  texts: string[],
): { ratio: number; segmentIds: Set<string> } {
  const ids = new Set<string>();
  const segmentById = new Map(input.segments.map((segment) => [segment.id, segment]));
  input.segments.forEach((segment, index) => {
    if (hasAnyPattern(texts[index], PROMOTIONAL_PATTERNS)) ids.add(segment.id);
  });

  const cueRanges: Array<{ start: number; end: number }> = [];
  for (const cue of input.promotionalCues) {
    if (cue.confidence !== undefined) {
      const cueConfidence = validRatio(cue.confidence);
      if (cueConfidence === undefined || cueConfidence < 0.35) continue;
    }
    if (cue.segment_id && segmentById.has(cue.segment_id)) ids.add(cue.segment_id);
    if (
      finiteNonNegative(cue.start) &&
      finiteNonNegative(cue.end) &&
      (cue.end as number) > (cue.start as number)
    ) {
      const start = cue.start as number;
      const end = input.durationSeconds
        ? Math.min(cue.end as number, input.durationSeconds)
        : (cue.end as number);
      if (end > start) cueRanges.push({ start, end });
      for (const segment of input.segments) {
        if (segmentOverlaps(segment, start, end)) ids.add(segment.id);
      }
    }
  }

  const totalSegmentWeight = input.segments.reduce(
    (sum, segment) => sum + segmentWeight(segment),
    0,
  );
  const promotionalWeight = input.segments
    .filter((segment) => ids.has(segment.id))
    .reduce((sum, segment) => sum + segmentWeight(segment), 0);
  const contentRatio = totalSegmentWeight > 0 ? clamp01(promotionalWeight / totalSegmentWeight) : 0;
  const durationRatio =
    input.durationSeconds && cueRanges.length
      ? clamp01(mergedDuration(cueRanges) / input.durationSeconds)
      : 0;
  return { ratio: Math.max(contentRatio, durationRatio), segmentIds: ids };
}

function calculateConfidence(
  input: BoundedInput,
  totalUnits: number,
  evidenceCoverage: number | undefined,
  timingCoverage: number,
): number {
  const textSufficiency = clamp01(totalUnits / 500);
  const segmentSufficiency = clamp01(input.segments.length / 8);
  const durationSignal = input.durationSeconds ? 1 : timingCoverage > 0 ? 0.55 : 0.15;
  const evidenceSignal = evidenceCoverage === undefined ? 0.2 : 0.35 + 0.65 * evidenceCoverage;
  return clamp01(
    0.25 * textSufficiency +
      0.15 * segmentSufficiency +
      0.2 * durationSignal +
      0.2 * evidenceSignal +
      0.2 * timingCoverage,
  );
}

function reliabilityCeiling(
  input: BoundedInput,
  local: LocalSignals | undefined,
  backend: boolean,
): number {
  const hasTimed = timedSegments(input.segments, input.durationSeconds).length > 0;
  const totalUnits = input.segments.reduce((sum, segment) => sum + contentUnits(segment.text), 0);
  if (input.segments.length === 0 || totalUnits < 20) return 0.22;
  if (!input.durationSeconds && !hasTimed) return 0.34;
  if (totalUnits < 80) return 0.4;
  if (!input.durationSeconds) return 0.55;
  if (!hasTimed) return backend ? 0.66 : 0.58;
  if (local?.evidenceCoverage === undefined && input.evidenceCoverage === undefined) {
    return backend ? 0.78 : 0.66;
  }
  return backend ? 0.92 : 0.78;
}

function calculateScore(metrics: {
  informationDensity: number;
  originality: number;
  actionability: number;
  vaultRelevance?: number;
  promotionalRatio: number;
}): { positiveScore: number; score: number } {
  const weights = ATTENTION_ENGINE_POLICY.scoreWeights;
  const positiveScore = weightedAvailable([
    [weights.informationDensity, clamp01(metrics.informationDensity)],
    [weights.originality, clamp01(metrics.originality)],
    [weights.actionability, clamp01(metrics.actionability)],
    [weights.vaultRelevance, validRatio(metrics.vaultRelevance)],
  ]);
  return {
    positiveScore,
    score: clamp01(
      positiveScore -
        ATTENTION_ENGINE_POLICY.promotionalPenalty * clamp01(metrics.promotionalRatio),
    ),
  };
}

function chooseAction(
  score: number,
  confidence: number,
  promotionalRatio: number,
  durationSeconds?: number,
): AttentionAssessment['action'] {
  const thresholds = ATTENTION_ENGINE_POLICY.actionThresholds;
  if (confidence < thresholds.minimumDecisionConfidence) return 'skim';
  if (
    promotionalRatio >= thresholds.highPromotion &&
    score < thresholds.highPromotionMaximumScore
  ) {
    return 'skip';
  }
  if (
    durationSeconds !== undefined &&
    durationSeconds <= thresholds.shortVideoSeconds &&
    score >= thresholds.shortVideoWatchScore &&
    promotionalRatio < 0.45
  ) {
    return 'watch';
  }
  if (score >= thresholds.watch) return 'watch';
  if (score <= thresholds.skip) return 'skip';
  return 'skim';
}

function deriveRanges(
  input: BoundedInput,
  signals: LocalSignals,
): { mustWatch?: AttentionRange[]; skippable?: AttentionRange[] } {
  const valid = timedSegments(input.segments, input.durationSeconds);
  if (!valid.length) return {};
  const supportedIds = new Set(supportedEvidenceSegmentIds(input));
  const ranked = valid.map((segment) => {
    const isPromo = signals.promotionalSegmentIds.has(segment.id);
    const value = clamp01(
      0.05 +
        0.3 * (supportedIds.has(segment.id) ? 1 : 0) +
        0.2 * (hasAnyPattern(segment.text, ACTION_PATTERNS) ? 1 : 0) +
        0.18 * clamp01(contentUnits(segment.text) / 100) +
        0.17 * (signals.contextSegmentIds.has(segment.id) ? 1 : 0) +
        0.1 * (isPromo ? 0 : 1),
    );
    return { segment, value, isPromo };
  });

  const mustWatch = ranked
    .filter((item) => !item.isPromo && item.value >= 0.52)
    .sort((left, right) => right.value - left.value)
    .slice(0, 5)
    .sort((left, right) => (left.segment.start || 0) - (right.segment.start || 0))
    .map(({ segment }) => ({
      start: segment.start as number,
      end: segment.end as number,
      reason: supportedIds.has(segment.id)
        ? '有可核对主张支持的高价值片段'
        : signals.contextSegmentIds.has(segment.id)
          ? '与提供的知识库上下文直接相关'
          : '信息密度或可操作性较高',
    }));
  const skippable = ranked
    .filter(
      ({ segment, isPromo }) =>
        isPromo || (signals.duplicatedSegmentIds.has(segment.id) && !supportedIds.has(segment.id)),
    )
    .slice(0, 5)
    .map(({ segment, isPromo }) => ({
      start: segment.start as number,
      end: segment.end as number,
      reason: isPromo ? '推广或行动号召占主导' : '与前文高度重复且没有独立证据主张',
    }));
  return {
    mustWatch: mustWatch.length ? mustWatch : undefined,
    skippable: skippable.length ? skippable : undefined,
  };
}

function estimateUsefulSeconds(
  input: BoundedInput,
  positiveScore: number,
  promotionalRatio: number,
  limitations: string[],
): number | undefined {
  let span = input.durationSeconds;
  if (!span) {
    const timed = timedSegments(input.segments);
    if (timed.length) {
      span = timed.reduce(
        (sum, segment) => sum + ((segment.end as number) - (segment.start as number)),
        0,
      );
      limitations.push('未提供总时长，预计高价值秒数只覆盖已有可靠时间片段。');
    }
  }
  if (!span || span <= 0) return undefined;
  const usefulFraction = clamp01(0.08 + 0.82 * positiveScore - 0.65 * promotionalRatio);
  return Math.min(Math.round(span), Math.max(0, Math.round(span * usefulFraction)));
}

function validateBackendCore(
  raw: unknown,
  input: BoundedInput,
  rejectionReasons: string[],
): BackendCore | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    rejectionReasons.push('后端结果不是对象。');
    return undefined;
  }
  const value = raw as Record<string, unknown>;
  const informationDensity = strictRatio(value.information_density);
  const originality = strictRatio(value.originality);
  const actionability = strictRatio(value.actionability);
  const promotionalRatio = strictRatio(value.promotional_ratio);
  const confidence = strictRatio(value.confidence);
  const rationale = typeof value.rationale === 'string' ? normalizeText(value.rationale) : '';
  if (
    informationDensity === undefined ||
    originality === undefined ||
    actionability === undefined ||
    promotionalRatio === undefined ||
    confidence === undefined ||
    !rationale
  ) {
    rejectionReasons.push(
      '后端缺少 0–1 核心指标（information density、originality、actionability、promotional ratio、confidence）或 rationale。',
    );
    return undefined;
  }
  const contextRelevance = calculateVaultRelevance(input).score;
  if (value.vault_relevance !== undefined && contextRelevance === undefined) {
    rejectionReasons.push('后端在没有可核对知识库上下文时返回了 vault relevance。');
    return undefined;
  }
  if (value.vault_relevance !== undefined && strictRatio(value.vault_relevance) === undefined) {
    rejectionReasons.push('后端 vault relevance 不在 0–1 范围。');
    return undefined;
  }

  const validIds = new Set(input.segments.map((segment) => segment.id));
  const evidenceSegmentIds = Array.isArray(value.evidence_segment_ids)
    ? uniqueNonEmpty(value.evidence_segment_ids.map(String)).filter((id) => validIds.has(id))
    : undefined;
  const rangeLimitations: string[] = [];
  const mustWatch = validateBackendRanges(value.must_watch, input, rangeLimitations);
  const skippable = validateBackendRanges(value.skippable, input, rangeLimitations);
  const limitations = [
    ...(Array.isArray(value.limitations)
      ? value.limitations
          .filter((item): item is string => typeof item === 'string')
          .map(normalizeText)
          .filter(Boolean)
          .slice(0, 20)
      : []),
    ...rangeLimitations,
  ];
  const action =
    value.action === 'watch' || value.action === 'skim' || value.action === 'skip'
      ? value.action
      : undefined;
  return {
    informationDensity,
    originality,
    actionability,
    promotionalRatio,
    confidence,
    rationale,
    context:
      typeof value.context === 'string' ? normalizeText(value.context) || undefined : undefined,
    action,
    score: strictRatio(value.score),
    evidenceSegmentIds,
    limitations,
    mustWatch,
    skippable,
  };
}

function validateBackendRanges(
  raw: unknown,
  input: BoundedInput,
  limitations: string[],
): AttentionRange[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const anchors = timedSegments(input.segments, input.durationSeconds);
  const valid: AttentionRange[] = [];
  let rejected = 0;
  for (const item of raw.slice(0, 20)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      rejected += 1;
      continue;
    }
    const range = item as Record<string, unknown>;
    const start = typeof range.start === 'number' ? range.start : undefined;
    const end = typeof range.end === 'number' ? range.end : undefined;
    const reason = typeof range.reason === 'string' ? normalizeText(range.reason) : '';
    if (
      !finiteNonNegative(start) ||
      !finiteNonNegative(end) ||
      (end as number) <= (start as number) ||
      !reason ||
      !anchors.some(
        (segment) =>
          (start as number) >= (segment.start as number) - 0.001 &&
          (end as number) <= (segment.end as number) + 0.001,
      )
    ) {
      rejected += 1;
      continue;
    }
    valid.push({ start: start as number, end: end as number, reason });
  }
  if (rejected) {
    limitations.push(`后端有 ${rejected} 个时间段无法锚定到真实片段，已丢弃。`);
  }
  return valid.length ? valid : undefined;
}

function deriveEvidenceCoverage(input: BoundedInput): number | undefined {
  if (!input.claims.length) return undefined;
  return supportedClaimsForInput(input).length / input.claims.length;
}

function supportedClaimsForInput(input: BoundedInput): EvidenceClaim[] {
  const ids = new Set(input.segments.map((segment) => segment.id));
  return input.claims.filter(
    (claim) =>
      claim.review_state !== 'needs-review' &&
      claim.evidence.some((reference) => ids.has(reference.segment_id)),
  );
}

function supportedEvidenceSegmentIds(input: BoundedInput): string[] {
  const validIds = new Set(input.segments.map((segment) => segment.id));
  return uniqueNonEmpty(
    supportedClaimsForInput(input).flatMap((claim) =>
      claim.evidence.map((reference) => reference.segment_id),
    ),
  ).filter((id) => validIds.has(id));
}

function deriveTimingCoverage(segments: VideoSegment[], durationSeconds?: number): number {
  if (!segments.length) return 0;
  const timed = timedSegments(segments, durationSeconds);
  if (durationSeconds) {
    return clamp01(
      mergedDuration(
        timed.map((segment) => ({
          start: segment.start as number,
          end: segment.end as number,
        })),
      ) / durationSeconds,
    );
  }
  return timed.length / segments.length;
}

function timedSegments(segments: VideoSegment[], durationSeconds?: number): VideoSegment[] {
  return segments
    .filter(
      (segment) =>
        finiteNonNegative(segment.start) &&
        finiteNonNegative(segment.end) &&
        (segment.end as number) > (segment.start as number) &&
        segment.timing_quality !== 'none' &&
        segment.timing_quality !== 'estimated',
    )
    .map((segment) => {
      if (!durationSeconds || (segment.end as number) <= durationSeconds) return segment;
      return { ...segment, end: durationSeconds };
    })
    .filter((segment) => (segment.end as number) > (segment.start as number));
}

function estimateRepetition(texts: string[]): number {
  const canonical = texts.map(normalizeSearchText).filter(Boolean);
  if (!canonical.length) return 0;
  const exactRatio = 1 - new Set(canonical).size / canonical.length;
  const tokens = canonical.flatMap(lexicalTokens);
  if (tokens.length < 6) return clamp01(exactRatio);
  const ngrams: string[] = [];
  for (let index = 0; index <= tokens.length - 3; index += 1) {
    ngrams.push(tokens.slice(index, index + 3).join('\u0001'));
  }
  const rawNgramRepetition = 1 - new Set(ngrams).size / Math.max(ngrams.length, 1);
  const adjustedNgramRepetition = clamp01((rawNgramRepetition - 0.08) / 0.72);
  return Math.max(exactRatio, adjustedNgramRepetition);
}

function duplicateSegmentIds(segments: VideoSegment[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const segment of segments) {
    const canonical = normalizeSearchText(segment.text);
    if (!canonical) continue;
    if (seen.has(canonical)) duplicates.add(segment.id);
    else seen.add(canonical);
  }
  return duplicates;
}

function uniqueClaimRatio(claims: EvidenceClaim[]): number {
  if (!claims.length) return 0;
  return new Set(claims.map((claim) => normalizeSearchText(claim.claim))).size / claims.length;
}

function localRationale(signals: LocalSignals): string {
  const parts: string[] = [];
  if (signals.informationDensity >= 0.68) parts.push('信息密度较高');
  else if (signals.informationDensity <= 0.35) parts.push('信息密度有限');
  if (signals.actionability >= 0.58) parts.push('可直接执行的内容较多');
  if (signals.promotionalRatio >= 0.5) parts.push('推广内容占比较高');
  if (signals.repetitionRatio >= 0.45) parts.push('重复度较高');
  if (signals.vaultRelevance !== undefined && signals.vaultRelevance >= 0.5) {
    parts.push('与提供的知识库上下文相关');
  }
  return `${parts.length ? parts.join('，') : '现有证据呈现中等观看价值'}；这是透明规则的保守估算。`;
}

function weightedAvailable(values: Array<[number, number | undefined]>): number {
  let totalWeight = 0;
  let total = 0;
  for (const [weight, value] of values) {
    if (value === undefined || !Number.isFinite(value)) continue;
    totalWeight += weight;
    total += weight * clamp01(value);
  }
  return totalWeight > 0 ? clamp01(total / totalWeight) : 0;
}

function segmentWeight(segment: VideoSegment): number {
  const units = contentUnits(segment.text);
  if (
    finiteNonNegative(segment.start) &&
    finiteNonNegative(segment.end) &&
    (segment.end as number) > (segment.start as number)
  ) {
    return Math.max(units, ((segment.end as number) - (segment.start as number)) * 4);
  }
  return Math.max(1, units);
}

function segmentOverlaps(segment: VideoSegment, start: number, end: number): boolean {
  return (
    finiteNonNegative(segment.start) &&
    finiteNonNegative(segment.end) &&
    (segment.start as number) < end &&
    (segment.end as number) > start
  );
}

function mergedDuration(ranges: Array<{ start: number; end: number }>): number {
  const sorted = ranges
    .filter((range) => range.end > range.start)
    .sort((left, right) => left.start - right.start);
  if (!sorted.length) return 0;
  let total = 0;
  let start = sorted[0].start;
  let end = sorted[0].end;
  for (const range of sorted.slice(1)) {
    if (range.start <= end) {
      end = Math.max(end, range.end);
    } else {
      total += end - start;
      start = range.start;
      end = range.end;
    }
  }
  return total + end - start;
}

function contentUnits(text: string): number {
  const latinWords = text.match(/[\p{L}\p{N}]+/gu) || [];
  const cjkCharacters =
    text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu) || [];
  const nonCjkWords = latinWords.filter(
    (word) => !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(word),
  );
  return nonCjkWords.length * 2 + cjkCharacters.length;
}

function lexicalTokens(text: string): string[] {
  return (
    normalizeSearchText(text).match(
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[\p{L}\p{N}]+/gu,
    ) || []
  );
}

function hasAnyPattern(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function normalizeText(value: string): string {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeSearchText(value: string): string {
  return normalizeText(value).toLocaleLowerCase();
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function strictRatio(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : undefined;
}

function validRatio(value: unknown): number | undefined {
  return value === undefined ? undefined : strictRatio(value);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function uniqueNonEmpty(values: readonly string[]): string[] {
  return Array.from(new Set(values.map((value) => normalizeText(value)).filter(Boolean)));
}
