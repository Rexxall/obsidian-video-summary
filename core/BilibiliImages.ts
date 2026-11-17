import { App, TFile, requestUrl } from 'obsidian';

import type { NoteImage } from './NoteStyle';
import {
  bilibiliRef,
  isBilibiliImage,
  parseFrameFiles,
  parseSheetFrames,
  type FrameImage,
} from './BilibiliRef';

/**
 * Pictures of a Bilibili video for its note: the cover and three frames, saved into the vault.
 *
 * Bilibili's image host refuses a picture embedded from another site, so a link to it in a note
 * shows nothing; downloaded here (no page, no referer) it is an ordinary local file that also
 * works offline. Bilibili keeps no single frames, only preview sheets of small frames; the
 * browser extension reads from the page where three of them sit, and they are cut out here.
 */

const https = (url: string) => url.replace(/^\/\//, 'https://').replace(/^http:\/\//, 'https://');

const clock = (seconds: number) => {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
};

async function getBytes(url: string): Promise<ArrayBuffer | null> {
  if (!isBilibiliImage(url)) return null;
  const reply = await requestUrl({ url: https(url), throw: false });
  return reply.status < 400 && reply.arrayBuffer.byteLength > 0 ? reply.arrayBuffer : null;
}

async function cutFrame(
  sheet: ArrayBuffer,
  x: number,
  y: number,
  width: number,
  height: number,
): Promise<ArrayBuffer> {
  const bitmap = await createImageBitmap(new Blob([sheet]), x, y, width, height);
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
  bitmap.close();
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.88 });
  return blob.arrayBuffer();
}

/** Saves a picture next to the note, or finds the one an earlier run saved under that name. */
async function save(app: App, name: string, notePath: string, data: ArrayBuffer): Promise<string> {
  const existing = app.vault.getFiles().find((file) => file.name === name);
  if (existing instanceof TFile) return existing.path;
  const path = await app.fileManager.getAvailablePathForAttachment(name, notePath);
  await app.vault.createBinary(path, data);
  return path;
}

/**
 * Saves the full-size frames the extension took, next to the capture note, under the names the
 * preview-sheet cuts would get; an older picture of the same name is replaced. Returns what
 * goes into the note's properties, or '' when nothing was saved.
 */
export async function saveFrameImages(
  app: App,
  url: string | undefined,
  notePath: string,
  frames: FrameImage[],
): Promise<string> {
  const ref = bilibiliRef(url);
  if (!ref || !frames.length) return '';
  const stem = `${ref.bvid}-p${ref.part}`;
  const saved: { p: string; t: number }[] = [];
  for (let n = 0; n < frames.length; n += 1) {
    const name = `${stem}-${n + 1}.jpg`;
    const data = frames[n].bytes.slice().buffer;
    const existing = app.vault.getFiles().find((file) => file.name === name);
    let path: string;
    if (existing instanceof TFile) {
      await app.vault.modifyBinary(existing, data);
      path = existing.path;
    } else {
      path = await app.fileManager.getAvailablePathForAttachment(name, notePath);
      await app.vault.createBinary(path, data);
    }
    saved.push({ p: path, t: frames[n].t });
  }
  return JSON.stringify(saved);
}

/** A vault path as a Markdown image target. */
const target = (path: string) => encodeURI(path);

export async function bilibiliNoteImages(
  app: App,
  url: string | undefined,
  notePath: string,
  cover: string | undefined,
  framesJson: string | undefined,
  frameFilesJson?: string,
): Promise<NoteImage[]> {
  const ref = bilibiliRef(url);
  if (!ref) return [];
  const stem = `${ref.bvid}-p${ref.part}`;
  const images: NoteImage[] = [];

  const coverBytes = cover ? await getBytes(cover) : null;
  if (coverBytes) {
    const path = await save(app, `${stem}-cover.jpg`, notePath, coverBytes);
    images.push({ url: target(path), label: 'cover' });
  }

  // Full-size frames the extension already saved: used as they are.
  const files = parseFrameFiles(frameFilesJson).filter(
    (item) => app.vault.getAbstractFileByPath(item.p) instanceof TFile,
  );
  if (files.length) {
    for (const item of files)
      images.push({ url: target(item.p), label: `frame near [${clock(item.t)}]` });
    return images;
  }

  // Otherwise cut from Bilibili's preview sheets: small (often 480×270), so the label says so.
  const sheets = new Map<string, ArrayBuffer | null>();
  const frames = parseSheetFrames(framesJson);
  for (let n = 0; n < frames.length; n += 1) {
    const frame = frames[n];
    if (!sheets.has(frame.u)) sheets.set(frame.u, await getBytes(frame.u));
    const sheet = sheets.get(frame.u);
    if (!sheet) continue;
    const data = await cutFrame(sheet, frame.x, frame.y, frame.w, frame.h);
    const path = await save(app, `${stem}-${n + 1}.jpg`, notePath, data);
    images.push({
      url: target(path),
      label: `frame near [${clock(frame.t)}], low-resolution preview`,
    });
  }
  return images;
}
