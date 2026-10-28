import { MarkdownView, Notice, TFile, setIcon } from 'obsidian';
import { Job } from '../../core/JobStore';
import { buildTimestampUrl, formatTimestamp } from '../../core/KnowledgeModel';
import { formatTranscriptQuote } from '../../core/TranscriptQuote';
import { UserHighlight, VideoSegment } from '../../types';
import {
  isExactHostOrSubdomain,
  safeExternalHttpUrl,
  safeVaultRelativeMediaPath,
} from '../../utils/SafeExternalUrl';
import { ViewContext } from '../context';
import { showMenu } from '../ui';

interface PlayerController {
  seek(seconds: number): void;
  onTimeChange(listener: (seconds: number) => void): () => void;
  destroy(): void;
}

const PAGE_SIZE = 240;

export function renderReaderPanel(container: HTMLElement, ctx: ViewContext, job: Job) {
  const segments = job.result?.video_segments || [];
  const sourceUrl = job.input.url || job.result?.artifact?.source_url || '';
  const reader = container.createDiv({ cls: 'vs-reader' });
  const playerHost = reader.createDiv({ cls: 'vs-reader-player' });
  const player = createPlayer(playerHost, ctx, job, sourceUrl);
  ctx.registerPanelCleanup(() => player.destroy());
  const initialSeek = ctx.state.readerSeekSeconds;
  if (typeof initialSeek === 'number' && Number.isFinite(initialSeek)) {
    ctx.state.readerSeekSeconds = undefined;
    window.setTimeout(() => player.seek(initialSeek), 0);
  }

  const toolbar = reader.createDiv({ cls: 'vs-reader-toolbar' });
  const search = toolbar.createEl('input', {
    cls: 'vs-reader-search',
    attr: { type: 'search', placeholder: '搜索文稿…', 'aria-label': '搜索文稿' },
  });
  const count = toolbar.createSpan({
    text: `${segments.length.toLocaleString()} 段`,
    cls: 'vs-reader-count',
  });
  void count;

  if (segments.length === 0) {
    reader.createDiv({
      text: '当前结果没有结构化时间轴。重新处理时选择“证据模式”即可生成。',
      cls: 'vs-hint',
    });
    return;
  }

  const list = reader.createDiv({ cls: 'vs-reader-transcript' });
  const footer = reader.createDiv({ cls: 'vs-reader-footer' });
  const highlights = new Set<string>();
  let visibleCount = Math.min(PAGE_SIZE, segments.length);
  let activeId = '';
  let query = '';

  const renderRows = () => {
    list.empty();
    footer.empty();
    const matching = query
      ? segments.filter((segment) =>
          `${segment.speaker || ''} ${segment.text} ${segment.visual_text || ''}`
            .toLocaleLowerCase()
            .includes(query),
        )
      : segments;
    const visible = matching.slice(0, query ? 400 : visibleCount);
    visible.forEach((segment) => {
      const row = list.createEl('button', {
        cls: `vs-reader-segment${segment.id === activeId ? ' is-active' : ''}${
          highlights.has(segment.id) ? ' is-highlighted' : ''
        }`,
        attr: {
          type: 'button',
          'data-segment-id': segment.id,
          draggable: 'true',
          title: '点击跳到这里 · 右键复制引用 · 拖进笔记插入引用',
        },
      });
      const time = row.createSpan({
        text: formatTimestamp(segment.start),
        cls: 'vs-reader-time',
      });
      if (segment.start === null || segment.timing_quality === 'none') {
        time.addClass('is-untimed');
      }
      const content = row.createSpan({ cls: 'vs-reader-copy' });
      if (segment.speaker) {
        content.createSpan({ text: segment.speaker, cls: 'vs-reader-speaker' });
      }
      content.createSpan({ text: segment.text, cls: 'vs-reader-text' });
      if (segment.visual_text) {
        content.createSpan({
          text: `屏幕：${segment.visual_text}`,
          cls: 'vs-reader-visual-text',
        });
      }
      const highlighted = highlights.has(segment.id);
      const highlightLabel = highlighted ? '取消重点' : '标记重点';
      const star = row.createSpan({
        cls: 'vs-reader-highlight',
        attr: {
          title: highlightLabel,
          role: 'button',
          tabindex: '0',
          'aria-label': highlightLabel,
          'aria-pressed': String(highlighted),
        },
      });
      setIcon(star, highlighted ? 'star' : 'star-off');
      const activateHighlight = (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
        void toggleHighlight(ctx, job, segment, highlights).then(renderRows);
      };
      star.addEventListener('click', activateHighlight);
      star.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') activateHighlight(event);
      });
      row.addEventListener('dragstart', (event) => {
        event.dataTransfer?.setData('text/plain', quoteFor(ctx, job, sourceUrl, segment));
      });
      row.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        const quote = quoteFor(ctx, job, sourceUrl, segment);
        showMenu(event, [
          {
            title: '复制引用',
            icon: 'quote',
            onClick: () => {
              void navigator.clipboard.writeText(quote).then(() => new Notice('已复制引用'));
            },
          },
          {
            title: '插入到笔记',
            icon: 'text-cursor-input',
            onClick: () => insertIntoRecentNote(ctx, quote),
          },
          {
            title: highlightLabel,
            icon: highlighted ? 'star-off' : 'star',
            onClick: () => void toggleHighlight(ctx, job, segment, highlights).then(renderRows),
          },
        ]);
      });
      row.addEventListener('click', () => {
        if (segment.start === null || segment.timing_quality === 'none') {
          new Notice('这段文稿没有可靠时间点');
          return;
        }
        activeId = segment.id;
        player.seek(segment.start);
        markActiveRow(list, activeId);
      });
    });

    if (!query && visibleCount < matching.length) {
      const more = footer.createEl('button', {
        text: `继续加载 ${Math.min(PAGE_SIZE, matching.length - visibleCount)} 段`,
        cls: 'vs-text-btn',
        attr: { type: 'button' },
      });
      more.addEventListener('click', () => {
        visibleCount = Math.min(visibleCount + PAGE_SIZE, matching.length);
        renderRows();
      });
    }
    if (query && matching.length > visible.length) {
      footer.createSpan({
        text: `显示前 ${visible.length} 条，共 ${matching.length} 条匹配`,
        cls: 'vs-hint',
      });
    }
  };

  const offTime = player.onTimeChange((seconds) => {
    const active = activeSegmentAt(segments, seconds);
    if (!active || active.id === activeId) return;
    activeId = active.id;
    markActiveRow(list, activeId, true);
  });
  ctx.registerPanelCleanup(offTime);

  let searchTimer = 0;
  search.addEventListener('input', () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      query = search.value.trim().toLocaleLowerCase();
      renderRows();
    }, 120);
  });
  ctx.registerPanelCleanup(() => window.clearTimeout(searchTimer));

  void loadHighlights(ctx, job).then((stored) => {
    stored.forEach((highlight) => highlights.add(highlight.segment_id));
    const segmentIds = new Set(segments.map((segment) => segment.id));
    const needsReview = stored.filter(
      (highlight) => highlight.needs_review || !segmentIds.has(highlight.segment_id),
    ).length;
    if (needsReview > 0) {
      toolbar.createSpan({
        text: `${needsReview} 个旧重点待重新定位`,
        cls: 'vs-hint is-warning',
      });
    }
    renderRows();
  });
  renderRows();
}

