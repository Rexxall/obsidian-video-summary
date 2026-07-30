import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProcessingResult, VideoInput, VideoKnowledgeArtifact } from '../types';
import { ArtifactStore, normalizeTranscriptForHash, sha256Hex } from '../core/ArtifactStore';
import {
  hydratePersistedReprocessResult,
  resolveArtifactPersistenceIdentity,
} from '../core/ReprocessPersistence';

async function transcriptOnlyArtifact(transcript: string): Promise<VideoKnowledgeArtifact> {
  const transcriptHash = await sha256Hex(normalizeTranscriptForHash(transcript));
  const sourceHash = await sha256Hex(`transcript:${transcriptHash}`);
  const artifactId = ArtifactStore.artifactId(sourceHash);
  return {
    schema_version: 3,
    artifact_id: artifactId,
    source: {
      note_path: 'Video Inbox/original.md',
      transcript_hash: transcriptHash,
      source_hash: sourceHash,
    },
    timing_quality: 'exact',
    transcript,
    segments: [
      {
        id: 'seg-1',
        start: 0,
        text: transcript,
        source: 'speech',
        timing_quality: 'exact',
      },
    ],
    claims: [],
    visual_evidence: [],
    related_notes: [
      {
        note_path: 'Research/approved-relation.md',
        relation: 'related',
        reason: 'Reviewed by the user',
      },
    ],
    highlights: [
      {
        id: 'highlight-1',
        segment_id: 'seg-1',
        created_at: '2026-07-29T00:00:00.000Z',
      },
    ],
    course_ids: ['course-1'],
    provenance: {
      schema_version: 3,
      artifact_id: artifactId,
      source_hash: sourceHash,
      transcript_hash: transcriptHash,
    },
    created_at: '2026-07-29T00:00:00.000Z',
    updated_at: '2026-07-29T00:00:00.000Z',
  };
}

test('no-fetch summary-only response preserves transcript-only artifact identity', async () => {
  const transcript = '[00:00] Integrity checked local transcript.';
  const previous = await transcriptOnlyArtifact(transcript);
  const input: VideoInput = {
    transcript,
    artifactId: previous.artifact_id,
    skipSourceFetch: true,
    persistedSegments: previous.segments,
  };
  const result: ProcessingResult = { summary: 'A new summary without transcript output.' };

  hydratePersistedReprocessResult(result, input, previous);
  const identity = await resolveArtifactPersistenceIdentity({
    jobInput: input,
    result,
    notePath: 'Video Inbox/renamed.md',
    previous,
  });

  assert.equal(result.video_transcript, transcript);
  assert.deepEqual(result.video_segments, previous.segments);
  assert.equal(identity.artifactId, previous.artifact_id);
  assert.equal(identity.sourceHash, previous.source.source_hash);
  assert.equal(identity.source.transcript_hash, previous.source.transcript_hash);
  assert.equal(identity.source.note_path, 'Video Inbox/renamed.md');
});

test('no-fetch reprocess rejects backend transcript normalization as source identity', async () => {
  const transcript = '[00:00] Original spacing and wording.';
  const previous = await transcriptOnlyArtifact(transcript);
  const input: VideoInput = {
    transcript,
    artifactId: previous.artifact_id,
    skipSourceFetch: true,
  };
  const result: ProcessingResult = {
    summary: 'New summary',
    video_transcript: 'Backend-normalized replacement text.',
  };

  hydratePersistedReprocessResult(result, input, previous);
  const identity = await resolveArtifactPersistenceIdentity({
    jobInput: input,
    result,
    notePath: previous.source.note_path,
    previous,
  });

  assert.equal(result.video_transcript, transcript);
  assert.equal(identity.artifactId, previous.artifact_id);
  assert.equal(identity.sourceHash, previous.source.source_hash);
});

test('no-fetch reconstruction prefers persisted source URL over backend metadata', async () => {
  const input: VideoInput = {
    sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    transcript: '[00:00] Stored transcript',
    skipSourceFetch: true,
  };
  const result: ProcessingResult = {
    summary: 'New summary',
    artifact: {
      schema_version: 3,
      source_url: 'https://backend.invalid/hallucinated-source',
    },
  };

  hydratePersistedReprocessResult(result, input);
  const identity = await resolveArtifactPersistenceIdentity({
    jobInput: input,
    result,
    notePath: 'Video Inbox/example.md',
  });

  assert.equal(identity.source.url, input.sourceUrl);
  assert.equal(identity.artifactId, ArtifactStore.artifactId(identity.sourceHash));
});
