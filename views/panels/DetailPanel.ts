// agent: claude (2026-07-26)
import { MarkdownRenderer, Notice, TFile, setIcon } from 'obsidian';
import { DetailTab, ViewContext } from '../context';
import { Job } from '../../core/JobStore';
import { ProcessingHistory } from '../../types';
import {
  emptyState,
  formatElapsed,
  formatRelative,
  iconButton,
  languageLabel,
  modeLabel,
  parseLocaleTime,
  statusMeta,
  textButton,
} from '../ui';

/** 详情层：结果预览 + 写入方式 + 失败日志。写入笔记前能先看到要写什么。 */
export function renderDetailPanel(container: HTMLElement, ctx: ViewContext) {
  const ref = ctx.state.detail;
  if (!ref) return;

  if (ref.kind === 'job') {
    const job = ctx.plugin.jobs.get(ref.id);
    if (!job) {
      ctx.closeDetail();
      return;
    }
    renderJobDetail(container, ctx, job);
    return;
  }

  const record = (ctx.plugin.settings.history || []).find(
    (item) => item.file === ref.file && item.time === ref.time,
  );
  if (!record) {
    ctx.closeDetail();
    return;
  }
  renderRecordDetail(container, ctx, record);
}

function renderHeader(container: HTMLElement, ctx: ViewContext, title: string, status: string) {
  const header = container.createDiv({ cls: 'vs-detail-header' });
  iconButton(header, 'arrow-left', '返回列表', () => ctx.closeDetail());
  header.createSpan({ text: title, cls: 'vs-detail-title' });
  const meta = statusMeta(status);
  header.createSpan({ text: meta.label, cls: `vs-badge ${meta.cls}` });
}

function renderJobDetail(container: HTMLElement, ctx: ViewContext, job: Job) {
  renderHeader(container, ctx, job.title, job.state);

  const stats = container.createDiv({ cls: 'vs-stat-grid' });
  stat(stats, '模式', modeLabel(job.mode));
  stat(stats, '语言', languageLabel(job.language));
  stat(
    stats,
    '耗时',
    job.startedAt ? formatElapsed((job.endedAt || Date.now()) - job.startedAt) : '—',
  );
  if (job.result?.video_duration) stat(stats, '时长', job.result.video_duration);
  if (job.result?.video_author) stat(stats, '作者', job.result.video_author);
  if (job.input.url) stat(stats, '链接', job.input.url, true);

  if (job.state === 'error' && job.error) {
    const errorBox = container.createDiv({ cls: 'vs-error-box' });
    const icon = errorBox.createDiv({ cls: 'vs-error-icon' });
    setIcon(icon, 'alert-triangle');
    errorBox.createDiv({ text: job.error, cls: 'vs-error-text' });
    const actions = container.createDiv({ cls: 'vs-detail-actions' });
    textButton(
      actions,
      '重试（跳过缓存）',
      () => {
        ctx.plugin.jobs.retry(job.id);
        ctx.closeDetail();
      },
      'is-primary',
    );
    textButton(actions, '复制错误', () => {
      void navigator.clipboard.writeText(job.error || '');
      new Notice('已复制');
    });
    if (isCookieError(job.error)) {
      textButton(actions, '打开 cookies 目录', () => openCookiesFolder(ctx));
    }
  }

  if (!job.result) {
    renderLogs(container, job);
    return;
  }

  const tabs: Array<[DetailTab, string]> = [
    ['preview', '预览'],
    ['transcript', '文稿'],
    ['meta', '元数据'],
    ['logs', '日志'],
  ];
  const tabRow = container.createDiv({ cls: 'vs-tab-row is-inner' });
  tabs.forEach(([value, label]) => {
    const tab = tabRow.createEl('button', {
      text: label,
      cls: `vs-tab${ctx.state.detailTab === value ? ' is-active' : ''}`,
      attr: { type: 'button' },
    });
    tab.addEventListener('click', () => {
      ctx.state.detailTab = value;
      ctx.renderPanels();
    });
  });

  const body = container.createDiv({ cls: 'vs-detail-body' });
  switch (ctx.state.detailTab) {
    case 'transcript':
      renderText(body, job.result.video_transcript, '这次没有返回文稿');
      break;
    case 'meta':
      renderText(body, JSON.stringify(job.result, null, 2).slice(0, 8000), '没有元数据');
      break;
    case 'logs':
      renderLogs(body, job);
      break;
    default:
      renderPreview(body, ctx, job);
  }

  const actions = container.createDiv({ cls: 'vs-detail-actions' });
  if (job.state === 'review') {
    textButton(
      actions,
      '写入笔记',
      async () => {
        if (await ctx.plugin.jobService.writeResult(job)) {
          new Notice('已写入笔记');
          ctx.closeDetail();
        }
      },
      'is-primary',
    );
  } else if (job.notePath) {
    textButton(actions, '打开笔记', () => ctx.openNote(job.notePath!), 'is-primary');
  }
  textButton(actions, '新建笔记', async () => {
    await ctx.plugin.jobService.createNoteFromResult(job);
    ctx.renderPanels();
  });
  textButton(actions, '应用到当前笔记', async () => {
    if (job.result) await ctx.plugin.jobService.applyToActiveNote(job.result, job.mode);
  });
  textButton(actions, '插入当前笔记', async () => {
    if (job.result) await ctx.plugin.jobService.insertIntoActiveNote(job.result);
  });
  textButton(actions, '复制 JSON', () => {
    void navigator.clipboard.writeText(JSON.stringify(job.result, null, 2));
    new Notice('已复制 JSON');
  });
  if (job.state === 'review') {
    textButton(actions, '丢弃', async () => {
      await ctx.plugin.jobService.discardResult(job);
      ctx.closeDetail();
    });
  }
}

