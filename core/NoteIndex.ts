import { App, requestUrl, TAbstractFile, TFile } from 'obsidian';
import { VideoUtils } from '../utils/VideoUtils';
import { safeInlineRasterDataUrl, safeRemoteImageUrl } from '../utils/SafeExternalUrl';

import type { JsonRecord } from '../utils/json';
import { tr } from '../utils/i18n';
export interface VideoNoteEntry {
  path: string;
  basename: string;
  /** 归一化后的状态：pending / running / success / error */
  status: string;
  /** 是否已有真实摘要/转录产物；用于识别重启后残留的 running。 */
  hasGeneratedOutput?: boolean;
  link?: string;
  platform?: string;
  title?: string;
  /** 封面图（frontmatter cover / image / thumbnail），缺失时界面用占位斜纹 */
  cover?: string;
  /** 视频时长文本，例如 42:17 */
  duration?: string;
  /** 机器可读 sidecar id；存在时可在插件内重新打开同步陪读器。 */
  artifactId?: string;
  ctime: number;
  mtime: number;
}

const BODY_SCAN_CHUNK = 60;
const REMOTE_COVER_CONCURRENCY = 2;
const REMOTE_COVER_TIMEOUT_MS = 8000;
const REMOTE_COVER_RETRY_MS = 30 * 60 * 1000;
const PLATFORM_COVER_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PLATFORM_COVER_CACHE_LIMIT = 500;
const PLATFORM_COVER_CACHE_KEY = 'video-summary-platform-cover-cache-v1';

interface RemoteCoverTask {
  key: string;
  link: string;
}

interface PlatformCoverCacheItem {
  url: string;
  updatedAt: number;
}

/**
 * 视频笔记索引。
 *
 * 旧视图每次渲染都 getMarkdownFiles() 全量遍历，frontmatter 认不出来就 vault.read() 读正文，
 * 库一大就明显卡。这里改成：启动时先用 metadataCache 做一次快速 frontmatter 扫描立即可用，
 * 正文兜底扫描分片放到空闲时做，之后靠 vault / metadataCache 事件增量维护。
 */
export class NoteIndex {
  private app: App;
  private entries = new Map<string, VideoNoteEntry>();
  private listeners = new Set<() => void>();
  private bodyScanQueue: TFile[] = [];
  private bodyScanTimer: number | null = null;
  private bodyScanDone = false;
  /** 平台封面单独缓存，不改写用户笔记。 */
  private platformCoverCache = new Map<string, PlatformCoverCacheItem>();
  private platformCoverRetryAfter = new Map<string, number>();
  private platformCoverQueue: RemoteCoverTask[] = [];
  private activeCoverRequests = 0;
  private coverEmitTimer: number | null = null;

