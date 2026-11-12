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