function renderPreview(body: HTMLElement, ctx: ViewContext, job: Job) {
  const result = job.result;
  if (!result) return;

  const changes: string[] = [];
  if (result.video_title) changes.push('video_title');
  if (result.video_author) changes.push('video_author');
  if (result.video_duration) changes.push('video_duration');
  if (result.summary) changes.push('summary');
  body.createDiv({
    text: `将写入 frontmatter：${changes.join('、') || '无'}；正文 ${
      (result.note || result.summary || '').length
    } 字`,
    cls: 'vs-preview-diff',
  });

  const markdown = [
    result.summary ? `## 总结\n\n${result.summary}` : '',
    result.note ? `## 笔记\n\n${result.note}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const markdownEl = body.createDiv({ cls: 'vs-markdown' });
  if (!markdown) {
    markdownEl.setText('这次没有返回可写入的正文');
    return;
  }
  void MarkdownRenderer.render(
    ctx.plugin.app,
    markdown.slice(0, 6000),
    markdownEl,
    job.notePath || '',
    ctx.plugin,
  );
}

function renderRecordDetail(container: HTMLElement, ctx: ViewContext, record: ProcessingHistory) {
  renderHeader(container, ctx, record.file, record.result);

  const stats = container.createDiv({ cls: 'vs-stat-grid' });
  stat(stats, '模式', modeLabel(record.mode));
  if (record.language) stat(stats, '语言', languageLabel(record.language));
  const time = parseLocaleTime(record.time);
  stat(stats, '时间', time ? formatRelative(time) : record.time);
  if (record.durationMs) stat(stats, '耗时', formatElapsed(record.durationMs));
  if (record.url) stat(stats, '链接', record.url, true);

  if (record.error) {
    const errorBox = container.createDiv({ cls: 'vs-error-box' });
    const icon = errorBox.createDiv({ cls: 'vs-error-icon' });
    setIcon(icon, 'alert-triangle');
    errorBox.createDiv({ text: record.error, cls: 'vs-error-text' });
  } else if (record.result === 'error') {
    container.createDiv({
      text: '这条记录是旧版本写的，没有保存失败原因。重跑一次就能看到具体错误。',
      cls: 'vs-hint',
    });
  }

  const actions = container.createDiv({ cls: 'vs-detail-actions' });
  const file = findNote(ctx, record.file);
  if (file) {
    textButton(actions, '打开笔记', () => ctx.openNote(file.path), 'is-primary');
    textButton(actions, '重跑（跳过缓存）', async () => {
      await ctx.plugin.jobService.submitFile(file, { ...ctx.submitOptions(), useCache: false });
      ctx.closeDetail();
    });
  } else {
    container.createDiv({ text: `找不到笔记：${record.file}`, cls: 'vs-hint' });
  }
}

function renderLogs(container: HTMLElement, job: Job) {
  const box = container.createDiv({ cls: 'vs-log-box' });
  if (job.logs.length === 0) {
    emptyState(box, 'file-clock', '没有日志', '只有会上报进度的后端才会写日志');
    return;
  }
  job.logs
    .slice()
    .reverse()
    .forEach((entry) => {
      const line = box.createDiv({ cls: 'vs-log-line' });
      line.createSpan({
        text: new Date(entry.time).toLocaleTimeString('zh-CN'),
        cls: 'vs-log-time',
      });
      line.createSpan({ text: entry.text, cls: 'vs-log-text' });
    });
}

function renderText(container: HTMLElement, text: string | undefined, empty: string) {
  if (!text) {
    container.createDiv({ text: empty, cls: 'vs-hint' });
    return;
  }
  container.createEl('pre', { text: text.slice(0, 20000), cls: 'vs-pre' });
}

function stat(container: HTMLElement, label: string, value: string, wide = false) {
  const cell = container.createDiv({ cls: `vs-stat${wide ? ' is-wide' : ''}` });
  cell.createDiv({ text: label, cls: 'vs-stat-label' });
  cell.createDiv({ text: value, cls: 'vs-stat-value' });
}

function isCookieError(error: string): boolean {
  return /cookie|登录|login|403|需要验证/i.test(error);
}

function openCookiesFolder(ctx: ViewContext) {
  const path = ctx.plugin.settings.cookiesDirPath;
  if (!path) {
    new Notice('还没配置 cookies 目录，先去插件设置里填');
    return;
  }
  // 桌面端才有 shell；移动端直接提示
  const shell = (window as any).require?.('electron')?.shell;
  if (shell?.openPath) {
    void shell.openPath(path);
  } else {
    new Notice(`cookies 目录：${path}`);
  }
}

function findNote(ctx: ViewContext, name: string): TFile | null {
  const direct = ctx.plugin.app.vault.getAbstractFileByPath(`${name}.md`);
  if (direct instanceof TFile) return direct;
  return ctx.plugin.app.vault.getMarkdownFiles().find((file) => file.basename === name) || null;
}