  constructor(app: App) {
    this.app = app;
    this.loadPlatformCoverCache();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit() {
    this.listeners.forEach((listener) => {
      try {
        listener();
      } catch (error) {
        console.error('[NoteIndex] listener failed', error);
      }
    });
  }

  /** 正文兜底扫描是否还在跑（界面据此显示"仍在建索引"） */
  isScanning(): boolean {
    return !this.bodyScanDone;
  }

  getAll(): VideoNoteEntry[] {
    return Array.from(this.entries.values());
  }

  get(path: string): VideoNoteEntry | undefined {
    return this.entries.get(path);
  }

  /**
   * 为当前真正显示到屏幕附近的条目补平台封面。
   * YouTube 在建索引时即可由视频 ID 推导；B站需要一次轻量元数据请求，因此走限流队列。
   */
  ensureCover(path: string): void {
    const entry = this.entries.get(path);
    if (!entry || entry.cover || !entry.link) return;

    const immediate = this.coverForUrl(entry.link);
    if (immediate) {
      entry.cover = immediate;
      this.emit();
      return;
    }
    this.ensureCoverForUrl(entry.link);
  }

  /** 供任务卡/历史详情读取已推导或已缓存的平台封面。 */
  coverForUrl(link?: string): string | undefined {
    if (!link) return undefined;
    const key = remoteCoverKey(link);
    return derivePlatformCover(link) ?? (key ? this.platformCoverCache.get(key)?.url : undefined);
  }

  /** 任务卡没有对应笔记路径时，也可按同一套规则触发 B站封面读取。 */
  ensureCoverForUrl(link?: string): void {
    if (!link || derivePlatformCover(link)) return;
    const key = remoteCoverKey(link);
    if (!key) return;
    const cached = this.platformCoverCache.get(key)?.url;
    if (cached) return;
    const retryAfter = this.platformCoverRetryAfter.get(key) ?? 0;
    if (retryAfter > Date.now()) return;

    this.platformCoverRetryAfter.set(key, Date.now() + REMOTE_COVER_RETRY_MS);
    this.platformCoverQueue.push({ key, link });
    this.pumpCoverQueue();
  }

  build() {
    this.entries.clear();
    this.bodyScanQueue = [];
    this.bodyScanDone = false;

    const files = this.app.vault.getMarkdownFiles();
    for (const file of files) {
      if (isIgnoredPath(file.path)) continue;
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (VideoUtils.isExplicitlyNonVideoFromFrontmatter(frontmatter)) continue;
      if (VideoUtils.isVideoNoteFromFrontmatter(frontmatter)) {
        this.entries.set(file.path, this.entryFromFrontmatter(file, frontmatter));
      } else {
        // frontmatter 认不出来的留给正文兜底扫描，避免启动时同步读全库
        this.bodyScanQueue.push(file);
      }
    }
    this.emit();
    this.scheduleBodyScan();
  }

  private scheduleBodyScan() {
    if (this.bodyScanTimer !== null) return;
    if (this.bodyScanQueue.length === 0) {
      this.bodyScanDone = true;
      this.emit();
      return;
    }
    this.bodyScanTimer = window.setTimeout(() => {
      this.bodyScanTimer = null;
      void this.runBodyScanChunk();
    }, 50);
  }

  private async runBodyScanChunk() {
    const chunk = this.bodyScanQueue.splice(0, BODY_SCAN_CHUNK);
    let changed = false;
    for (const file of chunk) {
      if (this.entries.has(file.path)) continue;
      try {
        const content = await this.app.vault.cachedRead(file);
        const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
        if (this.isLegacyVideoNote(file, content, frontmatter)) {
          this.entries.set(file.path, this.entryFromContent(file, content));
          changed = true;
        }
      } catch (error) {
        console.error(`[NoteIndex] 读取失败: ${file.path}`, error);
      }
    }
    if (changed) this.emit();
    this.scheduleBodyScan();
  }

  /** metadataCache 变化后刷新单个文件 */
  async refreshFile(file: TFile) {
    if (isIgnoredPath(file.path)) {
      if (this.entries.delete(file.path)) this.emit();
      return;
    }
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (VideoUtils.isExplicitlyNonVideoFromFrontmatter(frontmatter)) {
      if (this.entries.delete(file.path)) this.emit();
      return;
    }
    if (VideoUtils.isVideoNoteFromFrontmatter(frontmatter)) {
      this.entries.set(file.path, this.entryFromFrontmatter(file, frontmatter));
      this.emit();
      return;
    }
    try {
      const content = await this.app.vault.cachedRead(file);
      if (this.isLegacyVideoNote(file, content, frontmatter)) {
        this.entries.set(file.path, this.entryFromContent(file, content));
      } else if (this.entries.delete(file.path)) {
        // 笔记不再是视频笔记，移出索引
      }
    } catch {
      this.entries.delete(file.path);
    }
    this.emit();
  }

  /**
   * 旧笔记仍允许靠正文中的单个视频链接进入索引，但 README / MOC / 索引页以及
   * 含多个不同视频的聚合页不再混入。已有视频 frontmatter/插件标记者走上面的快速路径。
   */
  private isLegacyVideoNote(file: TFile, content: string, frontmatter?: JsonRecord): boolean {
    if (!VideoUtils.isVideoNote(content)) return false;
    if (isIndexLikeFile(file)) return false;

    const videoUrls = VideoUtils.extractVideoUrls(content);
    if (videoUrls.length > 1) return false;
    if (
      videoUrls.length === 1 &&
      detectPlatform(videoUrls[0]) === 'xiaohongshu' &&
      !VideoUtils.hasDirectVideoEvidence(content)
    ) {
      return false;
    }
    return (
      VideoUtils.hasDirectVideoEvidence(content) ||
      VideoUtils.hasLegacyMediaInputFromFrontmatter(frontmatter) ||
      isVideoCentricFile(file)
    );
  }

  handleDelete(file: TAbstractFile) {
    if (this.entries.delete(file.path)) this.emit();
  }

  handleRename(file: TAbstractFile, oldPath: string) {
    const existing = this.entries.get(oldPath);
    this.entries.delete(oldPath);
    if (existing && file instanceof TFile) {
      this.entries.set(file.path, {
        ...existing,
        path: file.path,
        basename: file.basename,
        mtime: file.stat.mtime,
      });
    }
    this.emit();
  }

  private entryFromFrontmatter(file: TFile, frontmatter: JsonRecord | undefined): VideoNoteEntry {
    const rawStatus = VideoUtils.getProcessingStatusFromFrontmatter(frontmatter) || 'pending';
    const link = this.readLink(frontmatter);
    const cover = this.resolveCover(frontmatter, file) ?? this.coverForUrl(link);
    return {
      path: file.path,
      basename: file.basename,
      status: normalizeEntryStatus(rawStatus),
      hasGeneratedOutput: VideoUtils.hasGeneratedOutputFromFrontmatter(frontmatter),
      link,
      platform: link ? detectPlatform(link) : undefined,
      title: typeof frontmatter?.video_title === 'string' ? frontmatter.video_title : undefined,
      cover,
      duration: readString(frontmatter?.video_duration),
      artifactId: readString(frontmatter?.video_artifact_id),
      ctime: file.stat.ctime,
      mtime: file.stat.mtime,
    };
  }

  private entryFromContent(file: TFile, content: string): VideoNoteEntry {
    const rawStatus = VideoUtils.getProcessingStatus(content) || 'pending';
    const link = VideoUtils.extractVideoUrl(content) || undefined;
    const cover =
      this.resolveCover({ cover: readCoverFromContent(content) }, file) ?? this.coverForUrl(link);
    return {
      path: file.path,
      basename: file.basename,
      status: normalizeEntryStatus(rawStatus),
      hasGeneratedOutput: VideoUtils.hasGeneratedOutput(content),
      link,
      platform: link ? detectPlatform(link) : undefined,
      cover,
      artifactId: readFrontmatterScalar(content, 'video_artifact_id'),
      ctime: file.stat.ctime,
      mtime: file.stat.mtime,
    };
  }

  /** 封面：受信平台外链或安全 raster data URL；库内图片转成 app:// 资源地址。 */
  private resolveCover(frontmatter: JsonRecord | undefined, file: TFile): string | undefined {
    const raw = readCover(frontmatter);
    if (!raw) return undefined;
    const remote = normalizeRemoteCoverUrl(raw);
    if (remote) return remote;
    const inlineRaster = safeInlineRasterDataUrl(raw);
    if (inlineRaster) return inlineRaster;

    const linkpath = raw
      .replace(/^!?\[\[/, '')
      .replace(/\]\]$/, '')
      .split('|')[0]
      .trim();
    if (!linkpath) return undefined;
    const target = this.app.metadataCache.getFirstLinkpathDest(linkpath, file.path);
    if (!target) return undefined;
    try {
      return this.app.vault.getResourcePath(target);
    } catch {
      return undefined;
    }
  }

  private readLink(frontmatter: JsonRecord | undefined): string | undefined {
    const fields = ['link', 'video_url', 'audio_source', 'source_url', 'url'];
    for (const field of fields) {
      const raw = frontmatter?.[field];
      const candidates = Array.isArray(raw) ? raw : [raw];
      for (const candidate of candidates) {
        if (typeof candidate !== 'string') continue;
        const value = candidate.trim();
        if (value && VideoUtils.isValidVideoUrl(value)) return value;
      }
    }
    return undefined;
  }

  private pumpCoverQueue(): void {
    while (
      this.activeCoverRequests < REMOTE_COVER_CONCURRENCY &&
      this.platformCoverQueue.length > 0
    ) {
      const task = this.platformCoverQueue.shift();
      if (!task) return;
      this.activeCoverRequests += 1;
      void this.loadRemoteCover(task);
    }
  }

  private async loadRemoteCover(task: RemoteCoverTask): Promise<void> {
    try {
      const cover = await fetchBilibiliCover(task.link);
      if (!cover) return;

      this.platformCoverCache.set(task.key, { url: cover, updatedAt: Date.now() });
      this.platformCoverRetryAfter.delete(task.key);
      this.persistPlatformCoverCache();
      let changed = false;
      for (const entry of this.entries.values()) {
        if (!entry.cover && entry.link && remoteCoverKey(entry.link) === task.key) {
          entry.cover = cover;
          changed = true;
        }
      }
      if (changed || this.listeners.size > 0) this.scheduleCoverEmit();
    } catch (error) {
      // 封面只是增强信息：平台限流或视频失效时安静退回本地占位，不影响笔记索引。
      console.debug('[NoteIndex] 平台封面读取失败', error);
    } finally {
      this.activeCoverRequests -= 1;
      this.pumpCoverQueue();
    }
  }

  /** 合并同一批返回的封面，避免两张图同时到达时连续重画整个面板。 */
  private scheduleCoverEmit(): void {
    if (this.coverEmitTimer !== null) return;
    this.coverEmitTimer = window.setTimeout(() => {
      this.coverEmitTimer = null;
      this.emit();
    }, 80);
  }

  private loadPlatformCoverCache(): void {
    try {
      const items = this.app.loadLocalStorage(PLATFORM_COVER_CACHE_KEY) as unknown;
      if (!Array.isArray(items)) return;
      const cutoff = Date.now() - PLATFORM_COVER_CACHE_TTL_MS;
      for (const row of items.slice(0, PLATFORM_COVER_CACHE_LIMIT)) {
        if (!Array.isArray(row) || row.length < 2) continue;
        const [key, item] = row as [unknown, Partial<PlatformCoverCacheItem>];
        if (
          typeof key !== 'string' ||
          !key.startsWith('bilibili:') ||
          typeof item?.url !== 'string' ||
          typeof item?.updatedAt !== 'number' ||
          item.updatedAt < cutoff
        ) {
          continue;
        }
        const url = normalizeBilibiliCoverUrl(item.url);
        if (url) this.platformCoverCache.set(key, { url, updatedAt: item.updatedAt });
      }
    } catch {
      // 缓存损坏时忽略；下一次成功读取会覆盖它。
    }
  }

  private persistPlatformCoverCache(): void {
    try {
      const items = Array.from(this.platformCoverCache.entries())
        .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
        .slice(0, PLATFORM_COVER_CACHE_LIMIT);
      this.app.saveLocalStorage(PLATFORM_COVER_CACHE_KEY, items);
    } catch {
      // localStorage 不可用时退化为会话缓存，不影响封面显示。
    }
  }
}

function readString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function readFrontmatterScalar(content: string, key: string): string | undefined {
  const frontmatter = content.match(/^---\s*\n([\s\S]*?)\n---(?:\n|$)/)?.[1];
  if (!frontmatter) return undefined;
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = frontmatter.match(new RegExp(`^${escapedKey}:\\s*(.+?)\\s*$`, 'm'));
  if (!match) return undefined;
  return match[1].replace(/^['"]|['"]$/g, '').trim() || undefined;
}

function normalizeEntryStatus(status: string): string {
  const normalized = VideoUtils.normalizeStatus(status);
  return normalized === 'other' ? 'pending' : normalized;
}

function isIndexLikeFile(file: TFile): boolean {
  const name = file.basename.trim().toLowerCase();
  if (/^(?:readme|index|moc|map of contents?|目录|索引|导航)$/.test(name)) return true;
  return /(?:^|[\s_.-])(?:readme|index|moc|目录|索引|导航)(?:$|[\s_.-])/.test(name);
}

function isIgnoredPath(path: string): boolean {
  return /(?:^|\/)(?:node_modules|vendor)(?:\/|$)/i.test(path);
}

function isVideoCentricFile(file: TFile): boolean {
  return /video|youtube|b站|视频|影片|录像|录屏|时间轴/i.test(file.basename);
}

/** 封面允许几种常见字段名，外链和库内图片都收，解析在 NoteIndex.resolveCover */
function readCover(frontmatter: JsonRecord | undefined): string | undefined {
  return (
    readString(frontmatter?.video_cover) ??
    readString(frontmatter?.thumbnail_url) ??
    readString(frontmatter?.thumbnailUrl) ??
    readString(frontmatter?.thumbnail) ??
    readString(frontmatter?.cover) ??
    readString(frontmatter?.image)
  );
}

function readCoverFromContent(content: string): string | undefined {
  const wikiEmbed = content.match(/!\[\[([^\]|]+\.(?:png|jpe?g|webp|gif|avif))(?:\|[^\]]*)?\]\]/i);
  if (wikiEmbed?.[1]) return wikiEmbed[1].trim();

  const markdownImage = content.match(
    /!\[[^\]]*\]\((https?:\/\/[^)\s]+|[^)\s]+\.(?:png|jpe?g|webp|gif|avif))\)/i,
  );
  return markdownImage?.[1]?.trim();
}