function quoteFor(ctx: ViewContext, job: Job, sourceUrl: string, segment: VideoSegment): string {
  const timed = segment.start !== null && segment.timing_quality !== 'none';
  return formatTranscriptQuote(ctx.plugin.settings.readerQuoteTemplate, {
    text: segment.text,
    start: timed ? segment.start : null,
    speaker: segment.speaker,
    sourceUrl,
    title: job.title,
    notePath: job.notePath,
  });
}

/** 插到主编辑区最近用过的那篇笔记的光标处；侧栏自己不是编辑器，所以不用 activeLeaf。 */
function insertIntoRecentNote(ctx: ViewContext, text: string) {
  const { workspace } = ctx.plugin.app;
  const view = workspace.getMostRecentLeaf(workspace.rootSplit)?.view;
  if (!(view instanceof MarkdownView)) {
    new Notice('先在主编辑区打开一篇笔记，再插入引用');
    return;
  }
  view.editor.replaceSelection(`${text}\n`);
  new Notice(`已插入到 ${view.file?.basename ?? '笔记'}`);
}

function createPlayer(
  container: HTMLElement,
  ctx: ViewContext,
  job: Job,
  sourceUrl: string,
): PlayerController {
  const localSource = resolveLocalSource(ctx, job.input.localFile);
  if (localSource) return createHtmlPlayer(container, localSource);

  const youtubeId = extractYouTubeId(sourceUrl);
  if (youtubeId) return createYouTubePlayer(container, youtubeId);

  const bilibiliId = extractBilibiliId(sourceUrl);
  if (bilibiliId) return createBilibiliPlayer(container, bilibiliId);

  const fallback = container.createDiv({ cls: 'vs-reader-player-fallback' });
  const icon = fallback.createDiv({ cls: 'vs-reader-player-icon' });
  setIcon(icon, 'external-link');
  fallback.createDiv({ text: '当前平台使用外部播放器', cls: 'vs-reader-player-title' });
  fallback.createDiv({
    text: '点击文稿时间点时会打开对应的视频位置。',
    cls: 'vs-hint',
  });
  let listener: ((seconds: number) => void) | null = null;
  return {
    seek(seconds) {
      const url = safeExternalHttpUrl(buildTimestampUrl(sourceUrl, seconds) || sourceUrl);
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
      listener?.(seconds);
    },
    onTimeChange(next) {
      listener = next;
      return () => {
        if (listener === next) listener = null;
      };
    },
    destroy() {
      listener = null;
    },
  };
}

