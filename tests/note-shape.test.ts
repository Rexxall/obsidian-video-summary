import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildRichFrontmatterFields } from '../core/KnowledgeMarkdown';
import {
  cleanCaptureScaffold,
  readTranscriptFold,
  renderTranscriptFold,
  writeCleanVideoBody,
} from '../utils/NoteOutput';
import { buildCaptureNoteContent } from '../core/CaptureInbox';

const RESULT = {
  summary: 'A short summary.',
  video_title: 'Title',
  video_author: 'Author',
  video_transcript: '[00:01] first line\n\n[00:25] second line',
  content_type: 'tutorial' as const,
  attention: { action: 'watch' as const, score: 0.8, confidence: 0.7, rationale: '' },
  artifact: { artifact_id: 'vka-1', processing_depth: 'quick' as const },
};

void test('properties hold what a person reads; the transcript and internal ids stay out', () => {
  const fields = buildRichFrontmatterFields(RESULT as never);
  assert.equal(fields.summary, 'A short summary.');
  assert.equal(fields.video_title, 'Title');
  for (const key of [
    'video_transcript',
    'video_artifact_id',
    'video_content_type',
    'video_attention_action',
    'video_processing_depth',
  ]) {
    assert.equal(key in fields, false, key);
  }
});

void test('the transcript is a folded quote at the end of the note and reads back unchanged', () => {
  const body = writeCleanVideoBody('My own words.\n', {
    note: '> [!summary] 摘要\n> ok',
    video_transcript: RESULT.video_transcript,
  });
  assert.ok(body.trimEnd().endsWith('<!-- video-summary-transcript:end -->'));
  assert.match(
    body,
    /<!-- video-summary-transcript:start -->\n> \[!quote\]- 原始文稿\n> \[00:01\]/,
  );
  assert.equal(readTranscriptFold(`---\nx: 1\n---\n${body}`), RESULT.video_transcript);
  assert.match(renderTranscriptFold('a'), /^> \[!quote\]- /);
  assert.equal(readTranscriptFold('no block here'), null);
});

void test('the capture inbox placeholder goes once the note is written', () => {
  const content = buildCaptureNoteContent(
    'A title',
    { video_summary: true, link: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
    {
      identity: 'youtube:dQw4w9WgXcQ',
      source_hash: 'x',
      artifact_id: 'vka-x',
      source_type: 'video',
      platform: 'youtube',
      canonical_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    },
  );
  const body = content.slice(content.indexOf('\n---\n', 4) + 5);
  assert.equal(cleanCaptureScaffold(body), '');
  assert.equal(cleanCaptureScaffold('# My own heading\n\ntext'), '# My own heading\n\ntext');
  const written = writeCleanVideoBody(body, { note: 'Note body', video_transcript: 'x' });
  assert.ok(written.startsWith('<!-- video-summary-generated:start -->'));
});
