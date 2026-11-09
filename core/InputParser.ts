import { VideoInput } from '../types';
import { VideoUtils } from '../utils/VideoUtils';
import { detectPlatform } from './Platform';

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
  // 正文里夹着链接的长文（博客、文章）是一篇文稿，不是一串待处理的链接
  if (urls.length > 0 && !looksLikeLinkList(text)) {
    return [
      {
        title: titleForTranscript(text),
        input: buildInput({
          transcript: transcript ? `${text}\n\n${transcript}` : text,
          localFile: localFiles[0],
        }),
        source: 'transcript',
      },
    ];
  }
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
  // 取第一行有文字的内容：跳过只有链接的行，去掉标题符号和 markdown 链接语法
  const firstLine =
    text
      .split('\n')
      .map((line) => proseOf(line.replace(/^#+\s*/, '')))
      .find((line) => line.length > 0) || '';
  const snippet = firstLine.substring(0, 12).replace(/[<>:"/\\|?*\s]/g, '_');
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
  const cleaned = findUrls(text)
    .map((url) =>
      keepPartParam ? VideoUtils.cleanVideoUrlKeepP(url) : VideoUtils.cleanVideoUrl(url),
    )
    .filter((url) => url.length > 0);
  return Array.from(new Set(cleaned));
}

// [标题](链接)：链接里允许一层成对括号，例如 wiki/Goya_(painter)
const MARKDOWN_LINK = /\[([^\]\n]*)\]\((https?:\/\/[^\s()]+(?:\([^\s()]*\)[^\s()]*)*)\)/g;
const BARE_URL = /https?:\/\/[^\s"'<>]+/g;
const TRAILING_PUNCTUATION = /[.,;:!?，。；：！？、】》」』'"]+$/;

/** 按出现顺序找出所有链接，去掉 markdown 语法和句末标点粘上的尾巴 */
function findUrls(text: string): string[] {
  const found: Array<{ index: number; url: string }> = [];
  const masked = text.replace(
    MARKDOWN_LINK,
    (match: string, _label: string, url: string, offset: number) => {
      found.push({ index: offset, url });
      return ' '.repeat(match.length);
    },
  );
  for (const match of masked.matchAll(BARE_URL)) {
    const url = trimUrlTail(match[0]);
    if (url) found.push({ index: match.index ?? 0, url });
  }
  return found.sort((a, b) => a.index - b.index).map((item) => item.url);
}

function trimUrlTail(url: string): string {
  let out = url;
  for (;;) {
    const before = out;
    out = out.replace(TRAILING_PUNCTUATION, '');
    if (
      /[)）]$/.test(out) &&
      count(out, '(') + count(out, '（') < count(out, ')') + count(out, '）')
    ) {
      out = out.slice(0, -1);
    }
    if (out === before) return out.replace(/^https?:\/\/$/, '');
  }
}

function count(value: string, char: string): number {
  return value.split(char).length - 1;
}

/**
 * 主输入框里几乎只有链接（每行一条，最多带一小段备注或标题）时才拆成多个任务；
 * 带大段正文的就是一篇文稿。长度按"中日韩字符算两个"计，免得中文短句被当成长文。
 */
const LINK_LIST_PROSE_BUDGET = 200;
const LINK_LINE_NOTE_LIMIT = 80;
const PLAIN_LINE_NOTE_LIMIT = 40;

function looksLikeLinkList(text: string): boolean {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  let total = 0;
  let linkLines = 0;
  let plainLines = 0;
  let everyLineShort = true;
  for (const line of lines) {
    const hasUrl = /https?:\/\//.test(line);
    const proseLength = weightedLength(proseOf(line));
    total += proseLength;
    if (hasUrl) {
      linkLines += 1;
      if (proseLength > LINK_LINE_NOTE_LIMIT) everyLineShort = false;
    } else {
      plainLines += 1;
      if (proseLength > PLAIN_LINE_NOTE_LIMIT) everyLineShort = false;
    }
  }
  if (total < LINK_LIST_PROSE_BUDGET) return true;
  return everyLineShort && plainLines <= linkLines;
}

/** 一行里除去链接、markdown 链接语法和列表符号后剩下的文字 */
function proseOf(line: string): string {
  return line
    .replace(MARKDOWN_LINK, (_match: string, label: string) => ` ${label} `)
    .replace(BARE_URL, ' ')
    .replace(/^\s*(?:[-*+•]|\d+[.)、])\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function weightedLength(value: string): number {
  let length = 0;
  for (const char of value) {
    length += /[\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/.test(char) ? 2 : 1;
  }
  return length;
}
