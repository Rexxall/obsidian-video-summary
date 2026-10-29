import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  COURSE_INDEX_END,
  COURSE_INDEX_START,
  compileCourseImport,
  createCourseMarkdown,
  updateCourseMarkdown,
} from '../core/CourseCompiler';
import { CourseStore, CourseStoreAdapter, stableCourseId } from '../core/CourseStore';
import type { PlaylistInfo, PlaylistItem } from '../utils/PlaylistProcessor';

const NOW = new Date('2026-07-29T10:00:00.000Z');

void test('course imports are canonical, incremental, and new lessons remain pending', () => {
  const first = makePlaylist([
    lesson('youtube', 'alpha01', '第 1 课', 0),
    lesson('youtube', 'beta002', '第 2 课', 1),
    lesson('youtube', 'alpha01', '重复', 2),
  ]);
  const initial = compileCourseImport(first, null, { now: NOW });

  assert.equal(initial.diff.new.length, 2);
  assert.equal(initial.diff.existing.length, 0);
  assert.equal(initial.diff.duplicates.length, 1);
  assert.deepEqual(
    initial.manifest.items.map((item) => item.progress.status),
    ['pending', 'pending'],
  );
  assert.ok(initial.manifest.items.every((item) => item.progress.note_path === undefined));
  assert.equal(initial.manifest.recommended_order.length, 2);
  assert.equal(Object.keys(initial.manifest.prerequisite_dependencies).length, 2);
  assert.deepEqual(initial.manifest.items[1].prerequisites, [initial.manifest.items[0].item_id]);

  initial.manifest.items[0].progress = {
    status: 'complete',
    percent: 100,
    note_path: 'Videos/Lesson 1.md',
    updated_at: NOW.toISOString(),
  };
  const second = makePlaylist([
    lesson('youtube', 'alpha01', '第 1 课（改名）', 0),
    lesson('youtube', 'gamma03', '第 3 课', 1),
  ]);
  const updated = compileCourseImport(second, initial.manifest, {
    now: new Date('2026-07-30T10:00:00.000Z'),
  });

  assert.deepEqual(
    updated.diff.new.map((item) => item.canonical_key),
    ['youtube:gamma03'],
  );
  assert.deepEqual(
    updated.diff.existing.map((item) => item.canonical_key),
    ['youtube:alpha01'],
  );
  assert.deepEqual(
    updated.diff.removed.map((item) => item.canonical_key),
    ['youtube:beta002'],
  );
  assert.equal(updated.diff.existing[0].progress.status, 'complete');
  assert.equal(updated.diff.existing[0].progress.note_path, 'Videos/Lesson 1.md');
  assert.equal(updated.diff.new[0].progress.status, 'pending');
  assert.equal(updated.manifest.progress.removed, 1);
  assert.equal(updated.manifest.import_count, 2);
  assert.equal(updated.manifest.course_id, initial.manifest.course_id);
  assert.deepEqual(updated.diff.new[0].missing_concepts, ['来源缺少第 2 课']);
  assert.deepEqual(updated.manifest.missing_concepts, ['来源缺少第 2 课']);
});

void test('course manifests survive a store restart with stable course ids', async () => {
  const adapter = new MemoryCourseAdapter();
  const playlist = makePlaylist([lesson('bilibili', 'BV1xx411c7mD', '第一讲', 0)]);
  const compiled = compileCourseImport(playlist, null, { now: NOW });
  const firstStore = new CourseStore(adapter, 'plugin/data/course-manifests', {
    now: () => NOW,
  });
  await firstStore.save(compiled.manifest);

  const restartedStore = new CourseStore(adapter, 'plugin/data/course-manifests', {
    now: () => NOW,
  });
  const loaded = await restartedStore.load(stableCourseId(playlist));
  const listed = await restartedStore.list();

  assert.deepEqual(loaded, compiled.manifest);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].course_id, compiled.manifest.course_id);
  assert.equal(
    await adapter.exists(`plugin/data/course-manifests/${compiled.manifest.course_id}.json`),
    true,
  );
});

