export type PlaylistPlatform = 'youtube' | 'bilibili';
export type PlaylistSourceType = 'playlist' | 'collection' | 'favorites';

export interface PlaylistItem {
  platform: PlaylistPlatform;
  videoId: string;
  canonicalKey: string;
  canonicalUrl: string;
  title: string;
  author: string;
  duration?: string;
  position: number;
  /** Kept as a read-only compatibility alias for older callers. */
  url: string;
  /** Present for Bilibili items only. */
  bvid?: string;
}

export interface PlaylistInfo {
  platform: PlaylistPlatform;
  sourceType: PlaylistSourceType;
  sourceId: string;
  canonicalSourceUrl: string;
  originalUrl: string;
  title: string;
  description?: string;
  itemCount: number;
  items: PlaylistItem[];
  fetchedPages: number;
  truncated: boolean;
}

export interface PlaylistRequest {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  contentType?: string;
}

export interface PlaylistResponse {
  status: number;
  text: string;
  json?: unknown;
}

export type PlaylistRequester = (request: PlaylistRequest) => Promise<PlaylistResponse>;

export interface PlaylistProcessorOptions {
  requester?: PlaylistRequester;
  maxItems?: number;
  pageSize?: number;
  maxPages?: number;
}

interface ParsedPlaylistUrl {
  platform: PlaylistPlatform;
  sourceType: PlaylistSourceType;
  sourceId: string;
  canonicalSourceUrl: string;
  originalUrl: string;
  ownerId?: string;
  bilibiliIdParam?: 'fid' | 'media_id' | 'sid';
}

interface YouTubeBootstrap {
  initialData: unknown;
  apiKey?: string;
  context?: unknown;
  clientVersion?: string;
}

const DEFAULT_MAX_ITEMS = 500;
const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX_PAGES = 20;
const BILIBILI_REFERER = 'https://www.bilibili.com/';
const YOUTUBE_CLIENT_VERSION_FALLBACK = '2.20260701.00.00';

/**
 * Fetches bounded public playlist metadata without a CORS proxy. In Obsidian it
 * uses requestUrl; tests and alternate runtimes can inject the same small
 * requester contract.
 */
export class PlaylistProcessor {
  private readonly requester: PlaylistRequester;
  private readonly maxItems: number;
  private readonly pageSize: number;
  private readonly maxPages: number;

  constructor(options: PlaylistProcessorOptions = {}) {
    this.requester = options.requester ?? obsidianRequester;
    this.maxItems = boundedInteger(options.maxItems, DEFAULT_MAX_ITEMS, 1, 2_000);
    this.pageSize = boundedInteger(options.pageSize, DEFAULT_PAGE_SIZE, 1, 100);
    this.maxPages = boundedInteger(options.maxPages, DEFAULT_MAX_PAGES, 1, 100);
  }

  static isPlaylistUrl(url: string): boolean {
    try {
      parsePlaylistUrl(url);
      return true;
    } catch {
      return false;
    }
  }

  static parseUrl(url: string): ParsedPlaylistUrl {
    return parsePlaylistUrl(url);
  }

  static async extract(url: string, options: PlaylistProcessorOptions = {}): Promise<PlaylistInfo> {
    return new PlaylistProcessor(options).extract(url);
  }

  /** Compatibility name retained for the existing batch modal. */
  static async extractBvIds(
    url: string,
    options: PlaylistProcessorOptions = {},
  ): Promise<PlaylistInfo> {
    return this.extract(url, options);
  }

  async extract(url: string): Promise<PlaylistInfo> {
    const parsed = parsePlaylistUrl(url);
    return parsed.platform === 'youtube'
      ? this.extractYouTube(parsed)
      : this.extractBilibili(parsed);
  }

