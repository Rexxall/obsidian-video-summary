import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CrossModalMemoryIndex,
  applyReviewedRelationSuggestion,
  suggestArtifactRelation,
} from '../core/CrossModalMemory';
import type { VideoKnowledgeArtifact } from '../types';

test('cross-modal memory searches title, transcript, segment visual text, OCR, visual evidence and claims', () => {
  const index = new CrossModalMemoryIndex();
  index.rebuild([richArtifact('memory-one')]);

  assert.equal(index.search('Transformer lecture')[0].evidence_type, 'title');
  assert.equal(index.search('attention mechanism')[0].evidence_type, 'transcript');
  assert.equal(index.search('loss curve')[0].evidence_type, 'visual-text');
  const ocr = index.search('Accuracy 92%')[0];
  assert.equal(ocr.evidence_type, 'ocr');
  assert.equal(ocr.timestamp, 42);
  assert.equal(ocr.keyframe?.path, 'assets/frame-42.jpg');
  assert.equal(ocr.media_asset_root, 'Videos/_video-summary-assets');
  assert.match(ocr.timestamp_url || '', /t=42s/);
  assert.ok(ocr.highlights.length > 0);
  assert.ok(ocr.score_explanation.some((component) => component.name === 'field'));
  assert.equal(index.search('validation chart')[0].evidence_type, 'visual-evidence');
  assert.equal(index.search('sparse attention reduces compute')[0].evidence_type, 'claim');
});

test('memory filters author, platform, generated/updated dates, content type and course id', () => {
  const first = richArtifact('first');
  const second = richArtifact('second');
  second.author = 'Other Author';
  second.platform = 'bilibili';
  second.content_type = 'review';
  second.course_ids = ['course-beta'];
  second.provenance.generated_at = '2026-06-01T00:00:00Z';
  second.updated_at = '2026-06-02T00:00:00Z';
  const index = new CrossModalMemoryIndex();
  index.rebuild([first, second]);

  const query = 'attention mechanism';
  assert.deepEqual(uniqueIds(index.search(query, { filters: { author: 'Ada' } })), ['first']);
  assert.deepEqual(uniqueIds(index.search(query, { filters: { platform: 'bilibili' } })), [
    'second',
  ]);
  assert.deepEqual(uniqueIds(index.search(query, { filters: { content_type: 'course' } })), [
    'first',
  ]);
  assert.deepEqual(uniqueIds(index.search(query, { filters: { course_id: 'course-beta' } })), [
    'second',
  ]);
  assert.deepEqual(
    uniqueIds(
      index.search(query, {
        filters: {
          date_from: '2026-07-01',
          date_to: '2026-07-31',
          date_field: 'generated',
        },
      }),
    ),
    ['first'],
  );
});

test('a fresh index deterministically rebuilds from ArtifactStore after restart', async () => {
  const artifacts = [richArtifact('restart-one'), richArtifact('restart-two')];
  const first = new CrossModalMemoryIndex();
  await first.rebuildFromStore({ list: async () => artifacts });
  const before = first.search('loss curve').map(projectResult);

  const restarted = new CrossModalMemoryIndex();
  await restarted.rebuildFromStore({ list: async () => artifacts });
  const after = restarted.search('loss curve').map(projectResult);

  assert.deepEqual(after, before);
  assert.equal(restarted.getRecordCount(), first.getRecordCount());
});

test('relation suggestions are review-gated and only confirmed suggestions write related_notes', async () => {
  const source = richArtifact('source');
  const target = richArtifact('target');
  target.source.note_path = 'Videos/Target.md';
  const suggestion = suggestArtifactRelation(source, target);
  let writes = 0;
  let current = source;
  const store = {
    load: async () => current,
    updateRelatedNotes: async (
      _artifactId: string,
      updater:
        | VideoKnowledgeArtifact['related_notes']
        | ((
            value: readonly VideoKnowledgeArtifact['related_notes'][number][],
          ) => readonly VideoKnowledgeArtifact['related_notes'][number][]),
    ) => {
      writes += 1;
      const next = typeof updater === 'function' ? updater(current.related_notes) : updater;
      current = { ...current, related_notes: [...next] };
      return current;
    },
  };

  const rejected = await applyReviewedRelationSuggestion(store, suggestion, false);
  assert.equal(rejected.persisted, false);
  assert.equal(writes, 0);
  assert.deepEqual(current.related_notes, []);

  const accepted = await applyReviewedRelationSuggestion(store, suggestion, true);
  assert.equal(accepted.persisted, true);
  assert.equal(writes, 1);
  assert.equal(accepted.artifact.related_notes.length, 1);
  assert.equal(accepted.artifact.related_notes[0].note_path, 'Videos/Target.md');
});