/** 无需 API key 的 YouTube 封面；链接无明确视频 ID 时不猜测。 */
export function derivePlatformCover(url: string): string | undefined {
  const youtubeId = extractYouTubeVideoId(url);
  return youtubeId ? `https://i.ytimg.com/vi/${youtubeId}/mqdefault.jpg` : undefined;
}

/** 只有明确指向单个 B站视频的链接才允许进入远程封面队列。 */
export function canLoadRemoteCover(url?: string): boolean {
  return !!url && remoteCoverKey(url) !== undefined;
}

function extractYouTubeVideoId(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    const hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    let candidate: string | null = null;
    if (hostname === 'youtu.be') {
      candidate = url.pathname.split('/').filter(Boolean)[0] ?? null;
    } else if (hostname === 'youtube.com' || hostname === 'm.youtube.com') {
      candidate = url.searchParams.get('v');
      if (!candidate) {
        const parts = url.pathname.split('/').filter(Boolean);
        if (['embed', 'shorts', 'live'].includes(parts[0])) candidate = parts[1] ?? null;
      }
    }
    return candidate && /^[A-Za-z0-9_-]{11}$/.test(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function extractBilibiliVideoId(value: string): { type: 'bvid' | 'aid'; id: string } | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    const hostname = url.hostname.toLowerCase();
    if (hostname !== 'bilibili.com' && !hostname.endsWith('.bilibili.com')) return undefined;

    const queryBvid = url.searchParams.get('bvid');
    if (queryBvid && /^BV[0-9A-Za-z]{10}$/i.test(queryBvid)) {
      return { type: 'bvid', id: `BV${queryBvid.slice(2)}` };
    }

    const pathId = url.pathname.match(/\/video\/(BV[0-9A-Za-z]{10}|av\d+)(?:$|\/)/i)?.[1];
    if (!pathId) return undefined;
    if (/^BV/i.test(pathId)) return { type: 'bvid', id: `BV${pathId.slice(2)}` };
    return { type: 'aid', id: pathId.slice(2) };
  } catch {
    return undefined;
  }
}