function createHtmlPlayer(container: HTMLElement, source: string): PlayerController {
  const video = container.createEl('video', {
    cls: 'vs-reader-video',
    attr: { controls: 'true', preload: 'metadata', src: source },
  });
  const listeners = new Set<(seconds: number) => void>();
  const onTimeUpdate = () => listeners.forEach((listener) => listener(video.currentTime));
  video.addEventListener('timeupdate', onTimeUpdate);
  return {
    seek(seconds) {
      video.currentTime = seconds;
      void video.play().catch(() => undefined);
    },
    onTimeChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy() {
      video.removeEventListener('timeupdate', onTimeUpdate);
      listeners.clear();
      video.pause();
      video.removeAttribute('src');
      video.load();
    },
  };
}

function createYouTubePlayer(container: HTMLElement, videoId: string): PlayerController {
  const frameId = `vs-reader-${Date.now().toString(36)}`;
  const iframe = container.createEl('iframe', {
    cls: 'vs-reader-iframe',
    attr: {
      id: frameId,
      src: `https://www.youtube.com/embed/${encodeURIComponent(
        videoId,
      )}?enablejsapi=1&playsinline=1&rel=0`,
      title: 'YouTube 视频',
      allow: 'accelerometer; autoplay; encrypted-media; picture-in-picture',
      allowfullscreen: 'true',
    },
  });
  const listeners = new Set<(seconds: number) => void>();
  const onMessage = (event: MessageEvent) => {
    if (event.source !== iframe.contentWindow) return;
    let payload: any = event.data;
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload);
      } catch {
        return;
      }
    }
    const currentTime = Number(payload?.info?.currentTime);
    if (payload?.event === 'infoDelivery' && Number.isFinite(currentTime)) {
      listeners.forEach((listener) => listener(currentTime));
    }
  };
  window.addEventListener('message', onMessage);
  iframe.addEventListener('load', () => {
    iframe.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: frameId }), '*');
  });
  return {
    seek(seconds) {
      iframe.contentWindow?.postMessage(
        JSON.stringify({ event: 'command', func: 'seekTo', args: [seconds, true], id: frameId }),
        '*',
      );
      iframe.contentWindow?.postMessage(
        JSON.stringify({ event: 'command', func: 'playVideo', args: [], id: frameId }),
        '*',
      );
      listeners.forEach((listener) => listener(seconds));
    },
    onTimeChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy() {
      window.removeEventListener('message', onMessage);
      listeners.clear();
      iframe.src = 'about:blank';
    },
  };
}

function createBilibiliPlayer(container: HTMLElement, bvid: string): PlayerController {
  const iframe = container.createEl('iframe', {
    cls: 'vs-reader-iframe',
    attr: {
      title: 'Bilibili 视频',
      allow: 'autoplay; fullscreen',
      allowfullscreen: 'true',
    },
  });
  container.createDiv({
    text: 'B站嵌入播放器不提供稳定的播放时间事件：点击文稿可跳转，播放时暂不自动跟随。',
    cls: 'vs-hint is-warning',
  });
  const listeners = new Set<(seconds: number) => void>();
  const loadAt = (seconds: number) => {
    iframe.src = `https://player.bilibili.com/player.html?bvid=${encodeURIComponent(
      bvid,
    )}&page=1&high_quality=1&danmaku=0&t=${Math.max(0, Math.floor(seconds))}`;
  };
  loadAt(0);
  return {
    seek(seconds) {
      loadAt(seconds);
      listeners.forEach((listener) => listener(seconds));
    },
    onTimeChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy() {
      listeners.clear();
      iframe.src = 'about:blank';
    },
  };
}