void test('concurrent lesson progress updates retain both changes atomically', async () => {
  const adapter = new MemoryCourseAdapter();
  const playlist = makePlaylist([
    lesson('youtube', 'alpha01', 'Lesson 1', 0),
    lesson('youtube', 'beta002', 'Lesson 2', 1),
  ]);
  const compiled = compileCourseImport(playlist, null, { now: NOW });
  const store = new CourseStore(adapter, 'plugin/data/course-manifests', {
    now: () => new Date('2026-07-29T11:00:00.000Z'),
  });
  await store.save(compiled.manifest);
  const [firstId, secondId] = compiled.manifest.items.map((item) => item.item_id);

  await Promise.all([
    store.update(compiled.manifest.course_id, async (manifest) => {
      await Promise.resolve();
      const item = manifest.items.find((candidate) => candidate.item_id === firstId);
      assert.ok(item);
      item.progress = {
        ...item.progress,
        status: 'complete',
        percent: 100,
        artifact_id: 'vka-first',
        updated_at: '2026-07-29T10:30:00.000Z',
      };
    }),
    store.update(compiled.manifest.course_id, async (manifest) => {
      await Promise.resolve();
      const item = manifest.items.find((candidate) => candidate.item_id === secondId);
      assert.ok(item);
      item.progress = {
        ...item.progress,
        status: 'complete',
        percent: 100,
        artifact_id: 'vka-second',
        updated_at: '2026-07-29T10:31:00.000Z',
      };
    }),
  ]);

  const loaded = await store.load(compiled.manifest.course_id);
  assert.ok(loaded);
  assert.deepEqual(
    loaded.items.map((item) => [item.progress.status, item.progress.artifact_id]),
    [
      ['complete', 'vka-first'],
      ['complete', 'vka-second'],
    ],
  );
  assert.equal(loaded.progress.complete, 2);
});

void test('saving a stale playlist snapshot cannot roll back newer lesson progress', async () => {
  const adapter = new MemoryCourseAdapter();
  const playlist = makePlaylist([lesson('youtube', 'alpha01', 'Lesson 1', 0)]);
  const compiled = compileCourseImport(playlist, null, { now: NOW });
  const store = new CourseStore(adapter, 'plugin/data/course-manifests', {
    now: () => new Date('2026-07-29T11:00:00.000Z'),
  });
  const stale = structuredClone(await store.save(compiled.manifest));
  const itemId = stale.items[0].item_id;

  await store.update(stale.course_id, (manifest) => {
    const item = manifest.items.find((candidate) => candidate.item_id === itemId);
    assert.ok(item);
    item.progress = {
      ...item.progress,
      status: 'complete',
      percent: 100,
      artifact_id: 'vka-newer',
      updated_at: '2026-07-29T12:00:00.000Z',
    };
  });
  await store.save(stale);

  const loaded = await store.load(stale.course_id);
  assert.ok(loaded);
  assert.equal(loaded.items[0].progress.status, 'complete');
  assert.equal(loaded.items[0].progress.artifact_id, 'vka-newer');
  assert.equal(loaded.progress.complete, 1);
});

void test('saving an older playlist preview cannot delete lessons from a newer import', async () => {
  const adapter = new MemoryCourseAdapter();
  const store = new CourseStore(adapter, 'plugin/data/course-manifests', {
    now: () => new Date('2026-07-29T13:00:00.000Z'),
  });
  const first = makePlaylist([
    lesson('youtube', 'alpha01', 'Lesson 1', 0),
    lesson('youtube', 'beta002', 'Lesson 2', 1),
  ]);
  const olderPreview = compileCourseImport(first, null, {
    now: new Date('2026-07-29T10:00:00.000Z'),
  }).manifest;
  await store.save(olderPreview);
  const newerPlaylist = makePlaylist([...first.items, lesson('youtube', 'gamma03', 'Lesson 3', 2)]);
  const current = await store.load(olderPreview.course_id);
  const newerImport = compileCourseImport(newerPlaylist, current, {
    now: new Date('2026-07-29T12:00:00.000Z'),
  }).manifest;
  await store.save(newerImport);

  await store.save(olderPreview);

  const loaded = await store.load(olderPreview.course_id);
  assert.ok(loaded);
  assert.deepEqual(
    loaded.items.filter((item) => !item.removed_from_source).map((item) => item.title),
    ['Lesson 1', 'Lesson 2', 'Lesson 3'],
  );
  assert.equal(loaded.import_count, newerImport.import_count);
});

