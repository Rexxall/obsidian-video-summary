// agent: claude (2026-07-26)
import { Notice, TFile, setIcon } from 'obsidian';
import { ViewContext } from '../context';
import { Job } from '../../core/JobStore';
import { ProcessingHistory } from '../../types';
import {
  emptyState,
  formatElapsed,
  formatRelative,
  iconButton,
  modeLabel,
  parseLocaleTime,
  platformIcon,
  showMenu,
  statusMeta,
  textButton,
} from '../ui';

/** 任务流：正在跑的、等确认的、最近跑完的，都在这一屏 */
export function renderJobsPanel(container: HTMLElement, ctx: ViewContext) {
  const jobs = ctx.plugin.jobs.getAll();
  const active = jobs.filter((job) => job.state === 'queued' || job.state === 'running');
  const review = jobs.filter((job) => job.state === 'review');
  const finished = jobs.filter(
    (job) => job.state === 'success' || job.state === 'error' || job.state === 'cancelled',
  );

  if (active.length > 0) {
    section(container, `进行中 ${active.length}`);
    active.forEach((job) => renderActiveJob(container, ctx, job));
  }

  if (review.length > 0) {
    section(container, `待确认 ${review.length}`);
    review.forEach((job) => renderReviewJob(container, ctx, job));
  }

  const historyRows = buildHistoryRows(ctx, finished);
  if (historyRows.length > 0) {
    const header = section(container, '最近');
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
              await ctx.plugin.api.clearCache();
              new Notice('缓存已清空');
            } catch (error) {
              new Notice(`清空缓存失败: ${error instanceof Error ? error.message : error}`);
            }
          },
        },
      ]);
    });
    historyRows.slice(0, 60).forEach((row) => renderHistoryRow(container, ctx, row));
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

  const head = card.createDiv({ cls: 'vs-job-head' });
  const icon = head.createDiv({ cls: 'vs-job-icon' });
  setIcon(icon, platformIcon(job.platform));
  head.createSpan({ text: job.title, cls: 'vs-job-title' });
  iconButton(head, 'x', '取消', async () => {
    await ctx.plugin.jobService.cancel(job);
    ctx.renderPanels();
  });

  const stage = card.createDiv({ cls: 'vs-job-stage' });
  if (job.state === 'queued') {
    stage.setText('排队中');
  } else if (job.stageLabel) {
    stage.setText(job.stageLabel);
  } else {
    // n8n 是一次性请求，后端不上报中间状态，这里如实说明而不是假造阶段
    stage.setText('已发送到后端，等待返回（该后端不上报阶段）');
  }

  const bar = card.createDiv({ cls: 'vs-progress' });
  const fill = bar.createDiv({
    cls: `vs-progress-fill${job.progress === undefined ? ' is-indeterminate' : ''}`,
  });
  if (job.progress !== undefined) {
    fill.style.width = `${Math.round(job.progress * 100)}%`;
  }

  const meta = card.createDiv({ cls: 'vs-job-meta' });
  meta.createSpan({ text: modeLabel(job.mode) });
  if (job.startedAt) {
    meta.createSpan({ text: `已用 ${formatElapsed(Date.now() - job.startedAt)}` });
  }
  if (!job.useCache) meta.createSpan({ text: '跳过缓存' });
}

function renderReviewJob(container: HTMLElement, ctx: ViewContext, job: Job) {
  const card = container.createDiv({ cls: 'vs-job-card is-review' });
  const head = card.createDiv({ cls: 'vs-job-head' });
  const icon = head.createDiv({ cls: 'vs-job-icon' });
  setIcon(icon, 'eye');
  head.createSpan({ text: job.title, cls: 'vs-job-title' });

  card.createDiv({
    text: summarize(job),
    cls: 'vs-job-stage',
  });

  const actions = card.createDiv({ cls: 'vs-job-actions' });
  textButton(actions, '预览', () => ctx.openDetail({ kind: 'job', id: job.id }), 'is-primary');
  textButton(actions, '写入笔记', async () => {
    if (await ctx.plugin.jobService.writeResult(job)) {
      new Notice('已写入笔记');
      ctx.renderPanels();
    }
  });
  textButton(actions, '丢弃', async () => {
    await ctx.plugin.jobService.discardResult(job);
    ctx.renderPanels();
  });
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
  const meta = statusMeta(row.state);
  item.createDiv({ cls: `vs-dot ${meta.cls}` });

  const body = item.createDiv({ cls: 'vs-row-body' });
  body.createDiv({ text: row.title, cls: 'vs-row-title' });
  const parts = [modeLabel(row.mode)];
  if (row.time) parts.push(formatRelative(row.time));
  if (row.durationMs) parts.push(formatElapsed(row.durationMs));
  body.createDiv({ text: parts.join(' · '), cls: 'vs-row-sub' });
  if (row.state === 'error' && row.error) {
    body.createDiv({ text: row.error, cls: 'vs-row-error' });
  }

  body.addEventListener('click', () => {
    if (row.job) {
      ctx.openDetail({ kind: 'job', id: row.job.id });
    } else if (row.record) {
      ctx.openDetail({ kind: 'history', file: row.record.file, time: row.record.time });
    }
  });

  iconButton(item, 'more-horizontal', '更多操作', (event) => {
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
  ctx.openNote(file.path);
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

function showWebhookEntryActions(ctx: ViewContext, entry: any, event: MouseEvent) {
  showMenu(event, [
    {
      title: '新建笔记',
      icon: 'file-plus',
      onClick: async () => {
        await ctx.plugin.jobService.createNoteFromJson(
          JSON.stringify(entry.result),
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
