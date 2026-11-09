import type { JsonRecord } from './json';

/**
 * "Theme marks": classes some vault themes know how to draw. Off by default; the plugin ships no
 * style for them. Written exactly the way a notebook-style toolkit writes them by hand, so the
 * same tool can edit or remove them:
 *   <span class="ih-sub">…</span>   the one-line takeaway as a subtitle, on the body's first line
 *   <span class="ih-circ">…</span>  a pen circle; one per page
 *   cssclasses: ih-stamp-done       a "done" stamp while status is ✅; one stamp per page
 *
 * Marks a person added are never fought: a subtitle, circle or stamp already on the page wins
 * over the plugin's own, and a subtitle or circle the person edited inside the generated part is
 * carried over when the note is processed again.
 */
export const SUBTITLE_CLASS = 'ih-sub';
export const CIRCLE_CLASS = 'ih-circ';
export const DONE_STAMP_CLASS = 'ih-stamp-done';
export const STAMP_CLASSES = [
  'ih-stamp-draft',
  'ih-stamp-final',
  'ih-stamp-sent',
  'ih-stamp-wait',
  'ih-stamp-done',
];
const DONE_STATUS = '✅';
const GENERATED_BLOCK =
  /<!-- video-summary-generated:start -->([\s\S]*?)<!-- video-summary-generated:end -->/;
/** Same shape the toolkit matches: one line, no nesting. */
const SPAN = /<span class="(ih-[^"]*)">(.*?)<\/span>/g;

export interface ExistingMarks {
  /** a subtitle the person put outside the generated part */
  subOutside: boolean;
  /** the subtitle text inside the generated part, possibly edited by hand */
  subInside?: string;
  circleOutside: boolean;
  circleInside?: string;
}

const sameClass = (a: string, b: string) =>
  a.trim().split(/\s+/).sort().join(' ') === b.trim().split(/\s+/).sort().join(' ');

function findMark(text: string, cls: string): string | undefined {
  for (const match of text.matchAll(SPAN)) if (sameClass(match[1], cls)) return match[2];
  return undefined;
}

/** Reads the marks already in a note body, before the generated part is rewritten. */
export function readExistingMarks(body: string): ExistingMarks {
  const generated = body.match(GENERATED_BLOCK)?.[1] ?? '';
  const outside = body.replace(GENERATED_BLOCK, '');
  return {
    subOutside: findMark(outside, SUBTITLE_CLASS) !== undefined,
    subInside: findMark(generated, SUBTITLE_CLASS),
    circleOutside: findMark(outside, CIRCLE_CLASS) !== undefined,
    circleInside: findMark(generated, CIRCLE_CLASS),
  };
}

/** Adds the subtitle and the circle to a generated note body. */
export function markNoteBody(
  note: string,
  takeaway?: string,
  existing: ExistingMarks = { subOutside: false, circleOutside: false },
): string {
  let body = note || '';
  if (!existing.circleOutside) {
    body =
      existing.circleInside !== undefined
        ? circleText(body, existing.circleInside)
        : circleFirstHighlight(body);
  }
  if (!existing.subOutside) {
    const line =
      existing.subInside !== undefined
        ? existing.subInside
        : escapeHtml((takeaway || '').replace(/\s+/g, ' ').trim());
    if (line.trim()) body = `<span class="${SUBTITLE_CLASS}">${line}</span>\n\n${body}`;
  }
  return body;
}

/** Splits markdown into parts the marks may touch (even) and parts they must not (odd). */
function editableParts(markdown: string): string[] {
  return markdown.split(
    /(```[\s\S]*?```|`[^`\n]*`|<span class="ih-[^"]*">.*?<\/span>|\[\[[^\]\n]*\]\])/,
  );
}

function replaceFirst(markdown: string, find: RegExp, wrap: (text: string) => string): string {
  let done = false;
  return editableParts(markdown)
    .map((part, index) => {
      if (done || index % 2 === 1) return part;
      return part.replace(find, (match: string, text: string) => {
        if (done) return match;
        done = true;
        return wrap(text);
      });
    })
    .join('');
}

const circle = (text: string) => `<span class="${CIRCLE_CLASS}">${text}</span>`;

/** Wraps the first ==highlight== outside code in the circle class. */
export function circleFirstHighlight(markdown: string): string {
  return replaceFirst(markdown, /==([^=\n]+?)==/, circle);
}

/** Circles the same words the person circled last time; no circle when they are gone. */
export function circleText(markdown: string, text: string): string {
  const words = text.trim();
  if (!words) return markdown;
  const escaped = words.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const highlighted = replaceFirst(markdown, new RegExp(`==(${escaped})==`), circle);
  if (highlighted !== markdown) return highlighted;
  return replaceFirst(markdown, new RegExp(`(${escaped})`), circle);
}

/** Stamps a ✅ note as done, unless the page already carries a stamp. Never removes one. */
export function addDoneStamp(fm: JsonRecord): void {
  if (typeof fm.status !== 'string' || fm.status.trim() !== DONE_STATUS) return;
  const raw = fm.cssclasses ?? fm.cssclass;
  const list = (Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\s,]+/) : [])
    .map((value) => String(value).trim())
    .filter(Boolean);
  if (list.some((cls) => STAMP_CLASSES.includes(cls))) return;
  if ('cssclass' in fm && !('cssclasses' in fm)) delete fm.cssclass;
  fm.cssclasses = [...list, DONE_STAMP_CLASS];
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
