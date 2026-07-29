import type { PlaylistInfo, PlaylistItem } from '../utils/PlaylistProcessor';
import {
  COURSE_MANIFEST_SCHEMA_VERSION,
  CourseDuplicate,
  CourseManifest,
  CourseManifestItem,
  emptyCourseProgress,
  stableCourseId,
  summarizeCourseProgress,
} from './CourseStore';

export const COURSE_INDEX_START = '<!-- VIDEO_SUMMARY_COURSE_INDEX:START -->';
export const COURSE_INDEX_END = '<!-- VIDEO_SUMMARY_COURSE_INDEX:END -->';

export interface CourseImportDiff {
  new: CourseManifestItem[];
  existing: CourseManifestItem[];
  removed: CourseManifestItem[];
  duplicates: CourseDuplicate[];
}

export interface CourseImportResult {
  manifest: CourseManifest;
  diff: CourseImportDiff;
}

export interface CourseCompileOptions {
  now?: Date;
}

/**
 * Merges a fetched playlist into a restart-safe manifest. This is deliberately
 * metadata-only: every new item is pending and no AI/backend call is made.
 */
export function compileCourseImport(
  playlist: PlaylistInfo,
  previous: CourseManifest | null,
  options: CourseCompileOptions = {},
): CourseImportResult {
  const now = (options.now ?? new Date()).toISOString();
  const courseId = stableCourseId(playlist);
  if (previous && previous.course_id !== courseId) {
    throw new Error('不能把不同来源的播放列表合并到同一课程');
  }

  const { unique, duplicates } = dedupeIncoming(playlist.items);
  const previousByKey = new Map(
    (previous?.items ?? []).map((item) => [item.canonical_key, item] as const),
  );
  const activeItems: CourseManifestItem[] = [];
  const added: CourseManifestItem[] = [];
  const existing: CourseManifestItem[] = [];

  unique.forEach((item, index) => {
    const prior = previousByKey.get(item.canonicalKey);
    const next: CourseManifestItem = prior
      ? {
          ...prior,
          platform: item.platform,
          video_id: item.videoId,
          canonical_key: item.canonicalKey,
          canonical_url: item.canonicalUrl,
          title: item.title || prior.title,
          author: item.author || prior.author,
          duration: item.duration ?? prior.duration,
          original_position: index,
          removed_from_source: false,
        }
      : {
          item_id: stableCourseItemId(courseId, item.canonicalKey),
          platform: item.platform,
          video_id: item.videoId,
          canonical_key: item.canonicalKey,
          canonical_url: item.canonicalUrl,
          title: item.title,
          author: item.author,
          duration: item.duration,
          original_position: index,
          recommended_position: index,
          prerequisites: [],
          progress: emptyCourseProgress(now),
          missing_concepts: [],
          removed_from_source: false,
        };
    activeItems.push(next);
    if (prior) existing.push(next);
    else added.push(next);
    previousByKey.delete(item.canonicalKey);
  });

  const removed = [...previousByKey.values()].map((item) => ({
    ...item,
    removed_from_source: true,
  }));
  const recommended = recommendOrder(activeItems);
  recommended.forEach((item, index) => {
    item.recommended_position = index;
  });
  applyDeterministicCourseStructure(recommended);
  const items = [...activeItems, ...removed];
  const createdAt = previous?.created_at ?? now;
  const manifest: CourseManifest = {
    schema_version: COURSE_MANIFEST_SCHEMA_VERSION,
    course_id: courseId,
    source: {
      platform: playlist.platform,
      source_type: playlist.sourceType,
      source_id: playlist.sourceId,
      canonical_url: playlist.canonicalSourceUrl,
      original_url: playlist.originalUrl,
    },
    title: playlist.title,
    description: playlist.description,
    created_at: createdAt,
    updated_at: now,
    import_count: (previous?.import_count ?? 0) + 1,
    ...(previous?.index_note_path ? { index_note_path: previous.index_note_path } : {}),
    original_order: activeItems.map((item) => item.item_id),
    recommended_order: recommended.map((item) => item.item_id),
    prerequisite_dependencies: Object.fromEntries(
      items.map((item) => [item.item_id, [...item.prerequisites]]),
    ),
    progress: summarizeCourseProgress(items),
    duplicates,
    missing_concepts: uniqueStrings(items.flatMap((item) => item.missing_concepts)),
    items,
  };
  return {
    manifest,
    diff: {
      new: added,
      existing,
      removed,
      duplicates,
    },
  };
}

