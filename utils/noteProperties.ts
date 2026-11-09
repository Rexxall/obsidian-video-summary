import type { JsonRecord } from './json';

/**
 * "Default properties" setting: one `name: value` per line, added to a video note when it is
 * processed. Values the note already has are never overwritten; list properties (tags, aliases,
 * cssclasses) are merged. Lets a vault add its own fields, such as a learning status or a type
 * tag, without the plugin knowing that vault's rules.
 */
export interface DefaultProperty {
  key: string;
  values: string[];
  list: boolean;
}

const LIST_KEYS = new Set(['tags', 'aliases', 'cssclasses']);
const KEY_PATTERN = /^[A-Za-z_぀-ヿ一-鿿][\w぀-ヿ一-鿿-]*$/;

/** Fields the plugin writes or reads itself; a default must not shadow them. */
const RESERVED_KEYS = new Set([
  'status',
  'link',
  'local_file',
  'provided_transcript',
  'summary',
  'source_type',
  'date',
  'updated',
  'processing_error',
  'processing_error_code',
  'processing_error_at',
]);

function isReserved(key: string): boolean {
  return RESERVED_KEYS.has(key) || key.startsWith('video_');
}

export function parseDefaultProperties(text: string): DefaultProperty[] {
  const byKey = new Map<string, DefaultProperty>();
  for (const rawLine of (text || '').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (!KEY_PATTERN.test(key) || isReserved(key) || !value) continue;
    const list = LIST_KEYS.has(key);
    const values = list ? splitList(key, value) : [value];
    if (values.length === 0) continue;
    const existing = byKey.get(key);
    if (existing && list) {
      for (const item of values) if (!existing.values.includes(item)) existing.values.push(item);
    } else if (!existing) {
      byKey.set(key, { key, values, list });
    }
  }
  return Array.from(byKey.values());
}

/**
 * Values a default can take from the processed result, written as {{name}}: {{title}} (a readable
 * note title), {{tldr}}, {{summary}}, {{video_title}}, {{author}}. A default whose placeholders
 * come out empty is skipped, so an older backend that sends no tldr adds no empty field.
 */
export type PropertyValues = Record<string, string | undefined>;

function fill(value: string, values: PropertyValues): string {
  let missing = false;
  const filled = value.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_match: string, name: string) => {
    const text = (values[name] || '').replace(/\s+/g, ' ').trim();
    if (!text) missing = true;
    return text;
  });
  return missing ? '' : filled.trim();
}

/** Adds the defaults to frontmatter in place. Returns true when something changed. */
export function applyDefaultProperties(
  fm: JsonRecord,
  rawDefaults: DefaultProperty[],
  values: PropertyValues = {},
): boolean {
  let changed = false;
  const defaults = rawDefaults
    .map((property) => ({
      ...property,
      values: property.values.map((value) => fill(value, values)).filter(Boolean),
    }))
    .filter((property) => property.values.length > 0);
  for (const property of defaults) {
    if (property.list) {
      const current = toList(fm[property.key]);
      const merged = [...current];
      for (const item of property.values) if (!merged.includes(item)) merged.push(item);
      if (merged.length !== current.length || !Array.isArray(fm[property.key])) {
        fm[property.key] = merged;
        changed = true;
      }
      continue;
    }
    const current = fm[property.key];
    const empty =
      current === undefined ||
      current === null ||
      (typeof current === 'string' && current.trim() === '');
    if (empty) {
      fm[property.key] = property.values[0];
      changed = true;
    }
  }
  return changed;
}

function splitList(key: string, value: string): string[] {
  return value
    .split(/[,，]/)
    .map((item) => item.trim())
    .map((item) => (key === 'tags' ? item.replace(/^#/, '') : item))
    .filter(Boolean);
}

function toList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === 'string')
    return value
      .split(/[,\s]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  return [];
}
