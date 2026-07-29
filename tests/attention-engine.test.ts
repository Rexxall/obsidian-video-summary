import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  applyAttentionAssessment,
  ATTENTION_ENGINE_POLICY,
  chooseAttentionAction,
  evaluateAttention,
  parseDurationSeconds,
} from '../core/AttentionEngine';
import type { EvidenceClaim, ProcessingResult, VideoSegment } from '../types';

test('policy exposes stable weights and thresholds instead of hiding scoring magic', () => {
  const weights = ATTENTION_ENGINE_POLICY.scoreWeights;
  assert.equal(
    weights.informationDensity +
      weights.originality +
      weights.actionability +
      weights.vaultRelevance,
    1,
  );
  assert.equal(ATTENTION_ENGINE_POLICY.formulaVersion, 'attention-v1');
  assert.ok(
    ATTENTION_ENGINE_POLICY.actionThresholds.skip < ATTENTION_ENGINE_POLICY.actionThresholds.watch,
  );
});

test('high-value Chinese course crosses the watch boundary with explainable metrics', () => {
  const segments = fixtureSegments('zh', 8);
  const claims = supportedClaims(segments, 6);
  const { assessment, diagnostics } = evaluateAttention({
    segments,
    claims,
    durationSeconds: 240,
    contentType: 'course',
    repetitionRatio: 0.04,
    evidenceCoverage: 1,
    userContext: {
      query_terms: ['证据链', '实验设计', '复现'],
      relevant_segment_ids: segments.slice(0, 5).map((segment) => segment.id),
      label: '当前研究方法知识库',
    },
  });

  assert.equal(assessment.action, 'watch');
  assert.ok((assessment.score || 0) >= ATTENTION_ENGINE_POLICY.actionThresholds.watch);
  assert.ok((assessment.information_density || 0) > 0.65);
  assert.ok((assessment.actionability || 0) > 0.65);
  assert.ok((assessment.vault_relevance || 0) > 0.5);
  assert.equal(assessment.promotional_ratio, 0);
  assert.ok((assessment.estimated_useful_seconds || 0) <= 240);
  assert.ok((assessment.estimated_useful_seconds || 0) > 150);
  assert.equal(diagnostics.evidence_coverage, 1);
  assert.equal(diagnostics.repetition_ratio, 0.04);
  assertRangesComeFromSegments(assessment.must_watch, segments);
});

test('short actionable English video is worth watching because the time cost is bounded', () => {
  const segments = fixtureSegments('en', 3, 15);
  const result = evaluateAttention({
    segments,
    claims: supportedClaims(segments, 3),
    durationSeconds: 45,
    contentType: 'tutorial',
    repetitionRatio: 0.02,
    evidenceCoverage: 1,
  }).assessment;

  assert.equal(result.action, 'watch');
  assert.ok((result.score || 0) >= ATTENTION_ENGINE_POLICY.actionThresholds.shortVideoWatchScore);
  assert.ok((result.actionability || 0) > 0.7);
  assert.ok((result.estimated_useful_seconds || 0) <= 45);
});

test('Japanese procedural cues are detected without an English-only tokenizer', () => {
  const segments = fixtureSegments('ja', 5, 20);
  const result = evaluateAttention({
    segments,
    claims: supportedClaims(segments, 4),
    durationSeconds: 100,
    contentType: 'tutorial',
    evidenceCoverage: 0.8,
    repetitionRatio: 0.08,
  }).assessment;

  assert.ok((result.actionability || 0) > 0.65);
  assert.ok((result.information_density || 0) > 0.5);
  assert.notEqual(result.action, 'skip');
});

test('untimed evidence stays low-confidence and never fabricates attention ranges', () => {
  const result = evaluateAttention({
    segments: [
      untimed(
        'no-time-1',
        '首先解释实验设计和主要假设，然后给出可以复现的检查步骤。这段文字足够长，但没有任何可靠时间轴。',
      ),
      untimed(
        'no-time-2',
        'The transcript explains how to verify the result and compare alternatives, but it has no timestamp alignment.',
      ),
    ],
    claims: [],
    contentType: 'tutorial',
  });

  assert.equal(result.assessment.action, 'skim');
  assert.ok((result.assessment.confidence || 1) <= 0.34);
  assert.equal(result.assessment.must_watch, undefined);
  assert.equal(result.assessment.skippable, undefined);
  assert.equal(result.assessment.estimated_useful_seconds, undefined);
  assert.equal(result.assessment.vault_relevance, undefined);
  assert.ok(result.assessment.limitations?.some((item) => item.includes('未计算 vault relevance')));
  assert.ok(result.assessment.limitations?.some((item) => item.includes('没有可靠的起止时间')));
});

