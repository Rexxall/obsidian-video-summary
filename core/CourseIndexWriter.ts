import { TFile, Vault } from 'obsidian';
import type { CourseManifest, CourseStore } from './CourseStore';
import { createCourseMarkdown, updateCourseMarkdown } from './CourseCompiler';

const courseIndexLocks = new Map<string, Promise<unknown>>();

/**
 * Replace only the managed course block against the latest Vault contents.
 * Vault.process makes the read-modify-write atomic, so a user editing the
 * free-form section at the same time cannot be overwritten by a stale read.
 * A shared per-course lock and a fresh manifest load also prevent a delayed
 * batch writer from rolling a newer completion block back to pending.
 */
export async function syncCourseIndexAtomic(
  vault: Vault,
  store: CourseStore,
  courseId: string,
  createIfMissing = true,
): Promise<void> {
  const previous = courseIndexLocks.get(courseId) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(async () => {
      const manifest = await store.load(courseId);
      if (!manifest) return;
      await writeLatestCourseIndex(vault, manifest, createIfMissing);
    });
  courseIndexLocks.set(courseId, current);
  try {
    await current;
  } finally {
    if (courseIndexLocks.get(courseId) === current) courseIndexLocks.delete(courseId);
  }
}

async function writeLatestCourseIndex(
  vault: Vault,
  manifest: CourseManifest,
  createIfMissing: boolean,
): Promise<void> {
  const path = manifest.index_note_path;
  if (!path) throw new Error('课程索引路径尚未初始化');
  const existing = vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) {
    await vault.process(existing, (current) => updateCourseMarkdown(current, manifest));
    return;
  }
  if (!createIfMissing) return;
  try {
    await vault.create(path, createCourseMarkdown(manifest));
  } catch (error) {
    const raced = vault.getAbstractFileByPath(path);
    if (!(raced instanceof TFile)) throw error;
    await vault.process(raced, (current) => updateCourseMarkdown(current, manifest));
  }
}
