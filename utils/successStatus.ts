import type { JsonRecord } from './json';

export type PluginStatus = 'pending' | 'running' | 'success' | 'error' | 'excluded';

/**
 * The plugin's own state lives in `video_summary_status`; `status` only mirrors it for people who
 * filter on `status`. So the text written to `status` on success can be anything that is not a
 * pending, running or excluded marker, including a vault's own "not reviewed yet" mark such as ❌.
 */
const RESERVED_SUCCESS_TEXT = new Set([
  'pending',
  'running',
  'error',
  'excluded',
  '📺',
  '⏳',
  '⛔',
  '⛔️',
  '待处理',
  '处理中',
  '处理失败',
  '非视频笔记',
]);

export function normalizeSuccessStatusText(value: unknown, fallback = 'success'): string {
  const text = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  if (!text) return fallback;
  return RESERVED_SUCCESS_TEXT.has(text.toLowerCase()) ? fallback : text;
}

/**
 * Values the plugin may overwrite in `status`, plus whatever success text is configured. Anything
 * else belongs to the person and is kept: 🔍, a project's own value, and ✅ or ▶️, which older
 * versions wrote on success but many vaults now use for "learned" and "learning".
 */
const MIRRORED_STATUS = new Set([
  'pending',
  'running',
  'success',
  'error',
  'excluded',
  '📺',
  '⏳',
  '❌',
  '⛔️',
  '⛔',
  '待处理',
  '处理中',
  '已处理',
  '处理失败',
  '非视频笔记',
]);

export function shouldMirrorStatus(value: unknown, successText?: string): boolean {
  const text = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  if (text === '') return true;
  if (successText && text === successText.trim()) return true;
  return MIRRORED_STATUS.has(text.toLowerCase());
}

/** Writes the plugin state and, where `status` is still the plugin's, the display text. */
export function writePluginStatus(
  fm: JsonRecord,
  state: PluginStatus,
  displayText: string,
  successText?: string,
): void {
  const mirror = shouldMirrorStatus(fm.status, successText);
  fm.video_summary = true;
  if (!fm.source_type) fm.source_type = 'video';
  fm.video_summary_status = state;
  if (mirror) fm.status = displayText;
}