export function updateCourseMarkdown(existing: string, manifest: CourseManifest): string {
  const managed = renderCourseManagedBlock(manifest);
  const start = existing.indexOf(COURSE_INDEX_START);
  const end = existing.indexOf(COURSE_INDEX_END);
  if (start >= 0 && end >= start) {
    const after = end + COURSE_INDEX_END.length;
    return `${existing.slice(0, start)}${managed}${existing.slice(after)}`;
  }
  if (!existing.trim()) {
    return createCourseMarkdown(manifest);
  }
  return `${existing.trimEnd()}\n\n${managed}\n`;
}

export function createCourseMarkdown(manifest: CourseManifest): string {
  const frontmatter = [
    '---',
    'video_summary_course: true',
    `course_id: ${manifest.course_id}`,
    `course_source: ${yamlQuote(manifest.source.canonical_url)}`,
    `course_platform: ${manifest.source.platform}`,
    `course_updated: ${manifest.updated_at}`,
    '---',
  ].join('\n');
  return `${frontmatter}\n\n# ${escapeHeading(manifest.title)}\n\n${renderCourseManagedBlock(
    manifest,
  )}\n\n## 我的课程笔记\n\n<!-- 这里的自由内容不会被再次导入覆盖。 -->\n`;
}

export function renderCourseManagedBlock(manifest: CourseManifest): string {
  const active = manifest.items.filter((item) => !item.removed_from_source);
  const byId = new Map(manifest.items.map((item) => [item.item_id, item] as const));
  const ordered = manifest.recommended_order
    .map((id) => byId.get(id))
    .filter((item): item is CourseManifestItem => Boolean(item && !item.removed_from_source));
  const lines = [
    COURSE_INDEX_START,
    '## 课程索引',
    '',
    `> 来源：[${escapeInline(manifest.source.platform)}](${manifest.source.canonical_url}) · ${active.length} 节 · 更新于 ${manifest.updated_at}`,
  ];
  if (manifest.description) lines.push('', escapeInline(manifest.description));
  lines.push(
    '',
    `进度：${manifest.progress.complete}/${active.length} 完成 · ${manifest.progress.pending} 待处理 · ${manifest.progress.error} 失败`,
    '',
    '| # | 状态 | 课程 | 前置 | 缺失概念 |',
    '|---:|---|---|---|---|',
  );
  ordered.forEach((item, index) => {
    const checked = item.progress.status === 'complete' ? 'x' : ' ';
    const target = item.progress.note_path
      ? `[[${escapeWikiTarget(item.progress.note_path)}|${escapeTable(item.title)}]]`
      : `[${escapeTable(item.title)}](${item.canonical_url})`;
    const prerequisites = item.prerequisites
      .map((id) => byId.get(id)?.title ?? id)
      .map(escapeTable)
      .join('、');
    lines.push(
      `| ${index + 1} | [${checked}] ${progressLabel(item.progress.status)} | ${target} | ${
        prerequisites || '—'
      } | ${item.missing_concepts.map(escapeTable).join('、') || '—'} |`,
    );
  });
  if (manifest.duplicates.length > 0) {
    lines.push(
      '',
      `> 已折叠 ${manifest.duplicates.reduce(
        (sum, item) => sum + item.duplicate_positions.length,
        0,
      )} 个重复条目；不会重复创建笔记或任务。`,
    );
  }
  if (manifest.progress.removed > 0) {
    lines.push('', `> 来源已移除 ${manifest.progress.removed} 节；历史进度仍保留在课程清单中。`);
  }
  lines.push(COURSE_INDEX_END);
  return lines.join('\n');
}

