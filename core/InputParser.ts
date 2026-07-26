// agent: claude (2026-07-26)
import { VideoInput } from '../types';
import { VideoUtils } from '../utils/VideoUtils';
import { detectPlatform } from './NoteIndex';

export type DraftSource = 'url' | 'local-file' | 'transcript' | 'json';

export interface JobDraft {
  title: string;
  input: VideoInput;
  source: DraftSource;
  platform?: string;
  /** JSON 模式下保留原始文本，走"从 webhook 结果建笔记"的路径 */
  rawJson?: string;
}

export interface ParseOptions {
  /** 手动粘贴的文稿，作用于所有 draft */
  transcript?: string;
  /** 本地文件，逗号分隔 */
  localFiles?: string;
  /** 单链接时保留 ?p= 参数 */
  keepPartParam?: boolean;
}

const MEDIA_EXTENSIONS = /\.(mp4|mkv|mov|avi|flv|webm|mp3|m4a|wav|aac|flac|ogg)$/i;

/**
 * 一个输入框吃掉所有输入形态：链接、多行链接、本地文件、纯文稿、webhook JSON。
 * 旧版把这些拆成三个 radio + 两个额外输入框，这里靠内容嗅探分流。
 */
export function parseInput(raw: string, options: ParseOptions = {}): JobDraft[] {
  const text = (raw || '').trim();
  const transcript = (options.transcript || '').trim();
  const localFiles = splitLocalFiles(options.localFiles || '');

  if (text && looksLikeJson(text)) {
    return [
      {
        title: 'Webhook JSON',
        input: {},
        source: 'json',
        rawJson: text,
      },
    ];
  }

  const urls = extractUrls(text, options.keepPartParam === true);
  if (urls.length > 0) {
    return urls.map((url) => ({
      title: titleForUrl(url),
      input: buildInput({ url, transcript, localFile: localFiles[0] }),
      source: 'url' as const,
      platform: detectPlatform(url),
    }));
  }

  if (localFiles.length > 0) {
    return localFiles.map((file) => ({
      title: titleForLocalFile(file),
      input: buildInput({ transcript, localFile: file }),
      source: 'local-file' as const,
    }));
  }

  // 输入框里直接是一条本地路径 / 文件名
  if (text && (MEDIA_EXTENSIONS.test(text) || isAbsoluteLocalPath(text))) {
    return [
      {
        title: titleForLocalFile(text),
        input: buildInput({ transcript, localFile: text }),
        source: 'local-file',
      },
    ];
  }

  const body = transcript || text;
  if (body) {
    return [
      {
        title: titleForTranscript(body),
        input: buildInput({ transcript: body }),
        source: 'transcript',
      },
    ];
  }

  return [];
}

/** 分P范围展开：把一条 B站/YouTube 链接展成 start..end 的多个 draft */
export function expandParts(
  url: string,
  startPart: number,
  endPart: number,
  options: ParseOptions = {},
): JobDraft[] {
  const videoId = extractVideoId(url);
  if (!videoId) return [];
  const transcript = (options.transcript || '').trim();
  const localFile = splitLocalFiles(options.localFiles || '')[0];
  const drafts: JobDraft[] = [];
  for (let index = startPart; index <= endPart; index += 1) {
    const partUrl = VideoUtils.generatePartUrl(url, videoId, index);
    drafts.push({
      title: `${titleForUrl(partUrl)}_P${index}`,
      input: buildInput({ url: partUrl, transcript, localFile }),
      source: 'url',
      platform: detectPlatform(partUrl),
    });
  }
  return drafts;
}

export function extractVideoId(url: string): string | null {
  const cleanUrl = VideoUtils.cleanVideoUrl(url);
  const bilibili = cleanUrl.match(/\/video\/(BV[a-zA-Z0-9]+)/);
  if (bilibili) return bilibili[1];
  const youtube = cleanUrl.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]+)/);
  if (youtube) return youtube[1];
  const numeric = cleanUrl.match(/\/video\/(\d+)/);
  if (numeric) return numeric[1];
  return null;
}

export function titleForUrl(url: string): string {
  const videoId = extractVideoId(url) || 'video';
  switch (detectPlatform(url)) {
    case 'bilibili':
      return `B站视频_${videoId}`;
    case 'youtube':
      return `YouTube视频_${videoId}`;
    case 'douyin':
      return `抖音视频_${videoId}`;
    case 'tiktok':
      return `TikTok视频_${videoId}`;
    case 'xiaohongshu':
      return `小红书_${videoId}`;
    default:
      return `视频_${videoId}`;
  }
}

export function isAbsoluteLocalPath(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  return /^([a-zA-Z]:\\|\\\\|\/)/.test(trimmed);
}

function titleForLocalFile(path: string): string {
  const fileName = path.split('/').pop() || path.split('\\').pop() || 'local_file';
  return `本地文件_${fileName}`;
}

function titleForTranscript(text: string): string {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    '_',
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('');
  const snippet = text
    .split('\n')[0]
    .substring(0, 12)
    .replace(/[<>:"/\\|?*\s]/g, '_');
  return snippet ? `文稿_${stamp}_${snippet}` : `文稿处理_${stamp}`;
}

function buildInput(parts: { url?: string; transcript?: string; localFile?: string }): VideoInput {
  const input: VideoInput = {};
  if (parts.url) input.url = parts.url;
  if (parts.transcript) input.transcript = parts.transcript;
  if (parts.localFile) input.localFile = parts.localFile;
  return input;
}

function splitLocalFiles(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function looksLikeJson(text: string): boolean {
  if (!/^[[{]/.test(text)) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function extractUrls(text: string, keepPartParam: boolean): string[] {
  if (!text) return [];
  const matches = text.match(/https?:\/\/[^\s"'<>]+/g) || [];
  const cleaned = matches
    .map((url) =>
      keepPartParam ? VideoUtils.cleanVideoUrlKeepP(url) : VideoUtils.cleanVideoUrl(url),
    )
    .filter((url) => url.length > 0);
  return Array.from(new Set(cleaned));
}