test('a high promotional share triggers skip and only marks real ad segments skippable', () => {
  const segments = fixtureSegments('en', 10, 10);
  const promotionalIds = segments.slice(0, 8).map((segment) => segment.id);
  const result = evaluateAttention({
    segments,
    claims: supportedClaims(segments.slice(8), 2),
    durationSeconds: 100,
    evidenceCoverage: 1,
    repetitionRatio: 0.05,
    promotionalCues: promotionalIds.map((segment_id) => ({
      segment_id,
      confidence: 0.95,
      reason: 'sponsor block',
    })),
  }).assessment;

  assert.equal(result.action, 'skip');
  assert.ok((result.promotional_ratio || 0) >= 0.75);
  assert.ok((result.estimated_useful_seconds || 100) < 50);
  assert.equal(result.skippable?.length, 5);
  assertRangesComeFromSegments(result.skippable, segments);
  for (const range of result.skippable || []) {
    const source = segments.find(
      (segment) => segment.start === range.start && segment.end === range.end,
    );
    assert.ok(source && promotionalIds.includes(source.id));
  }
});

test('vault relevance is evidence-derived and never defaults to a plausible-looking midpoint', () => {
  const segments = fixtureSegments('zh', 4, 20);
  const withoutContext = evaluateAttention({
    segments,
    durationSeconds: 80,
  }).assessment;
  const withContext = evaluateAttention({
    segments,
    durationSeconds: 80,
    userContext: {
      query_terms: ['仅第一段专属主题'],
      relevant_segment_ids: [segments[0].id],
    },
  }).assessment;

  assert.equal(withoutContext.vault_relevance, undefined);
  assert.ok(typeof withContext.vault_relevance === 'number');
  assert.ok((withContext.vault_relevance || 0) > 0);
  assert.ok((withContext.vault_relevance || 0) < 1);
});

test('invalid or incomplete backend attention falls back conservatively', () => {
  const segments = fixtureSegments('en', 4, 20);
  const evaluation = evaluateAttention({
    segments,
    claims: supportedClaims(segments, 2),
    durationSeconds: 80,
    backendAssessment: {
      action: 'watch',
      score: 0.99,
      confidence: 0.99,
      rationale: 'Trust me.',
      vault_relevance: 0.9,
    },
  });

  assert.equal(evaluation.diagnostics.source, 'local-fallback');
  assert.ok(evaluation.diagnostics.backend_rejection_reasons.length > 0);
  assert.equal(evaluation.assessment.vault_relevance, undefined);
  assert.ok(evaluation.assessment.limitations?.some((item) => item.includes('本地保守回退')));
});

test('out-of-range backend metrics are rejected instead of clamped into credible output', () => {
  const segments = fixtureSegments('en', 4, 20);
  const evaluation = evaluateAttention({
    segments,
    durationSeconds: 80,
    backendAssessment: {
      action: 'skip',
      score: -50,
      confidence: Number.POSITIVE_INFINITY,
      rationale: 'Injected result.',
      information_density: 4,
      originality: -1,
      actionability: 8,
      promotional_ratio: 99,
      must_watch: [{ start: -10, end: 99_999, reason: 'Unbounded.' }],
    },
  });

  assert.equal(evaluation.diagnostics.source, 'local-fallback');
  assert.ok(evaluation.diagnostics.backend_rejection_reasons.length > 0);
  assert.ok((evaluation.assessment.confidence || 0) <= 0.78);
  assertRangesComeFromSegments(evaluation.assessment.must_watch, segments);
  assertRangesComeFromSegments(evaluation.assessment.skippable, segments);
});

test('watch/skim/skip thresholds have explicit inclusive boundary behavior', () => {
  const thresholds = ATTENTION_ENGINE_POLICY.actionThresholds;
  assert.equal(chooseAttentionAction(thresholds.watch, 0.8, 0.1, 600), 'watch');
  assert.equal(chooseAttentionAction(thresholds.skip, 0.8, 0.1, 600), 'skip');
  assert.equal(
    chooseAttentionAction(0, thresholds.minimumDecisionConfidence - 0.01, 1, 600),
    'skim',
  );
  assert.equal(
    chooseAttentionAction(
      thresholds.highPromotionMaximumScore - 0.01,
      0.8,
      thresholds.highPromotion,
      600,
    ),
    'skip',
  );
});

test('valid backend metrics are used only after ranges and confidence are bounded by evidence', () => {
  const segments = fixtureSegments('en', 8, 20);
  const evaluation = evaluateAttention({
    segments,
    claims: supportedClaims(segments, 6),
    durationSeconds: 160,
    evidenceCoverage: 1,
    repetitionRatio: 0.05,
    backendAssessment: {
      action: 'watch',
      score: 0.8,
      confidence: 0.99,
      rationale: 'The lesson is dense, original, and directly actionable.',
      information_density: 0.86,
      originality: 0.78,
      actionability: 0.91,
      promotional_ratio: 0.04,
      evidence_segment_ids: [segments[0].id, 'missing-segment'],
      must_watch: [
        { start: 0, end: 10, reason: 'Anchored inside the first cue.' },
        { start: 999, end: 1_010, reason: 'Fabricated range.' },
      ],
    },
  });

  assert.equal(evaluation.diagnostics.source, 'backend');
  assert.equal(
    evaluation.assessment.rationale,
    'The lesson is dense, original, and directly actionable.',
  );
  assert.ok((evaluation.assessment.confidence || 0) <= 0.92);
  assert.deepEqual(evaluation.assessment.evidence_segment_ids, [segments[0].id]);
  assert.deepEqual(evaluation.assessment.must_watch, [
    { start: 0, end: 10, reason: 'Anchored inside the first cue.' },
  ]);
  assert.ok(evaluation.assessment.limitations?.some((item) => item.includes('无法锚定到真实片段')));
});

