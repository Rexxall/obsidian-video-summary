import type { JsonRecord } from './json';

/**
 * "Theme marks": classes some vault themes know how to draw. Off by default; the plugin ships no
 * style for them.
 *   ih-sub         the note's one-line takeaway, as a subtitle on the body's first line
 *   ih-circ        a pen circle around the first ==highlight==, one per page
 *   ih-stamp-done  a "done" stamp in cssclasses while the note's status is ✅
 */
export const SUBTITLE_CLASS = 'ih-sub';
export const CIRCLE_CLASS = 'ih-circ';
export const DONE_STAMP_CLASS = 'ih-stamp-done';
const DONE_STATUS = '✅';

/** Adds the subtitle and the circle to a generated note body. */
export function markNoteBody(note: string, takeaway?: string): string {
  let body = circleFirstHighlight(note || '');
  const line = (takeaway || '').replace(/\s+/g, ' ').trim();
  if (line) body = `<span class="${SUBTITLE_CLASS}">${escapeHtml(line)}</span>\n\n${body}`;
  return body;
}

/** Wraps the first ==highlight== outside code in the circle class. */
export function circleFirstHighlight(markdown: string): string {
  let done = false;
  return markdown
    .split(/(```[\s\S]*?```|`[^`\n]*`)/)
    .map((part, index) => {
      if (done || index % 2 === 1) return part;
      return part.replace(/==([^=\n]+?)==/, (match: string, text: string) => {
        if (done) return match;
        done = true;
        return `<span class="${CIRCLE_CLASS}">${text}</span>`;
      });
    })
    .join('');
}

/** Keeps the done stamp in cssclasses in step with a ✅ status. */
export function syncDoneStamp(fm: JsonRecord): void {
  const raw = fm.cssclasses ?? fm.cssclass;
  const list = (Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\s,]+/) : [])
    .map((value) => String(value).trim())
    .filter(Boolean);
  const done = typeof fm.status === 'string' && fm.status.trim() === DONE_STATUS;
  const has = list.includes(DONE_STAMP_CLASS);
  if (done === has) return;
  const next = done ? [...list, DONE_STAMP_CLASS] : list.filter((c) => c !== DONE_STAMP_CLASS);
  delete fm.cssclass;
  if (next.length > 0) fm.cssclasses = next;
  else delete fm.cssclasses;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
