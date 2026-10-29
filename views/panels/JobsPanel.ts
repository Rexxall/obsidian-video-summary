import { Notice, TFile } from 'obsidian';
import { ViewContext } from '../context';
import { Job } from '../../core/JobStore';
import { ProcessingHistory } from '../../types';
import {
  emptyState,
  formatClock,
  formatElapsed,
  formatRelative,
  iconButton,
  modeLabel,
  parseLocaleTime,
  platformText,
  showMenu,
  statusPill,
  textButton,
  thumbnail,
} from '../ui';
import { normalizeRemoteCoverUrl, platformLabel } from '../../core/NoteIndex';
import { openSettings } from './ActionBar';

import { fire } from '../../utils/fire';
import { errorMessage } from '../../utils/errors';
import type { WebhookHistoryEntry } from '../../types';
const RECENT_HISTORY_LIMIT = 3;
let historyExpanded = false;

/** 任务流：正在跑的、等确认的、最近跑完的，都在这一屏 */
export function renderJobsPanel(container: HTMLElement, ctx: ViewContext) {
  const jobs = ctx.plugin.jobs.getAll();
  const active = jobs.filter((job) => job.state === 'queued' || job.state === 'running');
  const review = jobs.filter((job) => job.state === 'review');
  const finished = jobs.filter(
    (job) => job.state === 'success' || job.state === 'error' || job.state === 'cancelled',
  );

  if (active.length + review.length > 0) {
    section(container, `进行中 ${active.length + review.length}`);
  }
  if (active.length > 0) {
    active.forEach((job) => renderActiveJob(container, ctx, job));
  }

  if (review.length > 0) {
    review.forEach((job) => renderReviewJob(container, ctx, job));
  }

  const historyRows = buildHistoryRows(ctx, finished);
  if (historyRows.length > 0) {
    const header = section(container, '最近完成');
    iconButton(header, 'history', '从 webhook 历史结果里取回', (event) => {
      showWebhookHistoryMenu(ctx, event);
    });
    iconButton(header, 'more-horizontal', '列表操作', (event) => {
      showMenu(event, [
        {
          title: '清掉已完成的任务卡',
          icon: 'eraser',
          onClick: () => {
            ctx.plugin.jobs.clearFinished();
            ctx.renderPanels();
          },
        },
        {
          title: '清空处理历史',
          icon: 'trash',
          onClick: async () => {
            await ctx.plugin.clearProcessingHistory();
            ctx.renderPanels();
          },
        },
        {
          title: '清空结果缓存',
          icon: 'database',
          onClick: async () => {
            try {
              ctx.plugin.api.clearCache();
              new Notice('缓存已清空');
            } catch (error) {
              new Notice(`清空缓存失败: ${error instanceof Error ? errorMessage(error) : error}`);
            }
          },
        },
      ]);
    });
    const visibleHistory = historyExpanded
      ? historyRows.slice(0, 60)
      : historyRows.slice(0, RECENT_HISTORY_LIMIT);
    // 任务列表单独成一组
    const group = container.createDiv({ cls: 'vs-history-group ap-group' });
    visibleHistory.forEach((row) => renderHistoryRow(group, ctx, row));

    if (historyRows.length > RECENT_HISTORY_LIMIT) {
      const more = container.createEl('button', {
        text: historyExpanded
          ? '收起最近完成'
          : `显示更多 · 还有 ${historyRows.length - RECENT_HISTORY_LIMIT} 条`,
        cls: 'vs-more-btn vs-history-more',
        attr: { type: 'button' },
      });
      more.addEventListener('click', () => {
        historyExpanded = !historyExpanded;
        ctx.renderPanels();
      });
    }
  }

  if (active.length === 0 && review.length === 0 && historyRows.length === 0) {
    emptyState(container, 'inbox', '还没有任务', '在上面贴一条链接，或者到笔记库里挑一篇处理');
  }
}

function section(container: HTMLElement, title: string): HTMLElement {
  const header = container.createDiv({ cls: 'vs-section-header' });
  header.createSpan({ text: title, cls: 'vs-section-title' });
  return header.createDiv({ cls: 'vs-section-actions' });
}

