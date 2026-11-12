import { VideoUtils } from '../utils/VideoUtils';

/**
 * A finished video note opens in reading view: its photos, stamps and callouts are written as
 * HTML and callout syntax, which reads as code in the editor. Only on the first open of a note
 * in a tab, so switching to editing and back between tabs is left alone.
 */
export function wantsReadingView(
  enabled: boolean,
  frontmatter: unknown,
  alreadyOpenedHere: boolean,
): boolean {
  if (!enabled || alreadyOpenedHere) return false;
  if (!VideoUtils.isVideoNoteFromFrontmatter(frontmatter)) return false;
  return VideoUtils.getProcessingStatusFromFrontmatter(frontmatter) === 'success';
}

/**
 * The property View Mode by Frontmatter (and similar plugins) reads to pick a note's view. Set on a
 * finished note so a vault whose view plugin forces every other note back to editing still opens
 * it in reading view. A value the person chose is kept.
 */
export const VIEW_MODE_KEY = 'obsidianUIMode';

export function markReadingView(frontmatter: Record<string, unknown>): void {
  if (frontmatter[VIEW_MODE_KEY] === undefined || frontmatter[VIEW_MODE_KEY] === '') {
    frontmatter[VIEW_MODE_KEY] = 'preview';
  }
}