function resolveLocalSource(ctx: ViewContext, localFile?: string): string {
  const vaultPath = safeVaultRelativeMediaPath(localFile);
  if (!vaultPath) return '';
  const direct = ctx.plugin.app.vault.getAbstractFileByPath(vaultPath);
  if (direct instanceof TFile) return ctx.plugin.app.vault.getResourcePath(direct);
  return '';
}

function extractYouTubeId(sourceUrl: string): string {
  try {
    const safeSource = safeExternalHttpUrl(sourceUrl);
    if (!safeSource) return '';
    const url = new URL(safeSource);
    if (url.hostname === 'youtu.be') return url.pathname.split('/').filter(Boolean)[0] || '';
    if (isExactHostOrSubdomain(url.hostname, 'youtube.com')) {
      if (url.pathname.startsWith('/shorts/')) {
        return url.pathname.split('/').filter(Boolean)[1] || '';
      }
      return url.searchParams.get('v') || '';
    }
  } catch {
    return '';
  }
  return '';
}

function extractBilibiliId(sourceUrl: string): string {
  try {
    const safeSource = safeExternalHttpUrl(sourceUrl);
    if (!safeSource) return '';
    const url = new URL(safeSource);
    if (!isExactHostOrSubdomain(url.hostname, 'bilibili.com')) return '';
    return url.pathname.match(/^\/video\/(BV[a-zA-Z0-9]{10})(?:\/|$)/)?.[1] || '';
  } catch {
    return '';
  }
}

function activeSegmentAt(segments: VideoSegment[], seconds: number): VideoSegment | undefined {
  let candidate: VideoSegment | undefined;
  for (const segment of segments) {
    if (segment.start === null || segment.start > seconds) break;
    candidate = segment;
    if (segment.end !== undefined && segment.end !== null && seconds < segment.end) break;
  }
  return candidate;
}

function markActiveRow(list: HTMLElement, activeId: string, scroll = false) {
  list.querySelectorAll<HTMLElement>('.vs-reader-segment.is-active').forEach((row) => {
    row.removeClass('is-active');
  });
  const row = list.querySelector<HTMLElement>(
    `.vs-reader-segment[data-segment-id="${cssEscape(activeId)}"]`,
  );
  if (!row) return;
  row.addClass('is-active');
  if (scroll) row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

async function loadHighlights(ctx: ViewContext, job: Job): Promise<UserHighlight[]> {
  const artifactId = job.result?.artifact?.artifact_id;
  const store = ctx.plugin.artifactStore;
  if (!artifactId || !store?.load) return [];
  try {
    const artifact = await store.load(artifactId);
    return Array.isArray(artifact?.highlights) ? artifact.highlights : [];
  } catch {
    return [];
  }
}

async function toggleHighlight(
  ctx: ViewContext,
  job: Job,
  segment: VideoSegment,
  highlights: Set<string>,
) {
  const removing = highlights.has(segment.id);
  if (removing) highlights.delete(segment.id);
  else highlights.add(segment.id);
  const artifactId = job.result?.artifact?.artifact_id;
  const store = ctx.plugin.artifactStore;
  if (!artifactId || !store?.updateHighlights) return;
  try {
    const updated = await store.updateHighlights(artifactId, (current) => {
      if (removing) return current.filter((item) => item.segment_id !== segment.id);
      if (current.some((item) => item.segment_id === segment.id)) return current;
      const added: UserHighlight = {
        id: `highlight-${segment.id}`,
        segment_id: segment.id,
        created_at: new Date().toISOString(),
      };
      return [...current, added];
    });
    highlights.clear();
    updated.highlights.forEach((item) => highlights.add(item.segment_id));
  } catch (error) {
    if (removing) highlights.add(segment.id);
    else highlights.delete(segment.id);
    new Notice(`保存重点失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}
