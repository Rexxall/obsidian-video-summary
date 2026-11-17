/** Bilibili link parsing and frame picking, free of Obsidian imports so they can be tested. */

export interface BilibiliRef {
  bvid: string;
  part: number;
}

/** The video and part a Bilibili link points to, or null. */
export function bilibiliRef(url: string | undefined): BilibiliRef | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (!/(^|\.)bilibili\.com$/.test(parsed.hostname)) return null;
    const match = parsed.pathname.match(/^\/video\/(BV[0-9A-Za-z]{10})/);
    if (!match) return null;
    const part = Number(parsed.searchParams.get('p')) || 1;
    return { bvid: match[1], part: part > 0 ? part : 1 };
  } catch {
    return null;
  }
}

/** One frame inside a Bilibili preview sheet, as the browser extension found it on the page. */
export interface SheetFrame {
  u: string;
  x: number;
  y: number;
  w: number;
  h: number;
  t: number;
}

const BILIBILI_IMAGE = /^https:\/\/[\w.-]+\.hdslb\.com\/[\w/.-]+\.(jpe?g|png|webp)$/i;

/** A Bilibili picture address the plugin may download: https, on Bilibili's image host. */
export function isBilibiliImage(url: string | undefined): boolean {
  return BILIBILI_IMAGE.test(String(url || '').replace(/^http:\/\//, 'https://'));
}

/** A full-size frame the extension took on the page: its second and the JPEG bytes. */
export interface FrameImage {
  t: number;
  bytes: Uint8Array;
}

const MAX_FRAME_BYTES = 4 * 1024 * 1024;

/**
 * The full-size frames the extension sent over the background channel, kept only when each
 * one is a JPEG of sane size at a sane time. Anything else is dropped, never saved.
 */
export function parseFrameImages(text: string | undefined): FrameImage[] {
  let list: unknown;
  try {
    list = JSON.parse(String(text || '[]'));
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const out: FrameImage[] = [];
  for (const item of list.slice(0, 4)) {
    if (!item || typeof item !== 'object') continue;
    const { t, d } = item as { t?: unknown; d?: unknown };
    if (typeof t !== 'number' || !Number.isFinite(t) || t < 0 || t > 86400) continue;
    if (typeof d !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(d)) continue;
    if ((d.length * 3) / 4 > MAX_FRAME_BYTES) continue;
    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(atob(d), (c) => c.charCodeAt(0));
    } catch {
      continue;
    }
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) continue;
    out.push({ t, bytes });
  }
  return out;
}

/** Where full-size frames were saved: vault paths and their seconds. */
export function parseFrameFiles(text: string | undefined): { p: string; t: number }[] {
  let list: unknown;
  try {
    list = JSON.parse(String(text || '[]'));
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  return list
    .slice(0, 4)
    .filter(
      (item): item is { p: string; t: number } =>
        !!item &&
        typeof item === 'object' &&
        typeof (item as { p?: unknown }).p === 'string' &&
        /\.jpg$/i.test((item as { p: string }).p) &&
        !(item as { p: string }).p.split('/').includes('..') &&
        typeof (item as { t?: unknown }).t === 'number',
    );
}

/** The frames the extension sent, kept only when each one is a sane cut of a Bilibili sheet. */
export function parseSheetFrames(text: string | undefined): SheetFrame[] {
  let list: unknown;
  try {
    list = JSON.parse(String(text || '[]'));
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const whole = (n: unknown, max: number) =>
    typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= max;
  return list
    .slice(0, 4)
    .filter(
      (item): item is SheetFrame =>
        !!item &&
        typeof item === 'object' &&
        isBilibiliImage((item as SheetFrame).u) &&
        whole((item as SheetFrame).x, 20000) &&
        whole((item as SheetFrame).y, 20000) &&
        whole((item as SheetFrame).w, 4000) &&
        (item as SheetFrame).w > 0 &&
        whole((item as SheetFrame).h, 4000) &&
        (item as SheetFrame).h > 0 &&
        typeof (item as SheetFrame).t === 'number',
    );
}
