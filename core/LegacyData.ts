/**
 * Bringing data from older installs into this version.
 *
 * - Before 2.2.0 the plugin id was `video-summary-plugin`; Obsidian keeps each id in its own
 *   folder, so the new folder starts empty and the old one has to be read once.
 * - A data.json that went through a sync conflict can contain merge markers and no longer parse.
 *   Obsidian's loadData() then throws and every setting, job record and webhook result would be
 *   lost. Instead the readable parts are salvaged: top-level scalar settings and every history
 *   or webhook entry that still parses on its own.
 */
import { isRecord, type JsonRecord } from '../utils/json';

export const LEGACY_PLUGIN_IDS = ['video-summary-plugin'];

export interface SalvageResult {
  settings: JsonRecord;
  /** false when the text parsed as-is */
  corrupt: boolean;
  history: JsonRecord[];
  webhookHistory: JsonRecord[];
}

/** Parse data.json, salvaging what it can when the file is damaged. */
export function salvageSettingsJson(text: string): SalvageResult {
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) {
      return {
        settings: parsed,
        corrupt: false,
        history: entries(parsed.history, isHistoryEntry),
        webhookHistory: entries(parsed.webhookHistory, isWebhookEntry),
      };
    }
  } catch {
    // fall through to salvage
  }

  const settings: JsonRecord = {};
  for (const match of text.matchAll(/^ {2}"([A-Za-z_][\w]*)":\s*(.+?),?\s*$/gm)) {
    const [, key, raw] = match;
    if (key in settings) continue;
    try {
      const value: unknown = JSON.parse(raw);
      if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
        settings[key] = value;
      }
    } catch {
      // a line cut by a merge marker
    }
  }

  const history: JsonRecord[] = [];
  const webhookHistory: JsonRecord[] = [];
  for (const object of outermostObjects(text)) {
    if (isHistoryEntry(object)) history.push(object);
    else if (isWebhookEntry(object)) webhookHistory.push(object);
  }
  return {
    settings,
    corrupt: true,
    history: dedupeHistory(history),
    webhookHistory: dedupeWebhook(webhookHistory),
  };
}

export function isHistoryEntry(value: unknown): value is JsonRecord {
  return (
    isRecord(value) &&
    typeof value.file === 'string' &&
    typeof value.time === 'string' &&
    (value.result === 'success' || value.result === 'error')
  );
}

export function isWebhookEntry(value: unknown): value is JsonRecord {
  return (
    isRecord(value) &&
    typeof value.timestamp === 'number' &&
    isRecord(value.result) &&
    isRecord(value.input)
  );
}

function entries(value: unknown, keep: (item: unknown) => item is JsonRecord): JsonRecord[] {
  return Array.isArray(value) ? (value as unknown[]).filter(keep) : [];
}

const historyKey = (entry: JsonRecord) =>
  [entry.file, entry.time, entry.mode, entry.result].map(String).join('|');

const webhookKey = (entry: JsonRecord) => {
  const input = isRecord(entry.input) ? entry.input : {};
  return `${String(entry.timestamp)}|${String(input.url ?? input.localFile ?? '')}`;
};

/**
 * Job records, oldest first. The first list is kept exactly as it is (two runs of the same note
 * in the same second are two records); later lists only add what the first does not have.
 */
export function mergeHistory(base: JsonRecord[], ...more: JsonRecord[][]): JsonRecord[] {
  const extra = addMissing(base, more, historyKey);
  if (extra.length === 0) return base;
  const time = (entry: JsonRecord) => Date.parse(String(entry.time).replace(/\//g, '-')) || 0;
  return [...base, ...extra]
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => time(a.entry) - time(b.entry) || a.index - b.index)
    .map(({ entry }) => entry);
}

/** Webhook results, newest first; same rule as mergeHistory. */
export function mergeWebhookHistory(base: JsonRecord[], ...more: JsonRecord[][]): JsonRecord[] {
  const extra = addMissing(base, more, webhookKey);
  if (extra.length === 0) return base;
  return [...base, ...extra].sort((a, b) => Number(b.timestamp) - Number(a.timestamp));
}

function addMissing(
  base: JsonRecord[],
  more: JsonRecord[][],
  key: (entry: JsonRecord) => string,
): JsonRecord[] {
  const seen = new Set(base.map(key));
  const extra: JsonRecord[] = [];
  for (const entry of more.flat()) {
    const k = key(entry);
    if (seen.has(k)) continue;
    seen.add(k);
    extra.push(entry);
  }
  return extra;
}

/** A damaged file holds both sides of a conflict, so repeats there are copies, not records. */
function dedupeHistory(list: JsonRecord[]): JsonRecord[] {
  return addMissing([], [list], historyKey);
}

function dedupeWebhook(list: JsonRecord[]): JsonRecord[] {
  return addMissing([], [list], webhookKey);
}

/**
 * Every `{…}` that parses on its own, outermost first: once an object parses, its contents are
 * not scanned again. Strings are respected, so braces inside text do not count.
 */
export function outermostObjects(text: string): JsonRecord[] {
  const found: JsonRecord[] = [];
  let index = 0;
  while (index < text.length) {
    const start = text.indexOf('{', index);
    if (start < 0) break;
    const end = matchingBrace(text, start);
    if (end > start) {
      try {
        const parsed: unknown = JSON.parse(text.slice(start, end + 1));
        if (isRecord(parsed) && (isHistoryEntry(parsed) || isWebhookEntry(parsed))) {
          found.push(parsed);
          index = end + 1;
          continue;
        }
      } catch {
        // damaged: look inside it
      }
    }
    index = start + 1;
  }
  return found;
}

function matchingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      else if (ch === '\n') return -1; // JSON strings never span lines; this one was cut
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