  private async extractYouTube(parsed: ParsedPlaylistUrl): Promise<PlaylistInfo> {
    const first = await this.request({
      url: parsed.canonicalSourceUrl,
      headers: {
        Accept: 'text/html',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });
    const bootstrap = parseYouTubeBootstrap(first.text);
    const items: PlaylistItem[] = [];
    const seen = new Set<string>();
    let pageData: unknown = bootstrap.initialData;
    let pages = 0;
    let truncated = false;
    const usedContinuations = new Set<string>();

    while (pages < this.maxPages && items.length < this.maxItems) {
      pages += 1;
      appendYouTubeItems(pageData, items, seen, this.maxItems);
      const continuation = firstStringAtKey(pageData, 'token', (parent) =>
        hasOwn(parent, 'continuationCommand'),
      );
      if (!continuation) break;
      if (usedContinuations.has(continuation)) {
        throw new Error('YouTube 返回了重复分页令牌，已停止以避免循环');
      }
      usedContinuations.add(continuation);
      if (!bootstrap.apiKey || !bootstrap.context) {
        truncated = true;
        break;
      }
      if (pages >= this.maxPages || items.length >= this.maxItems) {
        truncated = true;
        break;
      }
      const next = await this.request({
        url: `https://www.youtube.com/youtubei/v1/browse?key=${encodeURIComponent(
          bootstrap.apiKey,
        )}`,
        method: 'POST',
        contentType: 'application/json',
        headers: {
          'Content-Type': 'application/json',
          'X-Youtube-Client-Name': '1',
          'X-Youtube-Client-Version': bootstrap.clientVersion ?? YOUTUBE_CLIENT_VERSION_FALLBACK,
        },
        body: JSON.stringify({
          context: bootstrap.context,
          continuation,
        }),
      });
      pageData = next.json ?? parseJson(next.text, 'YouTube continuation');
    }

    if (items.length >= this.maxItems) truncated = true;
    const metadata = findFirstRecordAtKey(bootstrap.initialData, 'playlistMetadataRenderer');
    const sidebar = findFirstRecordAtKey(bootstrap.initialData, 'videoOwnerRenderer');
    const title = stringField(metadata, 'title') || `YouTube 播放列表 ${parsed.sourceId}`;
    const description = stringField(metadata, 'description') || textFromRenderer(sidebar);
    if (items.length === 0) {
      throw new Error(
        'YouTube 播放列表没有可读取的公开视频：来源可能为空、私密，或公开页面结构已变化',
      );
    }

    return {
      platform: parsed.platform,
      sourceType: parsed.sourceType,
      sourceId: parsed.sourceId,
      canonicalSourceUrl: parsed.canonicalSourceUrl,
      originalUrl: parsed.originalUrl,
      title,
      description,
      itemCount: items.length,
      items,
      fetchedPages: pages,
      truncated,
    };
  }

  private async extractBilibili(parsed: ParsedPlaylistUrl): Promise<PlaylistInfo> {
    if (parsed.sourceType === 'favorites') {
      return this.extractBilibiliFavorites(parsed);
    }
    return this.extractBilibiliCollection(parsed);
  }

  private async extractBilibiliFavorites(parsed: ParsedPlaylistUrl): Promise<PlaylistInfo> {
    const idParam = parsed.bilibiliIdParam === 'fid' ? 'fid' : 'media_id';
    const info = await this.requestJson(
      `https://api.bilibili.com/x/v3/fav/folder/info?${idParam}=${encodeURIComponent(
        parsed.sourceId,
      )}`,
    );
    assertBilibiliSuccess(info, '获取收藏夹信息');
    const infoData = recordField(info, 'data');
    const items: PlaylistItem[] = [];
    const seen = new Set<string>();
    let page = 1;
    let truncated = false;

    while (
      page <= this.maxPages &&
      items.length < this.maxItems &&
      (page === 1 || items.length > 0)
    ) {
      const response = await this.requestJson(
        `https://api.bilibili.com/x/v3/fav/resource/list?${idParam}=${encodeURIComponent(
          parsed.sourceId,
        )}&pn=${page}&ps=${this.pageSize}&order=mtime&type=0&tid=0`,
      );
      assertBilibiliSuccess(response, '获取收藏夹视频');
      const data = recordField(response, 'data');
      const medias = arrayField(data, 'medias');
      appendBilibiliItems(medias, items, seen, this.maxItems);
      const hasMore =
        booleanField(data, 'has_more') ??
        page * this.pageSize < (numberField(recordField(data, 'info'), 'media_count') ?? 0);
      if (!hasMore || medias.length === 0) break;
      page += 1;
    }
    if (page > this.maxPages || items.length >= this.maxItems) truncated = true;

    return {
      platform: parsed.platform,
      sourceType: parsed.sourceType,
      sourceId: parsed.sourceId,
      canonicalSourceUrl: parsed.canonicalSourceUrl,
      originalUrl: parsed.originalUrl,
      title: stringField(infoData, 'title') || `B站收藏夹 ${parsed.sourceId}`,
      description: stringField(infoData, 'intro'),
      itemCount: items.length,
      items,
      fetchedPages: Math.min(page, this.maxPages),
      truncated,
    };
  }

  private async extractBilibiliCollection(parsed: ParsedPlaylistUrl): Promise<PlaylistInfo> {
    const infoParam =
      parsed.bilibiliIdParam === 'media_id' ? 'media_id' : (parsed.bilibiliIdParam ?? 'sid');
    const info = await this.requestJson(
      `https://api.bilibili.com/x/v1/medialist/info?${infoParam}=${encodeURIComponent(
        parsed.sourceId,
      )}`,
    );
    assertBilibiliSuccess(info, '获取合集信息');
    const infoData = recordField(info, 'data');
    const items: PlaylistItem[] = [];
    const seen = new Set<string>();
    let page = 1;
    let offset = 0;
    let truncated = false;

    while (page <= this.maxPages && items.length < this.maxItems) {
      const response = await this.requestJson(
        `https://api.bilibili.com/x/v1/medialist/resource/list?type=3&biz_id=${encodeURIComponent(
          parsed.sourceId,
        )}&offset_index=${offset}&from=web&first_page=${page === 1 ? 'true' : 'false'}&ps=${
          this.pageSize
        }`,
      );
      assertBilibiliSuccess(response, '获取合集视频');
      const data = recordField(response, 'data');
      const mediaList = arrayField(data, 'mediaList');
      appendBilibiliItems(mediaList, items, seen, this.maxItems);
      const hasMore = booleanField(data, 'has_more') ?? booleanField(data, 'hasMore') ?? false;
      if (!hasMore || mediaList.length === 0) break;
      offset += mediaList.length;
      page += 1;
    }
    if (page > this.maxPages || items.length >= this.maxItems) truncated = true;

    return {
      platform: parsed.platform,
      sourceType: parsed.sourceType,
      sourceId: parsed.sourceId,
      canonicalSourceUrl: parsed.canonicalSourceUrl,
      originalUrl: parsed.originalUrl,
      title: stringField(infoData, 'title') || `B站合集 ${parsed.sourceId}`,
      description: stringField(infoData, 'intro'),
      itemCount: items.length,
      items,
      fetchedPages: Math.min(page, this.maxPages),
      truncated,
    };
  }

  private async requestJson(url: string): Promise<unknown> {
    const response = await this.request({
      url,
      headers: {
        Accept: 'application/json',
        Referer: BILIBILI_REFERER,
      },
    });
    return response.json ?? parseJson(response.text, url);
  }

  private async request(request: PlaylistRequest): Promise<PlaylistResponse> {
    const response = await this.requester(request);
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`播放列表请求失败: HTTP ${response.status}`);
    }
    return response;
  }

  static isValidBvid(bvid: string): boolean {
    return /^BV[a-zA-Z0-9]{10}$/.test(bvid);
  }

  static extractBvIdsFromText(text: string): string[] {
    const matches = text.match(/BV[a-zA-Z0-9]{10}/g);
    return matches ? [...new Set(matches)] : [];
  }

  static generateVideoUrl(bvid: string): string {
    return canonicalVideoUrl('bilibili', bvid);
  }
}

