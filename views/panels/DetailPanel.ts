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
  platformClass,
  segmented,
  showMenu,
  statusMeta,
  statusPill,
  textButton,
} from '../ui';
import { platformLabel } from '../../core/NoteIndex';

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

/** 封面横幅：返回、状态、时长都压在图上，省掉一整行 chrome */
function renderBanner(
  container: HTMLElement,
  ctx: ViewContext,
  options: { status: string; platform?: string; cover?: string; duration?: string },
) {
  const banner = container.createDiv({
    cls: `vs-banner ${platformClass(options.platform)}`,
  });
  if (options.cover) {
    const img = banner.createEl('img', { cls: 'vs-banner-img', attr: { src: options.cover } });
    img.addEventListener('error', () => img.remove());
  }
  banner.createSpan({ cls: 'vs-banner-bar' });
  iconButton(banner, 'arrow-left', '返回列表', () => ctx.closeDetail(), 'vs-banner-back');
  statusPill(banner, options.status, { label: statusMeta(options.status).label }).addClass(
    'vs-banner-pill',
  );
  if (options.duration) {
    banner.createSpan({ text: options.duration, cls: 'vs-banner-time' });
  }
}

function renderJobDetail(container: HTMLElement, ctx: ViewContext, job: Job) {
  const entry = job.notePath ? ctx.plugin.noteIndex.get(job.notePath) : undefined;
  const duration = job.result?.video_duration || entry?.duration;

  renderBanner(container, ctx, {
    status: job.state,
    platform: job.platform || entry?.platform,
    cover: entry?.cover,
    duration,
  });

  const body = container.createDiv({ cls: 'vs-detail-main' });
  body.createDiv({ text: job.title, cls: 'vs-detail-title' });

  const meta = body.createDiv({ cls: 'vs-meta-line' });
  const platformPill = meta.createSpan({ cls: 'vs-meta-pill' });
  platformPill.createSpan({
    text: platformLabel(job.platform || entry?.platform),
    cls: `vs-platform ${platformClass(job.platform || entry?.platform)}`,
  });
  if (job.result?.video_author) platformPill.createSpan({ text: ` · ${job.result.video_author}` });
  meta.createSpan({
    text: `${modeLabel(job.mode)} · ${languageLabel(job.language)}`,
    cls: 'vs-meta-pill',
  });
  if (job.startedAt) {
    meta.createSpan({
      text: `耗时 ${formatElapsed((job.endedAt || Date.now()) - job.startedAt)}`,
      cls: 'vs-meta-pill',
    });
  }
  if (job.input.url) body.createDiv({ text: job.input.url, cls: 'vs-meta-link' });

  if (job.state === 'error' && job.error) {
    const errorBox = body.createDiv({ cls: 'vs-error-box' });
    const icon = errorBox.createDiv({ cls: 'vs-error-icon' });
    setIcon(icon, 'alert-triangle');
    errorBox.createDiv({ text: job.error, cls: 'vs-error-text' });

    const actions = body.createDiv({ cls: 'vs-detail-actions' });
    textButton(
      actions,
      '重试（跳过缓存）',
      () => {
        ctx.plugin.jobs.retry(job.id);
        ctx.closeDetail();
      },
      'is-primary is-fill',
    );
    textButton(actions, '复制错误', () => {
      void navigator.clipboard.writeText(job.error || '');
      new Notice('已复制');
    });
    if (isCookieError(job.error)) {
      textButton(actions, '打开 cookies 目录', () => openCookiesFolder(ctx));
    }
    renderLogs(body, job);
    return;
  }

  if (!job.result) {
    renderLogs(body, job);
    return;
  }

  segmented(
    body,
    [
      { value: 'preview' as DetailTab, label: '预览' },
      { value: 'transcript' as DetailTab, label: '文稿' },
      { value: 'meta' as DetailTab, label: '元数据' },
      { value: 'logs' as DetailTab, label: '日志' },
    ],
    ctx.state.detailTab,
    (value) => {
      ctx.state.detailTab = value;
      ctx.renderPanels();
    },
  );

  const pane = body.createDiv({ cls: 'vs-detail-body' });
  switch (ctx.state.detailTab) {
    case 'transcript':
      renderText(pane, job.result.video_transcript, '这次没有返回文稿');
      break;
    case 'meta':
      renderText(pane, JSON.stringify(job.result, null, 2).slice(0, 8000), '没有元数据');
      break;
    case 'logs':
      renderLogs(pane, job);
      break;
    default:
      renderPreview(pane, ctx, job);
  }

  const actions = body.createDiv({ cls: 'vs-detail-actions' });
  if (job.state === 'review') {
    const write = textButton(
      actions,
      '写入笔记',
      async () => {
        if (await ctx.plugin.jobService.writeResult(job)) {
          new Notice('已写入笔记');
          ctx.closeDetail();
        }
      },
      'is-primary is-fill has-icon',
    );
    prependIcon(write, 'check');
  } else if (job.notePath) {
    const open = textButton(actions, '打开笔记', () => ctx.openNote(job.notePath!), 'is-primary is-fill has-icon');
    prependIcon(open, 'file-text');
  }

  // 四个低频写入动作收进"更多"，不再六个按钮平铺
  const more = textButton(actions, '更多', () => undefined, 'has-caret');
  more.addEventListener('click', (event) => {
    showMenu(event as MouseEvent, [
      {
        title: '新建笔记',
        icon: 'file-plus',
        onClick: async () => {
          await ctx.plugin.jobService.createNoteFromResult(job);
          ctx.renderPanels();
        },
      },
      {
        title: '应用到当前笔记',
        icon: 'save',
        onClick: async () => {
          if (job.result) await ctx.plugin.jobService.applyToActiveNote(job.result, job.mode);
        },
      },
      {
        title: '插入当前笔记末尾',
        icon: 'text-cursor-input',
        onClick: async () => {
          if (job.result) await ctx.plugin.jobService.insertIntoActiveNote(job.result);
        },
      },
      {
        title: '复制 JSON',
        icon: 'clipboard',
        onClick: () => {
          void navigator.clipboard.writeText(JSON.stringify(job.result, null, 2));
          new Notice('已复制 JSON');
        },
      },
    ]);
  });
  prependCaret(more);

  if (job.state === 'review') {
    iconButton(
      actions,
      'trash-2',
      '丢弃结果',
      async () => {
        await ctx.plugin.jobService.discardResult(job);
        ctx.closeDetail();
      },
      'vs-icon-btn-boxed is-danger',
    );
  }
}

