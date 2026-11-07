import type { JsonRecord } from './json';

/** Adds a class to the note's cssclasses, keeping the ones already there. */
export function withCssClass(fm: JsonRecord, cssClass: string): void {
  const name = cssClass.trim();
  if (!/^[A-Za-z][\w-]*$/.test(name)) return;
  const raw = fm.cssclasses ?? fm.cssclass;
  const list = (Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\s,]+/) : [])
    .map((value) => String(value).trim())
    .filter(Boolean);
  if (!list.includes(name)) list.push(name);
  delete fm.cssclass;
  fm.cssclasses = list;
}
