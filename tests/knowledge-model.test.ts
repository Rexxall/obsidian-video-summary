import { strict as assert } from 'node:assert';
import { test } from 'node:test';
type KnowledgeModelModule = typeof import('../core/KnowledgeModel');
// @ts-expect-error Node's strip-types test runner loads this TypeScript source directly.
const knowledgeModel: KnowledgeModelModule = await import('../core/KnowledgeModel.ts');
const {
  VIDEO_ARTIFACT_SCHEMA_VERSION,
  normalizeRichProcessingResult,
  parseTranscriptSegments,
  stableSegmentId,
} = knowledgeModel;

const YOUTUBE_URL = 'https://www.youtube.com/watch?v=knowledge-fixture';

test('parses SRT cues with exact start/end times and strips inline styling', () => {
  const transcript = `1
00:00:01,250 --> 00:00:03,500
<i>Hello</i> world

2
00:01:02,000 --> 00:01:05,125
Second cue`;

  const segments = parseTranscriptSegments(transcript, YOUTUBE_URL);

  assert.equal(segments.length, 2);
  assert.deepEqual(
    segments.map(({ start, end, text, timing_quality }) => ({
      start,
      end,
      text,
      timing_quality,
    })),
    [
      { start: 1.25, end: 3.5, text: 'Hello world', timing_quality: 'exact' },
      { start: 62, end: 65.125, text: 'Second cue', timing_quality: 'exact' },
    ],
  );
  assert.equal(new URL(segments[0].timestamp_url!).searchParams.get('t'), '1s');
});

test('parses WEBVTT cue identifiers and timing-line settings without turning headers into text', () => {
  const transcript = `WEBVTT
Kind: captions
Language: en

intro-cue
00:00:05.000 --> 00:00:07.250 align:start position:0%
<v Alice>Hello from VTT</v>

second-cue
00:00:08.500 --> 00:00:09.750
Another line`;

  const segments = parseTranscriptSegments(transcript, YOUTUBE_URL);

  assert.equal(segments.length, 2);
  assert.deepEqual(
    segments.map(({ start, end, text }) => ({ start, end, text })),
    [
      { start: 5, end: 7.25, text: 'Hello from VTT' },
      { start: 8.5, end: 9.75, text: 'Another line' },
    ],
  );
});

test('parses [MM:SS], (MM:SS), and H:MM:SS prefixes and closes the previous range', () => {
  const transcript = `[00:05] Opening
(01:02) Main point
[1:02:03] Long-form conclusion`;

  const segments = parseTranscriptSegments(transcript, YOUTUBE_URL);

  assert.deepEqual(
    segments.map(({ start, end, text }) => ({ start, end, text })),
    [
      { start: 5, end: 62, text: 'Opening' },
      { start: 62, end: 3723, text: 'Main point' },
      { start: 3723, end: undefined, text: 'Long-form conclusion' },
    ],
  );
  assert.ok(segments.every((segment) => segment.timing_quality === 'exact'));
});

test('plain untimed text remains untimed and never receives a clickable 0:00 link', () => {
  const result = normalizeRichProcessingResult(
    {
      video_transcript: '第一段没有时间。\n第二段也没有时间。',
    },
    {
      timing_quality: 'exact',
    },
    { sourceUrl: YOUTUBE_URL },
  );

  assert.equal(result.timing_quality, 'none');
  assert.equal(result.video_segments?.length, 2);
  for (const segment of result.video_segments || []) {
    assert.equal(segment.start, null);
    assert.equal(segment.timing_quality, 'none');
    assert.equal(segment.timestamp_url, undefined);
  }
  assert.ok(result.artifact?.warnings?.some((warning) => warning.includes('没有可靠时间轴')));
});

test('null, empty, and boolean timestamp placeholders do not coerce to zero', () => {
  for (const start of [null, '', false]) {
    const result = normalizeRichProcessingResult(
      {},
      {
        timing_quality: 'exact',
        video_segments: [{ id: `placeholder-${String(start)}`, start, text: 'Untimed cue' }],
      },
      { sourceUrl: YOUTUBE_URL },
    );

    assert.equal(result.timing_quality, 'none');
    assert.equal(result.video_segments?.[0].start, null);
    assert.equal(result.video_segments?.[0].timing_quality, 'none');
    assert.equal(result.video_segments?.[0].timestamp_url, undefined);
  }
});

test('stable IDs repeat for unchanged evidence and change with source, time, or text', () => {
  const first = stableSegmentId(YOUTUBE_URL, 12.5, '  Same   evidence  ');
  const same = stableSegmentId(YOUTUBE_URL, 12.5, 'Same evidence');
  const hashOnlyDifference = stableSegmentId(`${YOUTUBE_URL}#chapter`, 12.5, 'Same evidence');

  assert.equal(first, same);
  assert.equal(first, hashOnlyDifference);
  assert.notEqual(first, stableSegmentId(YOUTUBE_URL, 13.5, 'Same evidence'));
  assert.notEqual(first, stableSegmentId(YOUTUBE_URL, 12.5, 'Different evidence'));
  assert.notEqual(
    first,
    stableSegmentId('https://www.youtube.com/watch?v=other', 12.5, 'Same evidence'),
  );
});