function prependIcon(button: HTMLElement, icon: string) {
  const holder = createSpan({ cls: 'vs-btn-icon' });
  setIcon(holder, icon);
  button.prepend(holder);
}

function prependCaret(button: HTMLElement) {
  const holder = createSpan({ cls: 'vs-btn-caret' });
  setIcon(holder, 'chevron-down');
  button.append(holder);
}

function renderPreview(body: HTMLElement, ctx: ViewContext, job: Job) {
  const result = job.result;
  if (!result) return;

  const fields: string[] = [];
  if (result.video_title) fields.push('title');
  if (result.video_author) fields.push('author');
  if (result.video_duration) fields.push('duration');
  if (result.summary) fields.push('summary');

  const diff = body.createDiv({ cls: 'vs-write-card' });
  const diffIcon = diff.createDiv({ cls: 'vs-write-icon' });
  setIcon(diffIcon, 'file-diff');
  const diffText = diff.createDiv({ cls: 'vs-write-text' });
  diffText.createDiv({ text: `将写入 frontmatter：${fields.join(' · ') || '无'}` });
  diffText.createDiv({
    text: `正文 ${(result.note || result.summary || '').length.toLocaleString()} 字${
      result.video_transcript ? ` · 文稿 ${result.video_transcript.length.toLocaleString()} 字` : ''
    }`,
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
  const entry = ctx.plugin.noteIndex.getAll().find((item) => item.basename === record.file);
  renderBanner(container, ctx, {
    status: record.result,
    platform: record.platform || entry?.platform,
    cover: entry?.cover,
    duration: entry?.duration,
  });

  const body = container.createDiv({ cls: 'vs-detail-main' });
  body.createDiv({ text: record.file, cls: 'vs-detail-title' });

  const meta = body.createDiv({ cls: 'vs-meta-line' });
  if (record.platform || entry?.platform) {
    const pill = meta.createSpan({ cls: 'vs-meta-pill' });
    pill.createSpan({
      text: platformLabel(record.platform || entry?.platform),
      cls: `vs-platform ${platformClass(record.platform || entry?.platform)}`,
    });
  }
  meta.createSpan({
    text: `${modeLabel(record.mode)}${record.language ? ` · ${languageLabel(record.language)}` : ''}`,
    cls: 'vs-meta-pill',
  });
  const time = parseLocaleTime(record.time);
  meta.createSpan({ text: time ? formatRelative(time) : record.time, cls: 'vs-meta-pill' });
  if (record.durationMs) {
    meta.createSpan({ text: `耗时 ${formatElapsed(record.durationMs)}`, cls: 'vs-meta-pill' });
  }
  if (record.url) body.createDiv({ text: record.url, cls: 'vs-meta-link' });

  if (record.error) {
    const errorBox = body.createDiv({ cls: 'vs-error-box' });
    const icon = errorBox.createDiv({ cls: 'vs-error-icon' });
    setIcon(icon, 'alert-triangle');
    errorBox.createDiv({ text: record.error, cls: 'vs-error-text' });
  } else if (record.result === 'error') {
    body.createDiv({
      text: '这条记录是旧版本写的，没有保存失败原因。重跑一次就能看到具体错误。',
      cls: 'vs-hint',
    });
  }

  const actions = body.createDiv({ cls: 'vs-detail-actions' });
  const file = findNote(ctx, record.file);
  if (file) {
    textButton(actions, '打开笔记', () => ctx.openNote(file.path), 'is-primary is-fill');
    textButton(actions, '重跑（跳过缓存）', async () => {
      await ctx.plugin.jobService.submitFile(file, { ...ctx.submitOptions(), useCache: false });
      ctx.closeDetail();
    });
  } else {
    body.createDiv({ text: `找不到笔记：${record.file}`, cls: 'vs-hint' });
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