test('backend-supplied vault relevance without context is rejected as ungrounded', () => {
  const segments = fixtureSegments('ja', 5, 20);
  const evaluation = evaluateAttention({
    segments,
    durationSeconds: 100,
    backendAssessment: {
      action: 'watch',
      score: 0.8,
      confidence: 0.8,
      rationale: 'Relevant.',
      information_density: 0.8,
      originality: 0.8,
      actionability: 0.8,
      promotional_ratio: 0.05,
      vault_relevance: 0.9,
    },
  });

  assert.equal(evaluation.diagnostics.source, 'local-fallback');
  assert.equal(evaluation.assessment.vault_relevance, undefined);
  assert.ok(
    evaluation.diagnostics.backend_rejection_reasons.some((item) =>
      item.includes('没有可核对知识库上下文'),
    ),
  );
});

test('JobService integration helper is request-gated and parses common duration forms', () => {
  const segments = fixtureSegments('zh', 3, 20);
  const original: ProcessingResult = {
    video_duration: '01:00',
    video_segments: segments,
    evidence_claims: supportedClaims(segments, 2),
    content_type: 'tutorial',
    attention: {
      action: 'watch',
      confidence: 0.99,
      rationale: 'Incomplete backend payload.',
    },
  };

  assert.strictEqual(applyAttentionAssessment(original, { attentionAssessment: false }), original);
  const applied = applyAttentionAssessment(original, { attentionAssessment: true });
  assert.notStrictEqual(applied, original);
  assert.ok(applied.attention);
  assert.ok(applied.attention?.limitations?.some((item) => item.includes('本地保守回退')));
  assert.equal(parseDurationSeconds('12:34'), 754);
  assert.equal(parseDurationSeconds('1:02:03'), 3_723);
  assert.equal(parseDurationSeconds('PT2M5S'), 125);
  assert.equal(parseDurationSeconds('12:99'), undefined);
  assert.equal(parseDurationSeconds('invalid'), undefined);
});

function fixtureSegments(
  language: 'zh' | 'en' | 'ja',
  count: number,
  secondsPerSegment = 30,
): VideoSegment[] {
  const text = {
    zh: (index: number) =>
      `步骤 ${index + 1}：首先定义实验问题和证据链，然后使用对照组检查假设。接着记录参数、失败条件、复现结果与限制，并用具体示例比较替代方案，保证每个结论都可以复核。`,
    en: (index: number) =>
      `Step ${index + 1}: define the question and evidence chain, then configure the control and run the experiment. Check each assumption, record parameters and failure conditions, compare an alternative, and verify the reproducible result with a concrete example.`,
    ja: (index: number) =>
      `手順 ${index + 1}：まず研究の問いと証拠を定義し、次に対照条件を設定します。実行後に仮定を確認し、パラメータ、失敗条件、再現結果、制約を記録して、具体例と代替方法を比較してください。`,
  }[language];
  return Array.from({ length: count }, (_, index) => ({
    id: `${language}-segment-${index + 1}`,
    start: index * secondsPerSegment,
    end: (index + 1) * secondsPerSegment,
    text: text(index),
    source: 'speech',
    timing_quality: 'exact',
  }));
}

function supportedClaims(segments: VideoSegment[], count: number): EvidenceClaim[] {
  return Array.from({ length: Math.min(count, segments.length) }, (_, index) => ({
    id: `claim-${segments[index].id}`,
    claim:
      index % 2 === 0
        ? `Use step ${index + 1} to verify the result and record the reproducible evidence.`
        : `步骤 ${index + 1} 提供可执行、可复核的方法。`,
    evidence: [{ segment_id: segments[index].id, source: 'speech' }],
    review_state: 'supported',
  }));
}

function untimed(id: string, text: string): VideoSegment {
  return {
    id,
    start: null,
    text,
    source: 'speech',
    timing_quality: 'none',
  };
}

function assertRangesComeFromSegments(
  ranges: Array<{ start: number; end: number }> | undefined,
  segments: VideoSegment[],
): void {
  const realRanges = new Set(segments.map((segment) => `${segment.start}:${segment.end}`));
  for (const range of ranges || []) {
    assert.ok(
      realRanges.has(`${range.start}:${range.end}`),
      `not a real segment: ${range.start}-${range.end}`,
    );
  }
}
