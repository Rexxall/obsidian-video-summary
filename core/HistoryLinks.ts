import type { ProcessingHistory } from '../types';

/**
 * Finds the note a history record points to. Records before 2.13.3 kept only the file name at
 * the time, so a note renamed, moved or retitled since is looked up by its video title or link.
 */
export interface HistoryLookup {
  exists(path: string): boolean;
  /** A note with exactly this name anywhere in the vault. */
  byName(name: string): string | undefined;
  /** A video note whose video_title or link matches. */
  byTitle(title: string): string | undefined;
  byUrl(url: string): string | undefined;
}

/** "Name (1)" and "Name_1764151234567" are copies the plugin made when the name was taken. */
export function baseName(name: string): string {
  return name.replace(/(\s*\(\d+\)|_\d{10,})$/, '').trim();
}

/** Names many notes share; matching on them opens the wrong note. */
const GENERIC_NAME = /^(未命名|无标题|untitled)( \d+)?$/i;

export function resolveHistoryPath(
  record: Pick<ProcessingHistory, 'file' | 'path' | 'url'>,
  lookup: HistoryLookup,
): string | undefined {
  if (record.path && lookup.exists(record.path)) return record.path;
  const name = (record.file || '').normalize('NFC').trim();
  if (!name || GENERIC_NAME.test(name)) return record.url ? lookup.byUrl(record.url) : undefined;
  const plain = baseName(name);
  return (
    lookup.byName(name) ??
    lookup.byTitle(name) ??
    (plain !== name ? (lookup.byName(plain) ?? lookup.byTitle(plain)) : undefined) ??
    (record.url ? lookup.byUrl(record.url) : undefined)
  );
}

/** Moves records that pointed at a renamed note to its new path and name. */
export function followRename(
  history: ProcessingHistory[],
  oldPath: string,
  newPath: string,
  newName: string,
): boolean {
  const oldName = oldPath.replace(/^.*\//, '').replace(/\.md$/, '');
  let changed = false;
  for (const record of history) {
    if (record.path === oldPath || (!record.path && record.file === oldName)) {
      record.path = newPath;
      record.file = newName;
      changed = true;
    }
  }
  return changed;
}
