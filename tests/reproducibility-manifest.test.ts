import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createReproducibilityManifest,
  restoreReprocessPayload,
  serializeReproducibilityManifest,
} from '../core/ReproducibilityManifest';

const GENERATED_AT = '2026-07-29T11:00:00.000Z';

test('manifest snapshots raw transcript/evidence and restores a no-fetch reprocess payload', async () => {
  const manifest = await createReproducibilityManifest({
    source: {
      url: 'https://youtu.be/dQw4w9WgXcQ?t=15&utm_source=test',
    },
    transcript: 'A durable raw transcript.',
    segments: [
      {
        id: 'segment-one',
        start: 15,
        end: 20,
        text: 'A durable raw transcript.',
        source: 'speech',
        timing_quality: 'exact',
      },
    ],
    evidence_claims: [
      {
        id: 'claim-one',
        claim: 'The transcript is durable.',
        evidence: [{ segment_id: 'segment-one', source: 'speech' }],
      },
    ],
    visual_evidence: [],
    backend: 'codex-worker',
    model: 'gpt-5.6',
    prompt: 'video-evidence-v3',
    version: '3.0.0',
    depth: 'evidence',
    generated_at: GENERATED_AT,
  });
  const restored = await restoreReprocessPayload(manifest);

  assert.equal(manifest.source_hash.length, 64);
  assert.equal(manifest.transcript_hash.length, 64);
  assert.equal(manifest.evidence_hash.length, 64);
  assert.equal(manifest.can_reprocess_without_source_fetch, true);
  assert.equal(restored.skip_source_fetch, true);
  assert.equal(restored.transcript, 'A durable raw transcript.');
  assert.equal(restored.video_segments[0].id, 'segment-one');
  assert.equal(restored.evidence_claims[0].id, 'claim-one');
  assert.deepEqual(restored.processing, {
    backend: 'codex-worker',
    model: 'gpt-5.6',
    prompt: 'video-evidence-v3',
    version: '3.0.0',
    depth: 'evidence',
  });
  assert.match(serializeReproducibilityManifest(manifest), /"raw": \{/);
});

test('restore rejects a changed transcript or evidence snapshot', async () => {
  const manifest = await createReproducibilityManifest({
    source: { local_file: '/Users/example/video.mp4' },
    transcript: 'Original transcript',
    segments: [],
    evidence_claims: [],
    backend: 'n8n',
    model: 'gemini-3.1',
    prompt: 'summary-v3',
    version: '3',
    depth: 'quick',
    generated_at: GENERATED_AT,
  });
  const changedTranscript = structuredClone(manifest);
  changedTranscript.raw.transcript = 'Changed transcript';
  await assert.rejects(
    () => restoreReprocessPayload(changedTranscript),
    /transcript_hash mismatch/,
  );

  const changedEvidence = structuredClone(manifest);
  changedEvidence.raw.segments.push({
    id: 'injected',
    start: null,
    text: 'Injected',
    source: 'speech',
    timing_quality: 'none',
  });
  await assert.rejects(() => restoreReprocessPayload(changedEvidence), /evidence_hash mismatch/);
});

test('manifest rejects a provided source hash that disagrees with source identity', async () => {
  await assert.rejects(
    () =>
      createReproducibilityManifest({
        source: {
          url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          source_hash: 'a'.repeat(64),
        },
        transcript: 'Transcript',
        backend: 'n8n',
        model: 'model',
        prompt: 'prompt',
        version: '1',
        depth: 'quick',
      }),
    /source_hash does not match/,
  );
});

test('transcript-only manifests retain stable source identity across note renames', async () => {
  const transcript = 'Transcript-only reproducibility input.';
  const transcriptHash = await crypto.subtle
    .digest('SHA-256', new TextEncoder().encode(transcript))
    .then((digest) =>
      Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join(''),
    );
  const manifest = await createReproducibilityManifest({
    source: {
      note_path: 'Video Inbox/Untitled.md',
      transcript_hash: transcriptHash,
    },
    transcript,
    backend: 'codex-worker',
    model: 'fixture-model',
    prompt: 'fixture-prompt',
    version: 'fixture-v1',
    depth: 'evidence',
    generated_at: GENERATED_AT,
  });
  manifest.source.note_path = 'Video Notes/Renamed.md';

  const restored = await restoreReprocessPayload(manifest);

  assert.equal(restored.source.transcript_hash, transcriptHash);
  assert.equal(restored.source.note_path, 'Video Notes/Renamed.md');
  assert.equal(restored.source_hash, manifest.source_hash);
});

test('missing claim segments remain explicit warnings instead of invented evidence', async () => {
  const manifest = await createReproducibilityManifest({
    source: { url: 'https://example.com/video/one' },
    transcript: 'Transcript with incomplete evidence.',
    segments: [],
    evidence_claims: [
      {
        id: 'claim-one',
        claim: 'Needs review.',
        evidence: [{ segment_id: 'missing-segment', source: 'speech' }],
      },
    ],
    backend: 'codex-worker',
    model: 'model',
    prompt: 'prompt',
    version: '1',
    depth: 'evidence',
    generated_at: GENERATED_AT,
  });

  assert.equal(manifest.warnings.length, 1);
  assert.match(manifest.warnings[0], /不存在的 segment/);
  assert.equal(manifest.raw.segments.length, 0);
  assert.equal(manifest.raw.evidence_claims[0].evidence[0].segment_id, 'missing-segment');
});