function remoteCoverKey(value: string): string | undefined {
  if (detectPlatform(value) !== 'bilibili') return undefined;
  const id = extractBilibiliVideoId(value);
  return id ? `bilibili:${id.type}:${id.id}` : undefined;
}

async function fetchBilibiliCover(value: string): Promise<string | undefined> {
  const id = extractBilibiliVideoId(value);
  if (!id) return undefined;

  const query = id.type === 'bvid' ? `bvid=${encodeURIComponent(id.id)}` : `aid=${id.id}`;
  const response = await withTimeout(
    requestUrl({
      url: `https://api.bilibili.com/x/web-interface/view?${query}`,
      headers: {
        Accept: 'application/json',
        Referer: 'https://www.bilibili.com/',
      },
      throw: false,
    }),
    REMOTE_COVER_TIMEOUT_MS,
  );
  if (response.status < 200 || response.status >= 300) return undefined;
  const payload = response.json as { code?: number; data?: { pic?: unknown } } | undefined;
  if (payload?.code !== 0 || typeof payload.data?.pic !== 'string') return undefined;
  return normalizeBilibiliCoverUrl(payload.data.pic);
}

export function normalizeRemoteCoverUrl(value: string): string | undefined {
  const normalized = value
    .trim()
    .replace(/^\/\//, 'https://')
    .replace(/^http:\/\//i, 'https://');
  return safeRemoteImageUrl(normalized);
}

function normalizeBilibiliCoverUrl(value: string): string | undefined {
  const normalized = normalizeRemoteCoverUrl(value.trim().replace(/^http:\/\//, 'https://'));
  if (!normalized) return undefined;
  const hostname = new URL(normalized).hostname.toLowerCase();
  if (
    hostname === 'hdslb.com' ||
    hostname.endsWith('.hdslb.com') ||
    hostname === 'biliimg.com' ||
    hostname.endsWith('.biliimg.com')
  ) {
    return normalized;
  }
  return undefined;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('平台封面请求超时')), timeoutMs);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        window.clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export function detectPlatform(url: string): string {
  const value = url.toLowerCase();
  if (value.includes('bilibili.com') || value.includes('b23.tv')) return 'bilibili';
  if (value.includes('youtube.com') || value.includes('youtu.be')) return 'youtube';
  if (value.includes('douyin.com')) return 'douyin';
  if (value.includes('tiktok.com')) return 'tiktok';
  if (value.includes('xiaohongshu.com') || value.includes('xhslink')) return 'xiaohongshu';
  return 'other';
}

export function platformLabel(platform?: string): string {
  switch (platform) {
    case 'bilibili':
      return tr('B站', 'Bilibili');
    case 'youtube':
      return 'YouTube';
    case 'douyin':
      return tr('抖音', 'Douyin');
    case 'tiktok':
      return 'TikTok';
    case 'xiaohongshu':
      return tr('小红书', 'Xiaohongshu');
    default:
      return tr('链接', 'Link');
  }
}