void test('opaque playlist ids preserve case when deriving course identity', () => {
  const upper = makePlaylist([lesson('youtube', 'alpha01', 'Lesson', 0)]);
  const lower = { ...upper, sourceId: upper.sourceId.toLowerCase() };
  assert.notEqual(upper.sourceId, lower.sourceId);
  assert.notEqual(stableCourseId(upper), stableCourseId(lower));
});

void test('course managed block updates preserve free-form user content', () => {
  const playlist = makePlaylist([lesson('youtube', 'alpha01', 'Lesson 1', 0)]);
  const first = compileCourseImport(playlist, null, { now: NOW });
  const base = createCourseMarkdown(first.manifest);
  const customized = `${base}\nUser paragraph that must survive.\n`;
  const second = compileCourseImport(
    makePlaylist([
      lesson('youtube', 'alpha01', 'Lesson 1', 0),
      lesson('youtube', 'beta002', 'Lesson 2', 1),
    ]),
    first.manifest,
    { now: new Date('2026-07-30T10:00:00.000Z') },
  );
  const updated = updateCourseMarkdown(customized, second.manifest);

  assert.ok(updated.includes('User paragraph that must survive.'));
  assert.equal(count(updated, COURSE_INDEX_START), 1);
  assert.equal(count(updated, COURSE_INDEX_END), 1);
  assert.ok(updated.includes('Lesson 2'));
});

function makePlaylist(items: PlaylistItem[]): PlaylistInfo {
  const platform = items[0]?.platform ?? 'youtube';
  const isBilibili = platform === 'bilibili';
  return {
    platform,
    sourceType: isBilibili ? 'collection' : 'playlist',
    sourceId: isBilibili ? '321' : 'PL-course-fixture',
    canonicalSourceUrl: isBilibili
      ? 'https://www.bilibili.com/medialist/play/321'
      : 'https://www.youtube.com/playlist?list=PL-course-fixture',
    originalUrl: isBilibili
      ? 'https://space.bilibili.com/123/channel/collectiondetail?sid=321'
      : 'https://www.youtube.com/playlist?list=PL-course-fixture&utm_source=test',
    title: 'Fixture course',
    description: 'Fixture description',
    itemCount: items.length,
    items,
    fetchedPages: 1,
    truncated: false,
  };
}

function lesson(
  platform: 'youtube' | 'bilibili',
  videoId: string,
  title: string,
  position: number,
): PlaylistItem {
  const canonicalUrl =
    platform === 'youtube'
      ? `https://www.youtube.com/watch?v=${videoId}`
      : `https://www.bilibili.com/video/${videoId}`;
  return {
    platform,
    videoId,
    canonicalKey: `${platform}:${videoId}`,
    canonicalUrl,
    url: canonicalUrl,
    bvid: platform === 'bilibili' ? videoId : undefined,
    title,
    author: 'Teacher',
    duration: '10:00',
    position,
  };
}

function count(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

class MemoryCourseAdapter implements CourseStoreAdapter {
  readonly files = new Map<string, string>();
  readonly folders = new Set<string>();

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.folders.has(path);
  }

  async read(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`Missing ${path}`);
    return value;
  }

  async write(path: string, data: string): Promise<void> {
    this.files.set(path, data);
  }

  async mkdir(path: string): Promise<void> {
    this.folders.add(path);
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const prefix = `${path}/`;
    return {
      files: [...this.files.keys()].filter((item) => item.startsWith(prefix)),
      folders: [...this.folders].filter((item) => item.startsWith(prefix)),
    };
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const value = this.files.get(oldPath);
    if (value === undefined) throw new Error(`Missing ${oldPath}`);
    this.files.delete(oldPath);
    this.files.set(newPath, value);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }

  async process(path: string, fn: (data: string) => string): Promise<string> {
    const next = fn(await this.read(path));
    this.files.set(path, next);
    return next;
  }
}
