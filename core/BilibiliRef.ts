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