function renderActiveJob(container: HTMLElement, ctx: ViewContext, job: Job) {
  const card = container.createDiv({ cls: 'vs-job-card' });
  const body = card.createDiv({ cls: 'vs-job-body' });

  const media = mediaOf(ctx, job);
  thumbnail(body, { ...media, size: 'lg' });

  const info = body.createDiv({ cls: 'vs-job-info' });
  info.createDiv({
    text: displayTaskTitle(job.title),
    cls: 'vs-job-title',
    attr: { title: job.title },
  });
  const sub = info.createDiv({ cls: 'vs-job-sub' });
  platformText(sub, job.platform, platformLabel(job.platform));
  if (job.startedAt) {
    sub.createSpan({ text: `已用 ${formatClock(Date.now() - job.startedAt)}`, cls: 'vs-mono' });
  }
  if (!job.useCache) sub.createSpan({ text: '跳过缓存' });

  const side = body.createDiv({ cls: 'vs-job-side' });
  // n8n 是一次性请求拿不到中间态，这里就只说"处理中"，不编造阶段
  statusPill(side, job.state === 'queued' ? 'queued' : 'running', {
    label: job.state === 'queued' ? '排队中' : job.stageLabel || '处理中',
    title: job.stageLabel ? undefined : '该后端不上报处理阶段，仅显示计时',
  });
  iconButton(
    side,
    'x',
    '取消',
    fire(async () => {
      await ctx.plugin.jobService.cancel(job);
      ctx.renderPanels();
    }),
  );

  const bar = card.createDiv({ cls: 'vs-progress' });
  const fill = bar.createDiv({
    cls: `vs-progress-fill${job.progress === undefined ? ' is-indeterminate' : ''}`,
  });
  if (job.progress !== undefined) fill.style.width = `${Math.round(job.progress * 100)}%`;
}

function renderReviewJob(container: HTMLElement, ctx: ViewContext, job: Job) {
  const card = container.createDiv({ cls: 'vs-job-card is-review' });
  const body = card.createDiv({ cls: 'vs-job-body' });

  const media = mediaOf(ctx, job);
  thumbnail(body, { ...media, size: 'lg' });

  const info = body.createDiv({ cls: 'vs-job-info' });
  info.createDiv({
    text: displayTaskTitle(job.title),
    cls: 'vs-job-title',
    attr: { title: job.title },
  });
  info.createDiv({ text: summarize(job), cls: 'vs-job-sub' });

  statusPill(body.createDiv({ cls: 'vs-job-side' }), 'review');

  const actions = card.createDiv({ cls: 'vs-job-actions' });
  textButton(
    actions,
    '预览',
    () => ctx.openDetail({ kind: 'job', id: job.id }),
    'is-primary is-fill',
  );
  textButton(
    actions,
    '直接写入',
    fire(async () => {
      if (await ctx.plugin.jobService.writeResult(job)) {
        new Notice('已写入笔记');
        ctx.renderPanels();
      }
    }),
    'is-fill',
  );
  iconButton(
    actions,
    'trash-2',
    '丢弃结果',
    fire(async () => {
      await ctx.plugin.jobService.discardResult(job);
      ctx.renderPanels();
    }),
    'vs-icon-btn-boxed',
  );
}

/** 任务对应笔记的封面/时长（拿不到就用占位斜纹） */
function mediaOf(
  ctx: ViewContext,
  job: Job,
): { cover?: string; duration?: string; platform?: string } {
  const entry = job.notePath ? ctx.plugin.noteIndex.get(job.notePath) : undefined;
  const resultCover = safeCoverUrl(job.result?.video_cover);
  if (!resultCover && entry && !entry.cover) ctx.plugin.noteIndex.ensureCover(entry.path);
  if (!resultCover && !entry?.cover && job.input.url) {
    ctx.plugin.noteIndex.ensureCoverForUrl(job.input.url);
  }
  return {
    cover: resultCover || entry?.cover || ctx.plugin.noteIndex.coverForUrl(job.input.url),
    duration: entry?.duration || job.result?.video_duration,
    platform: job.platform || entry?.platform,
  };
}

interface HistoryRow {
  key: string;
  title: string;
  state: 'success' | 'error' | 'cancelled';
  time: number;
  mode: string;
  platform?: string;
  error?: string;
  durationMs?: number;
  job?: Job;
  record?: ProcessingHistory;
}