test('normalizes a legacy flat result without inventing rich timing data', () => {
  const result = normalizeRichProcessingResult(
    {
      summary: 'Legacy summary',
      video_title: 'Legacy title',
      video_transcript: 'Legacy transcript without timestamps.',
    },
    {
      video_author: 'Legacy author',
      platform: 'youtube',
    },
    {
      sourceUrl: YOUTUBE_URL,
      backend: 'n8n',
      model: 'fixture-model',
    },
  );

  assert.equal(result.summary, 'Legacy summary');
  assert.equal(result.video_title, 'Legacy title');
  assert.equal(result.video_platform, 'youtube');
  assert.equal(result.timing_quality, 'none');
  assert.equal(result.video_segments?.[0].start, null);
  assert.equal(result.artifact?.schema_version, VIDEO_ARTIFACT_SCHEMA_VERSION);
  assert.equal(result.artifact?.backend, 'n8n');
  assert.equal(result.artifact?.model, 'fixture-model');
});

test('normalizes rich payload aliases, provenance, routing, and attention data', () => {
  const result = normalizeRichProcessingResult(
    { summary: 'Rich summary' },
    {
      video_platform: 'youtube',
      transcript_segments: [
        {
          id: 'cue one',
          start_seconds: 4.5,
          end_seconds: 8,
          text: 'A timed statement',
          timing_quality: 'aligned',
        },
      ],
      claims: [
        {
          id: 'claim one',
          claim: 'The statement is supported.',
          segment_ids: ['cue one'],
          source: 'speech',
        },
      ],
      resolved_content_type: 'tutorial',
      attention_assessment: {
        action: 'watch',
        score: 82,
        confidence: 0.9,
        rationale: 'Dense and actionable.',
        evidence_segment_ids: ['cue one'],
        must_watch: [{ start_seconds: 4.5, end_seconds: 8, reason: 'Core step' }],
      },
      artifact: {
        provenance: {
          artifact_id: 'artifact-fixture',
          source_hash: 'source-fixture',
          transcript_hash: 'transcript-fixture',
          prompt_version: 'v3-fixture',
        },
      },
    },
    { sourceUrl: YOUTUBE_URL, processingDepth: 'evidence' },
  );

  assert.equal(result.video_segments?.[0].id, 'cue-one');
  assert.equal(result.video_segments?.[0].timing_quality, 'aligned');
  assert.equal(result.timing_quality, 'aligned');
  assert.equal(result.evidence_claims?.[0].evidence[0].segment_id, 'cue-one');
  assert.equal(result.content_type, 'tutorial');
  assert.equal(result.attention?.score, 0.82);
  assert.equal(result.attention?.must_watch?.[0].start, 4.5);
  assert.equal(result.artifact?.artifact_id, 'artifact-fixture');
  assert.equal(result.artifact?.processing_depth, 'evidence');
});

test('retains valid multi-channel evidence and rejects references to missing segments', () => {
  const result = normalizeRichProcessingResult(
    {},
    {
      video_segments: [{ id: 'segment one', start: 10, end: 12, text: 'Ground truth' }],
      evidence_claims: [
        {
          id: 'multi-channel',
          claim: 'Speech and screen both support this.',
          review_state: 'supported',
          evidence: [
            { segment_id: 'segment one', source: 'speech', quote: 'Ground truth' },
            { segment_id: 'segment one', source: 'screen', quote: 'On-screen text' },
          ],
        },
        {
          id: 'invalid-reference',
          claim: 'This cites evidence that does not exist.',
          review_state: 'supported',
          evidence: [{ segment_id: 'missing-segment', source: 'speech' }, { source: 'screen' }],
        },
      ],
    },
    { sourceUrl: YOUTUBE_URL },
  );

  const multi = result.evidence_claims?.find((claim) => claim.id === 'multi-channel');
  assert.deepEqual(
    multi?.evidence.map(({ segment_id, source }) => ({ segment_id, source })),
    [
      { segment_id: 'segment-one', source: 'speech' },
      { segment_id: 'segment-one', source: 'screen' },
    ],
  );
  assert.equal(multi?.review_state, 'supported');

  const invalid = result.evidence_claims?.find((claim) => claim.id === 'invalid-reference');
  assert.deepEqual(invalid?.evidence, []);
  assert.equal(invalid?.review_state, 'needs-review');
});

test('mixed timed and untimed segments expose per-segment truth but aggregate conservatively', () => {
  const result = normalizeRichProcessingResult(
    {},
    {
      video_segments: [
        { id: 'timed', start: 3, end: 4, text: 'Timed evidence' },
        { id: 'untimed', start: null, text: 'Untimed evidence' },
      ],
    },
    { sourceUrl: YOUTUBE_URL },
  );

  assert.equal(result.video_segments?.[0].timing_quality, 'exact');
  assert.equal(result.video_segments?.[1].timing_quality, 'none');
  assert.equal(result.video_segments?.[1].timestamp_url, undefined);
  assert.equal(result.timing_quality, 'none');
});