export function canonicalVideoKey(platform: PlaylistPlatform, videoId: string): string {
  const normalized = normalizeVideoId(platform, videoId);
  return `${platform}:${normalized}`;
}

export function canonicalVideoUrl(platform: PlaylistPlatform, videoId: string): string {
  const normalized = normalizeVideoId(platform, videoId);
  return platform === 'youtube'
    ? `https://www.youtube.com/watch?v=${encodeURIComponent(normalized)}`
    : `https://www.bilibili.com/video/${normalized}`;
}

export function canonicalizeVideoUrl(url: string): {
  platform: PlaylistPlatform;
  videoId: string;
  canonicalKey: string;
  canonicalUrl: string;
} {
  const parsed = new URL(normalizeUrlInput(url));
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  let platform: PlaylistPlatform;
  let videoId: string | null = null;
  if (host === 'youtu.be') {
    platform = 'youtube';
    videoId = parsed.pathname.split('/').filter(Boolean)[0] ?? null;
  } else if (host.endsWith('youtube.com')) {
    platform = 'youtube';
    videoId =
      parsed.searchParams.get('v') ??
      (/^\/shorts\//.test(parsed.pathname) ? parsed.pathname.split('/')[2] : null);
  } else if (host.endsWith('bilibili.com')) {
    platform = 'bilibili';
    videoId = parsed.pathname.match(/\/video\/(BV[a-zA-Z0-9]{10})/i)?.[1] ?? null;
  } else {
    throw new Error('不支持的视频链接');
  }
  if (!videoId) throw new Error('链接中缺少视频 ID');
  const normalized = normalizeVideoId(platform, videoId);
  return {
    platform,
    videoId: normalized,
    canonicalKey: canonicalVideoKey(platform, normalized),
    canonicalUrl: canonicalVideoUrl(platform, normalized),
  };
}

export function parsePlaylistUrl(url: string): ParsedPlaylistUrl {
  const originalUrl = normalizeUrlInput(url);
  const parsed = new URL(originalUrl);
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (host === 'youtu.be' || host.endsWith('youtube.com')) {
    const sourceId = parsed.searchParams.get('list')?.trim();
    if (!sourceId || !/^[a-zA-Z0-9_-]{6,}$/.test(sourceId)) {
      throw new Error('YouTube 链接中缺少有效的 list 参数');
    }
    return {
      platform: 'youtube',
      sourceType: 'playlist',
      sourceId,
      canonicalSourceUrl: `https://www.youtube.com/playlist?list=${encodeURIComponent(sourceId)}`,
      originalUrl,
    };
  }
  if (!host.endsWith('bilibili.com')) {
    throw new Error('目前支持 YouTube 播放列表与 B站合集/收藏夹');
  }

  const ownerId = host === 'space.bilibili.com' ? parsed.pathname.split('/')[1] : undefined;
  const fid = parsed.searchParams.get('fid');
  if (fid && /^\d+$/.test(fid)) {
    return {
      platform: 'bilibili',
      sourceType: 'favorites',
      sourceId: fid,
      canonicalSourceUrl: `https://space.bilibili.com/${
        ownerId && /^\d+$/.test(ownerId) ? ownerId : '0'
      }/favlist?fid=${fid}`,
      originalUrl,
      ownerId,
      bilibiliIdParam: 'fid',
    };
  }

  const mediaId = parsed.searchParams.get('media_id');
  if (mediaId && /^\d+$/.test(mediaId)) {
    const sourceType = /fav/i.test(parsed.pathname) ? 'favorites' : 'collection';
    return {
      platform: 'bilibili',
      sourceType,
      sourceId: mediaId,
      canonicalSourceUrl:
        sourceType === 'favorites'
          ? `https://www.bilibili.com/medialist/detail/ml${mediaId}`
          : `https://www.bilibili.com/medialist/play/${mediaId}`,
      originalUrl,
      ownerId,
      bilibiliIdParam: 'media_id',
    };
  }

  const sid =
    parsed.searchParams.get('sid') ??
    parsed.pathname.match(/\/medialist\/play\/(\d+)/)?.[1] ??
    null;
  if (sid && /^\d+$/.test(sid)) {
    return {
      platform: 'bilibili',
      sourceType: 'collection',
      sourceId: sid,
      canonicalSourceUrl: `https://www.bilibili.com/medialist/play/${sid}`,
      originalUrl,
      ownerId,
      bilibiliIdParam: 'sid',
    };
  }
  throw new Error('无法从 B站链接识别合集或收藏夹 ID');
}

async function obsidianRequester(request: PlaylistRequest): Promise<PlaylistResponse> {
  const { requestUrl } = await import('obsidian');
  const response = await requestUrl({
    url: request.url,
    method: request.method,
    headers: request.headers,
    body: request.body,
    contentType: request.contentType,
    throw: false,
  });
  return {
    status: response.status,
    text: response.text,
    json: response.json,
  };
}

function parseYouTubeBootstrap(html: string): YouTubeBootstrap {
  const initialData = extractAssignedJson(html, ['ytInitialData', '"ytInitialData"']);
  if (!initialData) throw new Error('YouTube 页面没有可识别的公开播放列表数据');
  const apiKey = captureJsonString(html, 'INNERTUBE_API_KEY');
  const context = extractJsonAfterKey(html, 'INNERTUBE_CONTEXT');
  const clientVersion =
    stringField(recordField(context, 'client'), 'clientVersion') ||
    captureJsonString(html, 'INNERTUBE_CLIENT_VERSION');
  return { initialData, apiKey, context, clientVersion: clientVersion || undefined };
}

function appendYouTubeItems(
  root: unknown,
  output: PlaylistItem[],
  seen: Set<string>,
  maxItems: number,
): void {
  for (const renderer of findAllRecordsAtKey(root, 'playlistVideoRenderer')) {
    if (output.length >= maxItems) return;
    const videoId = stringField(renderer, 'videoId');
    if (!videoId) continue;
    const key = canonicalVideoKey('youtube', videoId);
    if (seen.has(key)) continue;
    seen.add(key);
    const url = canonicalVideoUrl('youtube', videoId);
    output.push({
      platform: 'youtube',
      videoId,
      canonicalKey: key,
      canonicalUrl: url,
      url,
      title: textFromRenderer(recordField(renderer, 'title')) || `YouTube ${videoId}`,
      author:
        textFromRenderer(recordField(renderer, 'shortBylineText')) ||
        textFromRenderer(recordField(renderer, 'longBylineText')) ||
        '',
      duration: textFromRenderer(recordField(renderer, 'lengthText')) || undefined,
      position: output.length,
    });
  }
}

function appendBilibiliItems(
  records: unknown[],
  output: PlaylistItem[],
  seen: Set<string>,
  maxItems: number,
): void {
  for (const value of records) {
    if (output.length >= maxItems || !isRecord(value)) break;
    const bvid = stringField(value, 'bvid');
    if (!bvid || !PlaylistProcessor.isValidBvid(bvid)) continue;
    const key = canonicalVideoKey('bilibili', bvid);
    if (seen.has(key)) continue;
    seen.add(key);
    const owner = recordField(value, 'owner');
    const author = recordField(value, 'author');
    const seconds = numberField(value, 'duration');
    const url = canonicalVideoUrl('bilibili', bvid);
    output.push({
      platform: 'bilibili',
      videoId: bvid,
      bvid,
      canonicalKey: key,
      canonicalUrl: url,
      url,
      title: stringField(value, 'title') || `B站视频 ${bvid}`,
      author: stringField(owner, 'name') || stringField(author, 'name') || '',
      duration: typeof seconds === 'number' ? formatDuration(seconds) : undefined,
      position: output.length,
    });
  }
}

function normalizeVideoId(platform: PlaylistPlatform, videoId: string): string {
  const value = videoId.trim();
  if (platform === 'youtube') {
    if (!/^[a-zA-Z0-9_-]{6,}$/.test(value)) throw new Error('无效的 YouTube 视频 ID');
    return value;
  }
  const normalized = value.startsWith('bv') ? `BV${value.slice(2)}` : value;
  if (!PlaylistProcessor.isValidBvid(normalized)) throw new Error('无效的 B站 BV 号');
  return normalized;
}

function normalizeUrlInput(url: string): string {
  const value = url.trim();
  if (!value) throw new Error('链接不能为空');
  try {
    return new URL(value).toString();
  } catch {
    throw new Error('链接格式无效');
  }
}

function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${minutes}:${String(secs).padStart(2, '0')}`;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(value ?? fallback)));
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} 返回了无效 JSON`);
  }
}