function buildHistoryRows(ctx: ViewContext, finishedJobs: Job[]): HistoryRow[] {
  const rows: HistoryRow[] = finishedJobs.map((job) => ({
    key: job.id,
    title: job.title,
    state: job.state === 'success' ? 'success' : job.state === 'error' ? 'error' : 'cancelled',
    time: job.endedAt || job.createdAt,
    mode: job.mode,
    platform: job.platform,
    error: job.error,
    durationMs: job.endedAt && job.startedAt ? job.endedAt - job.startedAt : undefined,
    job,
  }));

  const seen = new Set(rows.map((row) => `${row.title}|${Math.floor(row.time / 1000)}`));
  const history = ctx.plugin.settings.history || [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const record = history[index];
    const time = parseLocaleTime(record.time) ?? 0;
    const key = `${record.file}|${Math.floor(time / 1000)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      key: `h-${record.file}-${record.time}`,
      title: record.file,
      state: record.result === 'success' ? 'success' : 'error',
      time,
      mode: record.mode,
      platform: record.platform,
      error: record.error,
      durationMs: record.durationMs,
      record,
    });
  }

  return rows.sort((a, b) => b.time - a.time);
}

function renderHistoryRow(container: HTMLElement, ctx: ViewContext, row: HistoryRow) {
  const item = container.createDiv({ cls: 'vs-row' });
  const entry = findEntry(ctx, row.title);
  const sourceUrl = row.job?.input.url || row.record?.url;
  const resultCover = safeCoverUrl(row.job?.result?.video_cover);
  if (!resultCover && entry && !entry.cover) ctx.plugin.noteIndex.ensureCover(entry.path);
  if (!resultCover && !entry?.cover && sourceUrl) {
    ctx.plugin.noteIndex.ensureCoverForUrl(sourceUrl);
  }
  thumbnail(item, {
    cover: resultCover || entry?.cover || ctx.plugin.noteIndex.coverForUrl(sourceUrl),
    duration: entry?.duration,
    platform: row.platform || entry?.platform,
  });

  const body = item.createDiv({ cls: 'vs-row-body' });
  const displayTitle = displayTaskTitle(row.title);
  body.createDiv({
    text: displayTitle,
    cls: 'vs-row-title',
    attr: { title: displayTitle === row.title ? '' : row.title },
  });

  if (row.state === 'error' && row.error) {
    // 列表只给可行动的一句摘要，避免 URL、本机路径或后端响应直接铺在侧栏。
    // 原始错误仍保留在任务详情、日志和“复制失败原因”操作里。
    body.createDiv({
      text: summarizeError(row.error),
      cls: 'vs-row-sub is-error',
      attr: { title: '点击任务查看完整失败详情' },
    });
  } else {
    const sub = body.createDiv({ cls: 'vs-row-sub' });
    if (row.time) sub.createSpan({ text: formatRelative(row.time) });
    if (row.durationMs) sub.createSpan({ text: formatElapsed(row.durationMs), cls: 'vs-mono' });
    if (!row.time && !row.durationMs) sub.createSpan({ text: modeLabel(row.mode) });
  }

  body.addEventListener('click', () => {
    if (row.job) {
      ctx.openDetail({ kind: 'job', id: row.job.id });
    } else if (row.record) {
      ctx.openDetail({ kind: 'history', file: row.record.file, time: row.record.time });
    }
  });
  body.tabIndex = 0;
  body.setAttribute('role', 'button');
  body.setAttribute('aria-label', `查看任务详情：${displayTitle}`);
  body.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    body.click();
  });

  // 状态胶囊即动作：失败行点一下就是跳过缓存重跑
  const statePill =
    row.state === 'error'
      ? statusPill(item, 'error', {
          label: '重试',
          title: '跳过缓存重新处理',
          onClick: () => void rerun(ctx, row),
        })
      : statusPill(item, row.state, {
          label: row.state === 'success' ? '完成' : '已取消',
        });
  statePill.addClass('vs-row-status');

  if (row.state === 'error' && row.error) renderNextStep(container, ctx, row);

  const actions = item.createDiv({ cls: 'vs-row-actions' });
  iconButton(actions, 'more-horizontal', '更多操作', (event) => {
    showMenu(event, [
      {
        title: '打开笔记',
        icon: 'file-text',
        onClick: () => openNoteByName(ctx, row.title),
      },
      {
        title: '重跑（跳过缓存）',
        icon: 'refresh-cw',
        onClick: () => rerun(ctx, row),
      },
      {
        title: '复制失败原因',
        icon: 'clipboard',
        disabled: !row.error,
        onClick: () => {
          void navigator.clipboard.writeText(row.error || '');
          new Notice('已复制');
        },
      },
    ]);
  });
}

/** 失败行下面给一个能直接做的下一步；认不出原因时不加 */
function renderNextStep(container: HTMLElement, ctx: ViewContext, row: HistoryRow) {
  const kind = failureKind(row.error || '');
  if (!kind) return;
  const strip = container.createDiv({ cls: 'vs-next-step' });
  if (kind === 'no-transcript') {
    strip.createSpan({ text: '可以补一份文稿再总结' });
    textButton(strip, '粘贴文稿 →', () => {
      const url = row.job?.input.url || row.record?.url || '';
      ctx.state.inputDraft = url;
      ctx.state.advancedOpen = true;
      ctx.renderAll();
      window.setTimeout(() => {
        document.querySelector<HTMLTextAreaElement>('.vs-fold .vs-transcript-input')?.focus();
      }, 0);
    });
  } else if (kind === 'login') {
    strip.createSpan({ text: '登录状态失效，更新 Cookies 后重试' });
    textButton(strip, '打开设置 →', () => openSettings(ctx));
  } else {
    strip.createSpan({ text: '处理服务没有连上' });
    textButton(strip, '重新检测 →', () => {
      document.querySelector<HTMLButtonElement>('.vs-backend-line')?.click();
    });
  }
}

function failureKind(raw: string): 'no-transcript' | 'login' | 'backend' | null {
  const error = raw.toLowerCase();
  if (NO_TRANSCRIPT.test(error)) return 'no-transcript';
  if (/cookie|登录|login|session|需要验证|扫码|验证码/.test(error)) return 'login';
  if (
    /econnrefused|enotfound|network|failed to fetch|fetch failed|无法连接|连接失败|timeout|timed out|超时/.test(
      error,
    )
  ) {
    return 'backend';
  }
  return null;
}

const NO_TRANSCRIPT =
  /无字幕|没有字幕|未找到字幕|字幕不可用|no subtitles?|no captions?|subtitles? not (?:found|available)|transcript (?:not available|unavailable)|没有文稿/;

/** 历史里保留原始文件名用于重跑；列表只隐藏时间戳和机器式前缀。 */
function displayTaskTitle(raw: string): string {
  const match = raw.match(/^(文稿(?:处理)?|本地文件|YouTube视频|B站视频)_(?:\d{8}_\d{6}_)?(.+)$/);
  if (!match) return raw;

  const sourceLabel: Record<string, string> = {
    文稿: '文稿',
    文稿处理: '文稿',
    本地文件: '本地',
    YouTube视频: 'YouTube',
    B站视频: 'B站',
  };
  const title = match[2]
    .replace(/_\d{13}$/, '')
    .replace(/_/g, ' ')
    .trim();
  return title ? `${sourceLabel[match[1]]} · ${title}` : raw;
}

function findEntry(ctx: ViewContext, basename: string) {
  return ctx.plugin.noteIndex.getAll().find((candidate) => candidate.basename === basename);
}

/** 后端封面只允许受信平台的 HTTPS 图片；本机/私网资源必须先本地化。 */
function safeCoverUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cover = value.trim();
  if (!cover) return undefined;
  const remote = normalizeRemoteCoverUrl(cover);
  return remote;
}

/** 把可能包含 URL、路径和服务端原文的错误压成稳定、安全的一句话。 */
function summarizeError(raw: string): string {
  const error = raw.toLowerCase();

  if (NO_TRANSCRIPT.test(error)) {
    return '没有字幕';
  }
  if (/cookie|登录|login|session|需要验证|扫码|验证码/.test(error)) {
    return '登录状态已失效 · 更新凭证后重试';
  }
  if (/429|rate.?limit|too many requests|请求过于频繁|限流|quota/.test(error)) {
    return '请求过于频繁 · 稍后重试';
  }
  if (/401|unauthorized|api.?key|鉴权|授权失败|invalid.?key/.test(error)) {
    return '服务授权失败 · 检查密钥配置';
  }
  if (/403|forbidden|拒绝访问|access denied/.test(error)) {
    return '访问被拒绝 · 检查账号权限';
  }
  if (/404|webhook.*(?:不存在|not found)|workflow.*(?:未激活|inactive)/.test(error)) {
    return '处理流程未启用 · 检查 Webhook';
  }
  if (/空响应|empty response|no response body/.test(error)) {
    return '服务端未返回内容 · 检查处理流程';
  }
  if (/json|返回格式|unexpected token|parse response/.test(error)) {
    return '服务返回格式异常 · 查看详情';
  }
  if (/timeout|timed out|etimedout|超时|aborterror/.test(error)) {
    return '连接超时 · 检查服务或网络';
  }
  if (/econnrefused|enotfound|network|failed to fetch|fetch failed|无法连接|连接失败/.test(error)) {
    return '无法连接处理服务 · 检查后端';
  }
  if (/cookie|download|下载|video unavailable|视频不可用|解析视频|提取视频/.test(error)) {
    return '视频读取失败 · 查看详情';
  }
  if (/enoent|eacces|permission denied|本地文件|local file|文件不存在/.test(error)) {
    return '本机文件无法读取 · 检查路径权限';
  }
  if (/model|模型|gemini|openai|anthropic/.test(error)) {
    return '模型处理失败 · 查看详情';
  }
  return '处理失败 · 点击查看详情';
}

async function rerun(ctx: ViewContext, row: HistoryRow) {
  if (row.job) {
    ctx.plugin.jobs.retry(row.job.id);
    ctx.renderPanels();
    return;
  }
  const file = findNote(ctx, row.title);
  if (!file) {
    new Notice(`找不到笔记：${row.title}`);
    return;
  }
  await ctx.plugin.jobService.submitFile(file, { ...ctx.submitOptions(), useCache: false });
  ctx.renderPanels();
}

function openNoteByName(ctx: ViewContext, name: string) {
  const file = findNote(ctx, name);
  if (!file) {
    new Notice(`找不到笔记：${name}`);
    return;
  }
  void ctx.openNote(file.path);
}

function findNote(ctx: ViewContext, name: string): TFile | null {
  const direct = ctx.plugin.app.vault.getAbstractFileByPath(`${name}.md`);
  if (direct instanceof TFile) return direct;
  const files = ctx.plugin.app.vault.getMarkdownFiles();
  return files.find((file) => file.basename === name) || null;
}

function summarize(job: Job): string {
  const result = job.result;
  if (!result) return '等待确认';
  const bits: string[] = [];
  if (result.video_title) bits.push(result.video_title);
  if (result.video_duration) bits.push(result.video_duration);
  if (result.summary) bits.push(`总结 ${result.summary.length} 字`);
  if (result.video_transcript) bits.push(`文稿 ${result.video_transcript.length} 字`);
  return bits.join(' · ') || '结果已就绪，等待写入';
}

/** 从 api 的 webhook 结果历史里取回一条：建新笔记、写入当前笔记或插到当前笔记末尾 */
function showWebhookHistoryMenu(ctx: ViewContext, event: MouseEvent) {
  const history = ctx.plugin.api.getWebhookHistory();
  if (!history || history.length === 0) {
    new Notice('还没有可复用的 webhook 结果');
    return;
  }
  showMenu(
    event,
    history.slice(0, 12).map((entry, index) => ({
      title: `${index + 1}. ${entry.result.video_title || entry.input.url || '未命名'}`,
      icon: 'file-plus',
      onClick: () => showWebhookEntryActions(ctx, entry, event),
    })),
  );
}

function showWebhookEntryActions(ctx: ViewContext, entry: WebhookHistoryEntry, event: MouseEvent) {
  showMenu(event, [
    {
      title: '新建笔记',
      icon: 'file-plus',
      onClick: async () => {
        await ctx.plugin.jobService.createNoteFromJson(
          JSON.stringify({ ...entry.result, input: entry.input }),
          entry.language,
        );
        ctx.renderPanels();
      },
    },
    {
      title: '应用到当前笔记',
      icon: 'save',
      onClick: async () => {
        await ctx.plugin.jobService.applyToActiveNote(entry.result, entry.mode);
        ctx.renderPanels();
      },
    },
    {
      title: '插到当前笔记末尾',
      icon: 'text-cursor-input',
      onClick: () => ctx.plugin.jobService.insertIntoActiveNote(entry.result),
    },
    {
      title: '复制 JSON',
      icon: 'clipboard',
      onClick: () => {
        void navigator.clipboard.writeText(JSON.stringify(entry.result, null, 2));
        new Notice('已复制');
      },
    },
  ]);
}
