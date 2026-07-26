// agent: claude (2026-07-26)
import { App, TAbstractFile, TFile } from 'obsidian';
import { VideoUtils } from '../utils/VideoUtils';

export interface VideoNoteEntry {
  path: string;
  basename: string;
  /** 归一化后的状态：pending / running / success / error */
  status: string;
  link?: string;
  platform?: string;
  title?: string;
  /** 封面图（frontmatter cover / image / thumbnail），缺失时界面用占位斜纹 */
  cover?: string;
  /** 视频时长文本，例如 42:17 */
  duration?: string;
  ctime: number;
  mtime: number;
}

const BODY_SCAN_CHUNK = 60;

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

  constructor(app: App) {
    this.app = app;
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

  build() {
    this.entries.clear();
    this.bodyScanQueue = [];
    this.bodyScanDone = false;

    const files = this.app.vault.getMarkdownFiles();
    for (const file of files) {
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (isExplicitlyNonVideo(frontmatter)) continue;
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
        if (VideoUtils.isVideoNote(content)) {
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
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (isExplicitlyNonVideo(frontmatter)) {
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
      if (VideoUtils.isVideoNote(content)) {
        this.entries.set(file.path, this.entryFromContent(file, content));
      } else if (this.entries.delete(file.path)) {
        // 笔记不再是视频笔记，移出索引
      }
    } catch {
      this.entries.delete(file.path);
    }
    this.emit();
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

  private entryFromFrontmatter(file: TFile, frontmatter: any): VideoNoteEntry {
    const rawStatus = VideoUtils.getProcessingStatusFromFrontmatter(frontmatter) || 'pending';
    const link = this.readLink(frontmatter);
    return {
      path: file.path,
      basename: file.basename,
      status: VideoUtils.normalizeStatus(rawStatus) || 'pending',
      link,
      platform: link ? detectPlatform(link) : undefined,
      title: typeof frontmatter?.video_title === 'string' ? frontmatter.video_title : undefined,
      cover: this.resolveCover(frontmatter, file),
      duration: readString(frontmatter?.video_duration),
      ctime: file.stat.ctime,
      mtime: file.stat.mtime,
    };
  }

  private entryFromContent(file: TFile, content: string): VideoNoteEntry {
    const rawStatus = VideoUtils.getProcessingStatus(content) || 'pending';
    const link = VideoUtils.extractVideoUrl(content) || undefined;
    return {
      path: file.path,
      basename: file.basename,
      status: VideoUtils.normalizeStatus(rawStatus) || 'pending',
      link,
      platform: link ? detectPlatform(link) : undefined,
      ctime: file.stat.ctime,
      mtime: file.stat.mtime,
    };
  }

  /** 封面：外链直接用；库内图片（cover: xx.png 或 ![[xx.png]]）转成 app:// 资源地址 */
  private resolveCover(frontmatter: any, file: TFile): string | undefined {
    const raw = readCover(frontmatter);
    if (!raw) return undefined;
    if (/^https?:\/\//.test(raw)) return raw;

    const linkpath = raw.replace(/^!?\[\[/, '').replace(/\]\]$/, '').split('|')[0].trim();
    if (!linkpath) return undefined;
    const target = this.app.metadataCache.getFirstLinkpathDest(linkpath, file.path);
    if (!target) return undefined;
    try {
      return this.app.vault.getResourcePath(target);
    } catch {
      return undefined;
    }
  }

  private readLink(frontmatter: any): string | undefined {
    const raw = frontmatter?.link;
    if (typeof raw === 'string' && raw.trim()) return raw.trim();
    if (Array.isArray(raw) && typeof raw[0] === 'string') return raw[0].trim();
    return undefined;
  }
}

function readString(value: any): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/**
 * 其他采集器会在正文或 source_url 里保存小红书链接；那不等于它是视频笔记。
 * 只相信来源自己明确声明的非视频类型，未声明的旧笔记仍保留正文兜底扫描。
 */
function isExplicitlyNonVideo(frontmatter: any): boolean {
  if (!frontmatter || typeof frontmatter !== 'object') return false;

  const sourceType = readString(frontmatter.source_type)?.toLowerCase();
  if (
    sourceType &&
    ['image', 'images', 'article', 'text', 'note', 'document'].includes(sourceType)
  ) {
    return true;
  }

  const transcriptStatus = readString(frontmatter.video_transcript_status)?.toLowerCase();
  return transcriptStatus === 'not-applicable' || transcriptStatus === 'not_applicable';
}

/** 封面允许几种常见字段名，外链和库内图片都收，解析在 NoteIndex.resolveCover */
function readCover(frontmatter: any): string | undefined {
  return (
    readString(frontmatter?.cover) ??
    readString(frontmatter?.image) ??
    readString(frontmatter?.thumbnail) ??
    readString(frontmatter?.video_cover)
  );
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
      return 'B站';
    case 'youtube':
      return 'YouTube';
    case 'douyin':
      return '抖音';
    case 'tiktok':
      return 'TikTok';
    case 'xiaohongshu':
      return '小红书';
    default:
      return '链接';
  }
}