function assertBilibiliSuccess(value: unknown, action: string): void {
  if (!isRecord(value)) throw new Error(`${action}返回格式无效`);
  const code = numberField(value, 'code');
  if (code !== 0) {
    throw new Error(`${action}失败: ${stringField(value, 'message') || `code ${String(code)}`}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function recordField(value: unknown, key: string): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const result = value[key];
  return isRecord(result) ? result : {};
}

function arrayField(value: unknown, key: string): unknown[] {
  if (!isRecord(value)) return [];
  const result = value[key];
  return Array.isArray(result) ? result : [];
}

function stringField(value: unknown, key: string): string {
  if (!isRecord(value)) return '';
  const result = value[key];
  return typeof result === 'string' ? result.trim() : '';
}

function numberField(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const result = value[key];
  return typeof result === 'number' && Number.isFinite(result) ? result : undefined;
}

function booleanField(value: unknown, key: string): boolean | undefined {
  if (!isRecord(value)) return undefined;
  const result = value[key];
  return typeof result === 'boolean' ? result : undefined;
}

function textFromRenderer(value: unknown): string {
  if (!isRecord(value)) return '';
  const simpleText = stringField(value, 'simpleText');
  if (simpleText) return simpleText;
  const runs = arrayField(value, 'runs');
  return runs
    .map((run) => (isRecord(run) ? stringField(run, 'text') : ''))
    .filter(Boolean)
    .join('')
    .trim();
}

function findFirstRecordAtKey(root: unknown, key: string): Record<string, unknown> {
  return findAllRecordsAtKey(root, key)[0] ?? {};
}

function findAllRecordsAtKey(root: unknown, key: string): Record<string, unknown>[] {
  const results: Record<string, unknown>[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isRecord(value)) return;
    const candidate = value[key];
    if (isRecord(candidate)) results.push(candidate);
    for (const child of Object.values(value)) visit(child);
  };
  visit(root);
  return results;
}

function firstStringAtKey(
  root: unknown,
  key: string,
  parentPredicate?: (parent: Record<string, unknown>) => boolean,
): string | undefined {
  let found: string | undefined;
  const visit = (value: unknown, parent?: Record<string, unknown>): void => {
    if (found) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, parent);
      return;
    }
    if (!isRecord(value)) return;
    const candidate = value[key];
    if (
      typeof candidate === 'string' &&
      (!parentPredicate || (parent ? parentPredicate(parent) : parentPredicate(value)))
    ) {
      found = candidate;
      return;
    }
    for (const child of Object.values(value)) visit(child, value);
  };
  visit(root);
  return found;
}

function extractAssignedJson(html: string, names: string[]): unknown {
  for (const name of names) {
    const index = html.indexOf(name);
    if (index < 0) continue;
    const start = html.indexOf('{', index + name.length);
    if (start < 0) continue;
    const text = balancedJsonObject(html, start);
    if (text) return parseJson(text, name);
  }
  return undefined;
}

function extractJsonAfterKey(html: string, key: string): unknown {
  const marker = `"${key}"`;
  const index = html.indexOf(marker);
  if (index < 0) return undefined;
  const start = html.indexOf('{', index + marker.length);
  if (start < 0) return undefined;
  const text = balancedJsonObject(html, start);
  return text ? parseJson(text, key) : undefined;
}

function captureJsonString(html: string, key: string): string | undefined {
  const pattern = new RegExp(
    `"${key.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}"\\s*:\\s*"([^"]+)"`,
  );
  return html.match(pattern)?.[1];
}

function balancedJsonObject(text: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return undefined;
}
