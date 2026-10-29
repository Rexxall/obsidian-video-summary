import { tr } from '../../utils/i18n';
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
    section(
      container,
      tr(`进行中 ${active.length + review.length}`, `In progress ${active.length + review.length}`),
    );
  }
  if (active.length > 0) {
    active.forEach((job) => renderActiveJob(container, ctx, job));
  }

  if (review.length > 0) {
    review.forEach((job) => renderReviewJob(container, ctx, job));
  }

  const historyRows = buildHistoryRows(ctx, finished);
  if (historyRows.length > 0) {
    const header = section(container, tr('最近完成', 'Recently finished'));
    iconButton(
      header,
      'history',
      tr('从 webhook 历史结果里取回', 'Fetched from webhook history'),
      (event) => {
        showWebhookHistoryMenu(ctx, event);
      },
    );
    iconButton(header, 'more-horizontal', tr('列表操作', 'List actions'), (event) => {
      showMenu(event, [
        {
          title: tr('清掉已完成的任务卡', 'Clear finished job cards'),
          icon: 'eraser',
          onClick: () => {
            ctx.plugin.jobs.clearFinished();
            ctx.renderPanels();
          },
        },
        {
          title: tr('清空处理历史', 'Clear processing history'),
          icon: 'trash',
          onClick: async () => {
            await ctx.plugin.clearProcessingHistory();
            ctx.renderPanels();
          },
        },
        {
          title: tr('清空结果缓存', 'Clear result cache'),
          icon: 'database',
          onClick: async () => {
            try {
              ctx.plugin.api.clearCache();
              new Notice(tr('缓存已清空', 'Cache cleared'));
            } catch (error) {
              new Notice(
                tr(
                  `清空缓存失败: ${error instanceof Error ? errorMessage(error) : error}`,
                  `Could not clear the cache: ${error instanceof Error ? errorMessage(error) : error}`,
                ),
              );
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
          ? tr('收起最近完成', 'Hide recent jobs')
          : tr(
              `显示更多 · 还有 ${historyRows.length - RECENT_HISTORY_LIMIT} 条`,
              `Show more · ${historyRows.length - RECENT_HISTORY_LIMIT} more`,
            ),
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
    const demo = {
      label: tr('看示例笔记', 'See an example note'),
      run: () => void ctx.plugin.openDemoNote(),
    };
    if (!ctx.plugin.isBackendConfigured()) {
      emptyState(
        container,
        'plug-zap',
        tr('还没连上后端', 'No backend connected yet'),
        tr(
          '视频要交给你电脑上的后端处理。先看一篇示例笔记，或者按首次配置把后端连上。',
          'Videos are processed by a backend on your computer. Look at an example note first, or connect the backend in the first-run setup.',
        ),
        {
          label: tr('打开首次配置', 'Open first-run setup'),
          run: () => ctx.plugin.openSettingsPage(),
        },
        demo,
      );
    } else {
      emptyState(
        container,
        'inbox',
        tr('还没有任务', 'No jobs yet'),
        tr(
          '在上面贴一条视频链接，或者到笔记库里挑一篇处理。',
          'Paste a video link above, or pick a note from the library.',
        ),
        demo,
      );
    }
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
    sub.createSpan({
      text: tr(
        `已用 ${formatClock(Date.now() - job.startedAt)}`,
        `${formatClock(Date.now() - job.startedAt)} so far`,
      ),
      cls: 'vs-mono',
    });
  }
  if (!job.useCache) sub.createSpan({ text: tr('跳过缓存', 'Skip cache') });

  const side = body.createDiv({ cls: 'vs-job-side' });
  // n8n 是一次性请求拿不到中间态，这里就只说"处理中"，不编造阶段
  statusPill(side, job.state === 'queued' ? 'queued' : 'running', {
    label:
      job.state === 'queued'
        ? tr('排队中', 'Queued')
        : job.stageLabel || tr('处理中', 'Processing'),
    title: job.stageLabel
      ? undefined
      : tr(
          '该后端不上报处理阶段，仅显示计时',
          'This backend does not report stages; only the timer is shown',
        ),
  });
  iconButton(
    side,
    'x',
    tr('取消', 'Cancel'),
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
    tr('预览', 'Preview'),
    () => ctx.openDetail({ kind: 'job', id: job.id }),
    'is-primary is-fill',
  );
  textButton(
    actions,
    tr('直接写入', 'Write now'),
    fire(async () => {
      if (await ctx.plugin.jobService.writeResult(job)) {
        new Notice(tr('已写入笔记', 'Written to the note'));
        ctx.renderPanels();
      }
    }),
    'is-fill',
  );
  iconButton(
    actions,
    'trash-2',
    tr('丢弃结果', 'Discard result'),
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
      attr: { title: tr('点击任务查看完整失败详情', 'Click the job for the full failure details') },
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
  body.setAttribute(
    'aria-label',
    tr(`查看任务详情：${displayTitle}`, `Job details: ${displayTitle}`),
  );
  body.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    body.click();
  });

  // 状态胶囊即动作：失败行点一下就是跳过缓存重跑
  const statePill =
    row.state === 'error'
      ? statusPill(item, 'error', {
          label: tr('重试', 'Retry'),
          title: tr('跳过缓存重新处理', 'Process again, skipping the cache'),
          onClick: () => void rerun(ctx, row),
        })
      : statusPill(item, row.state, {
          label: row.state === 'success' ? tr('完成', 'Done') : tr('已取消', 'Cancelled'),
        });
  statePill.addClass('vs-row-status');

  if (row.state === 'error' && row.error) renderNextStep(container, ctx, row);

  const actions = item.createDiv({ cls: 'vs-row-actions' });
  iconButton(actions, 'more-horizontal', tr('更多操作', 'More actions'), (event) => {
    showMenu(event, [
      {
        title: tr('打开笔记', 'Open note'),
        icon: 'file-text',
        onClick: () => openNoteByName(ctx, row.title),
      },
      {
        title: tr('重跑（跳过缓存）', 'Run again (skip cache)'),
        icon: 'refresh-cw',
        onClick: () => rerun(ctx, row),
      },
      {
        title: tr('复制失败原因', 'Copy the failure reason'),
        icon: 'clipboard',
        disabled: !row.error,
        onClick: () => {
          void navigator.clipboard.writeText(row.error || '');
          new Notice(tr('已复制', 'Copied'));
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
    strip.createSpan({ text: tr('可以补一份文稿再总结', 'Add a transcript and summarise again') });
    textButton(strip, tr('粘贴文稿 →', 'Paste a transcript →'), () => {
      const url = row.job?.input.url || row.record?.url || '';
      ctx.state.inputDraft = url;
      ctx.state.advancedOpen = true;
      ctx.renderAll();
      window.setTimeout(() => {
        document.querySelector<HTMLTextAreaElement>('.vs-fold .vs-transcript-input')?.focus();
      }, 0);
    });
  } else if (kind === 'login') {
    strip.createSpan({
      text: tr('登录状态失效，更新 Cookies 后重试', 'Login expired; update the cookies and retry'),
    });
    textButton(strip, tr('打开设置 →', 'Open settings →'), () => openSettings(ctx));
  } else {
    strip.createSpan({ text: tr('处理服务没有连上', 'The backend is not connected') });
    textButton(strip, tr('重新检测 →', 'Check again →'), () => {
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
    文稿: tr('文稿', 'Transcript'),
    文稿处理: tr('文稿', 'Transcript'),
    本地文件: tr('本地', 'Local'),
    YouTube视频: 'YouTube',
    B站视频: tr('B站', 'Bilibili'),
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
    return tr('没有字幕', 'No subtitles');
  }
  if (/cookie|登录|login|session|需要验证|扫码|验证码/.test(error)) {
    return tr(
      '登录状态已失效 · 更新凭证后重试',
      'Login expired · update the credentials and retry',
    );
  }
  if (/429|rate.?limit|too many requests|请求过于频繁|限流|quota/.test(error)) {
    return tr('请求过于频繁 · 稍后重试', 'Too many requests · try again later');
  }
  if (/401|unauthorized|api.?key|鉴权|授权失败|invalid.?key/.test(error)) {
    return tr('服务授权失败 · 检查密钥配置', 'Auth failed · check the key');
  }
  if (/403|forbidden|拒绝访问|access denied/.test(error)) {
    return tr('访问被拒绝 · 检查账号权限', "Access denied · check the account's permissions");
  }
  if (/404|webhook.*(?:不存在|not found)|workflow.*(?:未激活|inactive)/.test(error)) {
    return tr('处理流程未启用 · 检查 Webhook', 'Workflow not active · check the webhook');
  }
  if (/空响应|empty response|no response body/.test(error)) {
    return tr(
      '服务端未返回内容 · 检查处理流程',
      'The backend returned nothing · check the workflow',
    );
  }
  if (/json|返回格式|unexpected token|parse response/.test(error)) {
    return tr('服务返回格式异常 · 查看详情', 'The backend returned a bad format · see details');
  }
  if (/timeout|timed out|etimedout|超时|aborterror/.test(error)) {
    return tr('连接超时 · 检查服务或网络', 'Timed out · check the backend or network');
  }
  if (/econnrefused|enotfound|network|failed to fetch|fetch failed|无法连接|连接失败/.test(error)) {
    return tr('无法连接处理服务 · 检查后端', 'Cannot reach the backend · check it');
  }
  if (/cookie|download|下载|video unavailable|视频不可用|解析视频|提取视频/.test(error)) {
    return tr('视频读取失败 · 查看详情', 'Could not read the video · see details');
  }
  if (/enoent|eacces|permission denied|本地文件|local file|文件不存在/.test(error)) {
    return tr(
      '本机文件无法读取 · 检查路径权限',
      'Cannot read the local file · check its path and permissions',
    );
  }
  if (/model|模型|gemini|openai|anthropic/.test(error)) {
    return tr('模型处理失败 · 查看详情', 'The model failed · see details');
  }
  return tr('处理失败 · 点击查看详情', 'Failed · click for details');
}

async function rerun(ctx: ViewContext, row: HistoryRow) {
  if (row.job) {
    ctx.plugin.jobs.retry(row.job.id);
    ctx.renderPanels();
    return;
  }
  const file = findNote(ctx, row.title);
  if (!file) {
    new Notice(tr(`找不到笔记：${row.title}`, `Note not found: ${row.title}`));
    return;
  }
  await ctx.plugin.jobService.submitFile(file, { ...ctx.submitOptions(), useCache: false });
  ctx.renderPanels();
}

function openNoteByName(ctx: ViewContext, name: string) {
  const file = findNote(ctx, name);
  if (!file) {
    new Notice(tr(`找不到笔记：${name}`, `Note not found: ${name}`));
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
  if (!result) return tr('等待确认', 'Waiting for confirmation');
  const bits: string[] = [];
  if (result.video_title) bits.push(result.video_title);
  if (result.video_duration) bits.push(result.video_duration);
  if (result.summary)
    bits.push(tr(`总结 ${result.summary.length} 字`, `Summary ${result.summary.length} chars`));
  if (result.video_transcript)
    bits.push(
      tr(
        `文稿 ${result.video_transcript.length} 字`,
        `Transcript ${result.video_transcript.length} chars`,
      ),
    );
  return bits.join(' · ') || tr('结果已就绪，等待写入', 'Result ready; waiting to be written');
}

/** 从 api 的 webhook 结果历史里取回一条：建新笔记、写入当前笔记或插到当前笔记末尾 */
function showWebhookHistoryMenu(ctx: ViewContext, event: MouseEvent) {
  const history = ctx.plugin.api.getWebhookHistory();
  if (!history || history.length === 0) {
    new Notice(tr('还没有可复用的 webhook 结果', 'No reusable webhook result yet'));
    return;
  }
  showMenu(
    event,
    history.slice(0, 12).map((entry, index) => ({
      title: tr(
        `${index + 1}. ${entry.result.video_title || entry.input.url || '未命名'}`,
        `${index + 1}. ${entry.result.video_title || entry.input.url || 'untitled'}`,
      ),
      icon: 'file-plus',
      onClick: () => showWebhookEntryActions(ctx, entry, event),
    })),
  );
}

function showWebhookEntryActions(ctx: ViewContext, entry: WebhookHistoryEntry, event: MouseEvent) {
  showMenu(event, [
    {
      title: tr('新建笔记', 'New note'),
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
      title: tr('应用到当前笔记', 'Apply to the current note'),
      icon: 'save',
      onClick: async () => {
        await ctx.plugin.jobService.applyToActiveNote(entry.result, entry.mode);
        ctx.renderPanels();
      },
    },
    {
      title: tr('插到当前笔记末尾', 'Insert at the end of the current note'),
      icon: 'text-cursor-input',
      onClick: () => ctx.plugin.jobService.insertIntoActiveNote(entry.result),
    },
    {
      title: tr('复制 JSON', 'Copy JSON'),
      icon: 'clipboard',
      onClick: () => {
        void navigator.clipboard.writeText(JSON.stringify(entry.result, null, 2));
        new Notice(tr('已复制', 'Copied'));
      },
    },
  ]);
}