test('relation engine never suggests conflict when either claim lacks a real segment', () => {
  const source = richArtifact('source-missing');
  const target = richArtifact('target-missing');
  source.claims[0].claim = '规律运动会增加记忆表现';
  target.claims[0].claim = '规律运动会降低记忆表现';
  target.claims[0].evidence = [{ segment_id: 'missing', source: 'speech' }];

  const suggestion = suggestArtifactRelation(source, target);

  assert.notEqual(suggestion.relation, 'conflict');
  assert.equal(
    suggestion.evidence_pairs.some((pair) => pair.relation === 'conflict'),
    false,
  );
});

test('long transcripts retain late OCR and claim records within the bounded index', () => {
  const artifact = richArtifact('long');
  artifact.segments = Array.from({ length: 500 }, (_, index) => ({
    id: `long-segment-${index}`,
    start: index,
    end: index + 0.9,
    text: `ordinary transcript segment ${index}`,
    source: 'speech' as const,
    timing_quality: 'exact' as const,
  }));
  artifact.visual_evidence = [
    {
      id: 'late-visual',
      start: 499,
      description: 'A late unique diagram',
      ocr_text: 'UNIQUE_OCR_NEUROPLASTICITY',
    },
  ];
  artifact.claims = [
    {
      id: 'late-claim',
      claim: 'UNIQUE_CLAIM_MEMORY',
      review_state: 'inference',
      evidence: [{ segment_id: 'long-segment-499', source: 'speech' }],
    },
  ];
  const index = new CrossModalMemoryIndex();
  index.rebuild([artifact]);

  assert.ok(index.getRecordCount() <= 600);
  assert.equal(index.search('UNIQUE_OCR_NEUROPLASTICITY')[0].evidence_type, 'ocr');
  const claim = index.search('UNIQUE_CLAIM_MEMORY')[0];
  assert.equal(claim.evidence_type, 'claim');
  assert.equal(claim.claim_review_state, 'inference');
});

function richArtifact(id: string): VideoKnowledgeArtifact {
  return {
    schema_version: 3,
    artifact_id: id,
    source: {
      url: `https://www.youtube.com/watch?v=${id}`,
      note_path: `Videos/${id}.md`,
      source_hash: id.padEnd(8, 'a').slice(0, 8),
    },
    title: 'Transformer lecture',
    author: 'Ada Teacher',
    platform: 'youtube',
    content_type: 'course',
    timing_quality: 'exact',
    transcript: 'The attention mechanism focuses tokens.',
    segments: [
      {
        id: `${id}-segment`,
        start: 42,
        end: 50,
        text: 'The attention mechanism focuses tokens.',
        visual_text: 'The loss curve converges.',
        source: 'speech',
        timing_quality: 'exact',
        keyframe: { id: `${id}-frame`, path: 'assets/frame-42.jpg' },
      },
    ],
    claims: [
      {
        id: `${id}-claim`,
        claim: 'Sparse attention reduces compute',
        evidence: [{ segment_id: `${id}-segment`, source: 'speech' }],
      },
    ],
    visual_evidence: [
      {
        id: `${id}-visual`,
        start: 42,
        description: 'A validation chart compares two models.',
        ocr_text: 'Accuracy 92%',
        keyframe: { id: `${id}-visual-frame`, path: 'assets/frame-42.jpg' },
      },
    ],
    related_notes: [],
    highlights: [],
    course_ids: ['course-alpha'],
    provenance: {
      schema_version: 3,
      generated_at: '2026-07-20T00:00:00Z',
      media_asset_root: 'Videos/_video-summary-assets',
    },
    created_at: '2026-07-20T00:00:00Z',
    updated_at: '2026-07-21T00:00:00Z',
  };
}

function uniqueIds(results: Array<{ artifact_id: string }>): string[] {
  return Array.from(new Set(results.map((result) => result.artifact_id))).sort();
}

function projectResult(result: {
  artifact_id: string;
  evidence_type: string;
  score: number;
  timestamp: number | null;
}) {
  return {
    artifact_id: result.artifact_id,
    evidence_type: result.evidence_type,
    score: result.score,
    timestamp: result.timestamp,
  };
}
