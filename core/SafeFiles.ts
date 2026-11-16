/**
 * Reading and writing the plugin's own JSON files (history.json, data.json, pending results)
 * so that a damaged or unreadable file is set aside instead of overwritten, and a save is
 * checked by reading it back. No obsidian import: tests pass an in-memory adapter.
 */

/** The DataAdapter calls this needs; app.vault.adapter has them all. */
export interface FileAdapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  copy?(from: string, to: string): Promise<void>;
}

export type GuardedRead =
  | { state: 'missing' }
  | { state: 'ok'; value: unknown; recovered?: boolean }
  /** The file is there but could not be read or parsed; `backup` is where it was set aside. */
  | { state: 'unreadable'; backup: string | null };

/** `history.json` → `history.unreadable-<time>.json`, next to it. */
export function asideName(path: string, kind: 'unreadable' | 'corrupt', now: number): string {
  const dot = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  const stem = dot > slash ? path.slice(0, dot) : path;
  const ext = dot > slash ? path.slice(dot) : '';
  return `${stem}.${kind}-${now}${ext}`;
}

/**
 * The file's JSON. An unreadable or unparseable file is moved aside (renamed, so even bytes
 * that cannot be read are kept) and reported, so the caller starts empty without later
 * overwriting it. A save cut off between its steps leaves `<path>.tmp`: it is used when the
 * file itself is gone.
 */
export async function readJsonGuarded(
  adapter: FileAdapter,
  path: string,
  now = Date.now(),
): Promise<GuardedRead> {
  const tmp = `${path}.tmp`;
  let present: boolean;
  try {
    present = await adapter.exists(path);
  } catch {
    return { state: 'unreadable', backup: null };
  }
  if (!present) {
    const recovered = await readParsed(adapter, tmp);
    if (recovered === undefined) return { state: 'missing' };
    await adapter.rename(tmp, path).catch(() => undefined);
    return { state: 'ok', value: recovered, recovered: true };
  }
  const value = await readParsed(adapter, path);
  if (value !== undefined) return { state: 'ok', value };
  const backup = asideName(path, 'unreadable', now);
  try {
    await adapter.rename(path, backup);
    return { state: 'unreadable', backup };
  } catch {
    return { state: 'unreadable', backup: null };
  }
}

async function readParsed(adapter: FileAdapter, path: string): Promise<unknown> {
  try {
    if (!(await adapter.exists(path))) return undefined;
    const raw = await adapter.read(path);
    return raw.trim() ? (JSON.parse(raw) as unknown) : undefined;
  } catch {
    return undefined;
  }
}

export class SaveCheckError extends Error {
  constructor(path: string) {
    super(`${path} did not read back as written`);
    this.name = 'SaveCheckError';
  }
}

/**
 * Writes `text` to a temporary file, reads it back, and only then puts it in place, checking
 * the result once more. A crash midway leaves either the old file or the checked temporary
 * one (which readJsonGuarded picks up), never half a file.
 */
export async function writeJsonChecked(
  adapter: FileAdapter,
  path: string,
  text: string,
): Promise<void> {
  const tmp = `${path}.tmp`;
  await adapter.write(tmp, text);
  if ((await adapter.read(tmp)) !== text) throw new SaveCheckError(tmp);
  if (await adapter.exists(path)) await adapter.remove(path);
  await adapter.rename(tmp, path);
  if ((await adapter.read(path)) !== text) throw new SaveCheckError(path);
}

/** Same data, whatever the indentation: what saveData wrote against what was meant. */
export function sameJson(raw: string, expected: unknown): boolean {
  try {
    return JSON.stringify(JSON.parse(raw)) === JSON.stringify(expected);
  } catch {
    return false;
  }
}
