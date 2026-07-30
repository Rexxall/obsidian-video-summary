import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from 'js-yaml';
import {
  CaptureInbox,
  CaptureInboxEntry,
  CaptureInboxRepository,
  CaptureInboxRepositoryResult,
  CaptureNoteDraft,
  canonicalizeCaptureSource,
  createCaptureNoteDraft,
} from '../core/CaptureInbox';

const CAPTURED_AT = '2026-07-29T10:00:00.000Z';

test('equivalent URLs dedupe to existing and never create a second note', async () => {
  const repository = new MemoryCaptureRepository();
  const inbox = new CaptureInbox(repository);
  const first = await inbox.capture({
    url: 'https://youtu.be/dQw4w9WgXcQ?t=42&utm_source=share',
    title: 'Canonical video',
    action: 'capture-only',
    captured_at: CAPTURED_AT,
  });
  const duplicate = await inbox.capture({
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&feature=share',
    title: 'Same source, different title',
    action: 'capture-and-process',
    captured_at: CAPTURED_AT,
  });

  assert.equal(first.status, 'created');
  assert.equal(first.should_process, false);
  assert.equal(duplicate.status, 'existing');
  assert.equal(duplicate.should_process, true);
  assert.equal(duplicate.entry.path, first.entry.path);
  assert.equal(repository.createdCount, 1);
  assert.equal(repository.entries.size, 1);
  assert.equal(
    first.draft.source.identity,
    duplicate.draft.source.identity,
    'tracking/time URL differences must not alter source identity',
  );
});

test('capture actions emit standard Properties and stay inbox until a real job starts', async () => {
  const captured = await createCaptureNoteDraft({
    url: 'https://offline.invalid/video/123?utm_campaign=test&b=2&a=1',
    title: 'Offline capture',
    action: 'capture-only',
    output_folder: 'Video Inbox',
    captured_at: CAPTURED_AT,
  });
  const process = await createCaptureNoteDraft({
    url: 'https://offline.invalid/video/456',
    title: 'Process now',
    action: 'capture-and-process',
    captured_at: CAPTURED_AT,
  });
  const frontmatter = parseFrontmatter(captured.content);

  assert.equal(captured.properties.video_summary_status, 'inbox');
  assert.equal(process.properties.video_summary_status, 'inbox');
  assert.equal(process.properties.video_capture_action, 'capture-and-process');
  assert.equal(frontmatter.video_summary, true);
  assert.equal(frontmatter.source_type, 'video');
  assert.equal(frontmatter.video_summary_status, 'inbox');
  assert.equal(frontmatter.video_review_due, null);
  assert.equal(frontmatter.video_artifact_id, null);
  assert.match(String(frontmatter.video_expected_artifact_id), /^vka-[a-f0-9]{32}$/);
  assert.equal(frontmatter.video_capture_action, 'capture-only');
  assert.match(String(frontmatter.link), /offline\.invalid\/video\/123\?a=1&b=2$/);
  assert.doesNotMatch(String(frontmatter.link), /utm_/);
  assert.match(captured.path, /^Video Inbox\//);
});

test('canonicalization works offline for generic, Bilibili and local sources', async () => {
  const generic = await canonicalizeCaptureSource({
    url: 'https://Example.com/watch/?z=2&utm_medium=x&a=1#fragment',
  });
  const bilibili = await canonicalizeCaptureSource({
    url: 'https://www.bilibili.com/video/BV1xx411c7mD?p=2&spm_id_from=333',
  });
  const local = await canonicalizeCaptureSource({
    local_file: '/Users/example/Videos/lesson.mp4',
  });

  assert.equal(generic.platform, 'web');
  assert.equal(generic.canonical_url, 'https://example.com/watch?a=1&z=2');
  assert.equal(bilibili.identity, 'bilibili:BV1xx411c7mD:p2');
  assert.equal(bilibili.canonical_url, 'https://www.bilibili.com/video/BV1xx411c7mD?p=2');
  assert.equal(local.platform, 'local');
  assert.equal(local.identity, 'local:/Users/example/Videos/lesson.mp4');
  assert.equal(generic.source_hash.length, 64);
  assert.match(local.artifact_id, /^vka-[a-f0-9]{32}$/);

  const localDraft = await createCaptureNoteDraft({
    local_file: '/Users/example/Videos/lesson.mp4',
    action: 'capture-and-process',
    captured_at: CAPTURED_AT,
  });
  assert.equal(localDraft.properties.local_file, '/Users/example/Videos/lesson.mp4');
  assert.equal(localDraft.properties.link, '');
  assert.match(
    localDraft.content,
    /^local_file: ['"]?\/Users\/example\/Videos\/lesson\.mp4['"]?$/m,
  );
});

test('generic URL canonicalization preserves site semantics while removing universal trackers', async () => {
  const withWww = await canonicalizeCaptureSource({
    url: 'https://www.example.com/watch?feature=chapter&share_source=library&utm_source=inbox',
  });
  const withoutWww = await canonicalizeCaptureSource({
    url: 'https://example.com/watch?feature=chapter&share_source=library',
  });

  assert.equal(
    withWww.canonical_url,
    'https://www.example.com/watch?feature=chapter&share_source=library',
  );
  assert.notEqual(withWww.identity, withoutWww.identity);
});

test('unsafe source inputs and vault traversal are rejected', async () => {
  await assert.rejects(
    () =>
      createCaptureNoteDraft({
        url: 'javascript:alert(1)',
        action: 'capture-only',
      }),
    /http\/https/,
  );
  await assert.rejects(
    () =>
      createCaptureNoteDraft({
        url: 'https://example.com/video',
        output_folder: '../Outside',
        action: 'capture-only',
      }),
    /vault 相对路径/,
  );
  await assert.rejects(
    () =>
      createCaptureNoteDraft({
        url: 'https://example.com/video',
        output_folder: '/Users/example/Outside',
        action: 'capture-only',
      }),
    /vault 相对路径/,
  );
  await assert.rejects(
    () =>
      canonicalizeCaptureSource({
        local_file: 'relative/video.mp4',
      }),
    /绝对路径/,
  );
});

function parseFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match, 'capture note must contain YAML frontmatter');
  const parsed = load(match[1]);
  assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed));
  return parsed as Record<string, unknown>;
}

class MemoryCaptureRepository implements CaptureInboxRepository {
  readonly entries = new Map<string, CaptureInboxEntry>();
  readonly drafts = new Map<string, CaptureNoteDraft>();
  createdCount = 0;

  async putIfAbsent(
    sourceHash: string,
    draft: CaptureNoteDraft,
  ): Promise<CaptureInboxRepositoryResult> {
    const existing = this.entries.get(sourceHash);
    if (existing) return { created: false, entry: { ...existing } };
    const entry: CaptureInboxEntry = {
      path: draft.path,
      source_hash: sourceHash,
      source_identity: draft.source.identity,
      status: String(draft.properties.video_summary_status),
    };
    this.entries.set(sourceHash, entry);
    this.drafts.set(sourceHash, draft);
    this.createdCount += 1;
    return { created: true, entry: { ...entry } };
  }
}