export function courseIndexBaseName(manifest: CourseManifest): string {
  return `${sanitizeFileName(manifest.title)} [${manifest.course_id.slice(-8)}]`;
}

function dedupeIncoming(items: PlaylistItem[]): {
  unique: PlaylistItem[];
  duplicates: CourseDuplicate[];
} {
  const unique: PlaylistItem[] = [];
  const positions = new Map<string, number[]>();
  for (const item of items) {
    const list = positions.get(item.canonicalKey) ?? [];
    list.push(item.position);
    positions.set(item.canonicalKey, list);
    if (list.length === 1) unique.push(item);
  }
  const duplicates = [...positions.entries()]
    .filter(([, value]) => value.length > 1)
    .map(([canonicalKey, value]) => ({
      canonical_key: canonicalKey,
      kept_position: value[0],
      duplicate_positions: value.slice(1),
    }));
  return { unique, duplicates };
}

function recommendOrder(items: CourseManifestItem[]): CourseManifestItem[] {
  const numbered = items.map((item) => ({ item, lesson: lessonNumber(item.title) }));
  const recognized = numbered.filter((entry) => entry.lesson !== undefined).length;
  if (recognized < Math.ceil(items.length * 0.6)) return [...items];
  return numbered
    .sort((left, right) => {
      if (left.lesson === undefined && right.lesson === undefined) {
        return left.item.original_position - right.item.original_position;
      }
      if (left.lesson === undefined) return 1;
      if (right.lesson === undefined) return -1;
      return (
        left.lesson - right.lesson || left.item.original_position - right.item.original_position
      );
    })
    .map((entry) => entry.item);
}

/**
 * Only infer prerequisites when lesson numbers make the dependency explicit.
 * A gap is recorded as a missing source lesson instead of inventing concepts
 * or silently linking non-adjacent material.
 */
function applyDeterministicCourseStructure(items: CourseManifestItem[]): void {
  let previous: { item: CourseManifestItem; lesson: number } | undefined;
  for (const item of items) {
    const lesson = lessonNumber(item.title);
    item.prerequisites = [];
    item.missing_concepts = [];
    if (lesson === undefined) {
      previous = undefined;
      continue;
    }
    if (previous && lesson === previous.lesson + 1) {
      item.prerequisites = [previous.item.item_id];
    } else if (previous && lesson > previous.lesson + 1) {
      const missing = Array.from(
        { length: lesson - previous.lesson - 1 },
        (_, index) => previous!.lesson + index + 1,
      );
      item.missing_concepts = missing.map((number) => `来源缺少第 ${number} 课`);
    }
    previous = { item, lesson };
  }
}

function lessonNumber(title: string): number | undefined {
  const match = title.match(
    /(?:^|\s)(?:第\s*)?(\d{1,4})(?:\s*(?:课|讲|集|章|节|期)|[.、:：\-_]\s*)/i,
  );
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function stableCourseItemId(courseId: string, canonicalKey: string): string {
  let hash = 0x811c9dc5;
  const input = `${courseId}:${canonicalKey}`;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `lesson-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function progressLabel(status: CourseManifestItem['progress']['status']): string {
  return {
    pending: '待处理',
    queued: '已排队',
    processing: '处理中',
    complete: '已完成',
    error: '失败',
  }[status];
}

function sanitizeFileName(value: string): string {
  return value.replace(/[<>:"/\\|?*]/g, '_').trim() || '视频课程';
}

function yamlQuote(value: string): string {
  return JSON.stringify(value);
}

function escapeHeading(value: string): string {
  return value.replace(/\n/g, ' ').trim();
}

function escapeInline(value: string): string {
  return value.replace(/\r?\n/g, ' ').trim();
}

function escapeTable(value: string): string {
  return escapeInline(value).replace(/\|/g, '\\|');
}

function escapeWikiTarget(value: string): string {
  return value.replace(/\.md$/i, '').replace(/\|/g, '\\|');
}
