import { MarkdownRenderer, Notice, TFile, setIcon } from 'obsidian';
import { DetailTab, ViewContext } from '../context';
import { Job } from '../../core/JobStore';
import { ProcessingHistory, VideoKnowledgeArtifact } from '../../types';
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
import { normalizeRemoteCoverUrl, platformLabel } from '../../core/NoteIndex';
import {
  renderEvidenceMarkdown,
  sanitizeGeneratedMarkdownActiveResources,
} from '../../core/KnowledgeMarkdown';
import { renderReaderPanel } from './ReaderPanel';

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

  if (ref.kind === 'note') {
    renderStoredArtifactDetail(container, ctx, ref.path, ref.artifactId);
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
    const img = banner.createEl('img', {
      cls: 'vs-banner-img',
      attr: {
        src: options.cover,
        alt: '',
        decoding: 'async',
        referrerpolicy: 'no-referrer',
      },
    });
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

function renderJobDetail(
  container: HTMLElement,
  ctx: ViewContext,
  job: Job,
  persistedArtifact = false,
) {
  const entry = job.notePath ? ctx.plugin.noteIndex.get(job.notePath) : undefined;
  const duration = job.result?.video_duration || entry?.duration;
  const resultCover = safeCoverUrl(job.result?.video_cover);
  if (!resultCover && entry && !entry.cover) ctx.plugin.noteIndex.ensureCover(entry.path);
  if (!resultCover && !entry?.cover && job.input.url) {
    ctx.plugin.noteIndex.ensureCoverForUrl(job.input.url);
  }

  renderBanner(container, ctx, {
    status: job.state,
    platform: job.platform || entry?.platform,
    cover: resultCover || entry?.cover || ctx.plugin.noteIndex.coverForUrl(job.input.url),
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

  renderKnowledgeSignals(body, ctx, job);

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
      { value: 'reader' as DetailTab, label: '陪读' },
      { value: 'evidence' as DetailTab, label: '证据' },
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
    case 'reader':
      renderReaderPanel(pane, ctx, job);
      break;
    case 'evidence':
      renderEvidence(pane, ctx, job);
      break;
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
    const open = textButton(
      actions,
      '打开笔记',
      () => ctx.openNote(job.notePath!),
      'is-primary is-fill has-icon',
    );
    prependIcon(open, 'file-text');
  }

  if (persistedArtifact) {
    const copy = textButton(actions, '复制工件 JSON', () => {
      void navigator.clipboard.writeText(JSON.stringify(job.result, null, 2));
      new Notice('已复制工件 JSON');
    });
    prependIcon(copy, 'clipboard');
  } else {
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
}

function renderStoredArtifactDetail(
  container: HTMLElement,
  ctx: ViewContext,
  notePath: string,
  artifactId: string,
) {
  emptyState(container, 'loader', '正在加载同步陪读…', '从本地 sidecar 恢复时间轴和重点');
  let active = true;
  ctx.registerPanelCleanup(() => {
    active = false;
  });

  void ctx.plugin.artifactStore
    .load(artifactId)
    .then((artifact) => {
      const ref = ctx.state.detail;
      if (
        !active ||
        ref?.kind !== 'note' ||
        ref.path !== notePath ||
        ref.artifactId !== artifactId
      ) {
        return;
      }
      container.empty();
      renderJobDetail(container, ctx, artifactToJob(artifact, notePath), true);
    })
    .catch((error) => {
      if (!active) return;
      container.empty();
      emptyState(
        container,
        'alert-triangle',
        '无法打开同步陪读',
        error instanceof Error ? error.message : String(error),
      );
      const actions = container.createDiv({ cls: 'vs-detail-actions' });
      textButton(actions, '返回笔记库', () => ctx.closeDetail(), 'is-primary');
      textButton(actions, '打开笔记', () => ctx.openNote(notePath));
    });
}

function artifactToJob(artifact: VideoKnowledgeArtifact, notePath: string): Job {
  const createdAt = Date.parse(artifact.created_at) || Date.now();
  const endedAt = Date.parse(artifact.updated_at) || createdAt;
  return {
    id: `artifact-${artifact.artifact_id}`,
    title: artifact.title || notePath.split('/').pop()?.replace(/\.md$/i, '') || '视频工件',
    notePath,
    input: {
      url: artifact.source.url,
      localFile: artifact.source.local_file,
      artifactId: artifact.artifact_id,
      processingDepth: artifact.provenance.processing_depth,
    },
    mode: 'summary',
    language: 'zh',
    useCache: true,
    state: 'success',
    createdAt,
    endedAt,
    logs: [],
    platform: artifact.platform,
    result: {
      video_title: artifact.title,
      video_author: artifact.author,
      video_duration: artifact.duration,
      video_cover: artifact.cover,
      video_platform: artifact.platform,
      video_transcript: artifact.transcript,
      transcript_source: artifact.provenance.transcript_source,
      timing_quality: artifact.timing_quality,
      video_segments: artifact.segments,
      evidence_claims: artifact.claims,
      visual_evidence: artifact.visual_evidence,
      content_type: artifact.content_type,
      attention: artifact.attention,
      learning: artifact.learning,
      related_notes: artifact.related_notes,
      artifact: {
        ...artifact.provenance,
        artifact_id: artifact.artifact_id,
        source_url: artifact.source.url,
        source_hash: artifact.source.source_hash,
      },
    },
  };
}

function renderKnowledgeSignals(body: HTMLElement, ctx: ViewContext, job: Job) {
  const result = job.result;
  if (!result) return;
  const hasSignals =
    result.content_type ||
    result.attention ||
    result.visual_evidence?.length ||
    result.learning ||
    job.input.processingDepth;
  if (!hasSignals) return;

  const signals = body.createDiv({ cls: 'vs-knowledge-signals' });
  if (result.content_type) {
    const route = signals.createDiv({ cls: 'vs-signal' });
    const icon = route.createSpan({ cls: 'vs-signal-icon' });
    setIcon(icon, 'route');
    route.createSpan({ text: `结构 · ${contentTypeLabel(result.content_type)}` });
  }
  if (result.attention) {
    const decision = signals.createDiv({
      cls: `vs-signal is-attention is-${result.attention.action}`,
    });
    const icon = decision.createSpan({ cls: 'vs-signal-icon' });
    setIcon(
      icon,
      result.attention.action === 'watch'
        ? 'eye'
        : result.attention.action === 'skim'
          ? 'scan'
          : 'skip-forward',
    );
    const score =
      typeof result.attention.score === 'number'
        ? ` · ${Math.round(result.attention.score * 100)}`
        : '';
    decision.createSpan({ text: `${attentionLabel(result.attention.action)}${score}` });
  }
  if (result.visual_evidence?.length) {
    const visual = signals.createDiv({ cls: 'vs-signal is-visual' });
    const icon = visual.createSpan({ cls: 'vs-signal-icon' });
    setIcon(icon, 'scan-eye');
    visual.createSpan({ text: `真实画面证据 · ${result.visual_evidence.length}` });
  }
  const learningCount =
    (result.learning?.flashcards?.length || 0) + (result.learning?.questions?.length || 0);
  if (learningCount > 0) {
    const learning = signals.createDiv({ cls: 'vs-signal is-learning' });
    const icon = learning.createSpan({ cls: 'vs-signal-icon' });
    setIcon(icon, 'graduation-cap');
    learning.createSpan({ text: `学习练习 · ${learningCount}` });
  }

  if (result.attention) {
    const card = body.createDiv({
      cls: `vs-attention-card is-${result.attention.action}`,
    });
    const heading = card.createDiv({ cls: 'vs-attention-heading' });
    heading.createSpan({ text: attentionLabel(result.attention.action) });
    if (typeof result.attention.confidence === 'number') {
      heading.createSpan({
        text: `置信 ${Math.round(result.attention.confidence * 100)}%`,
        cls: 'vs-attention-confidence',
      });
    }
    card.createDiv({ text: result.attention.rationale, cls: 'vs-attention-rationale' });
    const ranges = result.attention.must_watch || [];
    if (ranges.length > 0) {
      card.createDiv({
        text: `优先看 ${ranges
          .slice(0, 3)
          .map((range) => `${formatShortTime(range.start)}–${formatShortTime(range.end)}`)
          .join('、')}`,
        cls: 'vs-attention-ranges',
      });
    }
    if (result.attention.limitations?.length) {
      card.createDiv({
        text: `限制：${result.attention.limitations.slice(0, 2).join('；')}`,
        cls: 'vs-hint',
      });
    }
  }

  if (job.state !== 'success' && job.state !== 'review') return;
  const depth = job.input.processingDepth || result.artifact?.processing_depth || 'quick';
  const actionRow = body.createDiv({ cls: 'vs-signal-actions' });
  if (!result.attention) {
    textButton(
      actionRow,
      '先做观看判断',
      () => queueKnowledgeUpgrade(ctx, job, 'quick'),
      'has-icon',
    );
  }
  if (depth !== 'deep-visual' && !result.visual_evidence?.length) {
    const upgrade = textButton(
      actionRow,
      '深度看画面',
      () => queueKnowledgeUpgrade(ctx, job, 'deep-visual'),
      'has-icon',
    );
    prependIcon(upgrade, 'scan-eye');
  }
  if (learningCount > 0 && job.notePath) {
    const review = textButton(
      actionRow,
      `开始复习 · ${learningCount}`,
      () => {
        const file = ctx.plugin.app.vault.getAbstractFileByPath(job.notePath || '');
        if (!(file instanceof TFile)) {
          new Notice('目标笔记已不存在');
          return;
        }
        void ctx.plugin.openLearningReviewForFile(file);
      },
      'has-icon',
    );
    prependIcon(review, 'graduation-cap');
  } else if (learningCount === 0 && job.notePath) {
    const generate = textButton(
      actionRow,
      '生成学习卡',
      () => queueLearningUpgrade(ctx, job),
      'has-icon',
    );
    prependIcon(generate, 'graduation-cap');
  }
  if (actionRow.childElementCount === 0) actionRow.remove();
}

async function queueKnowledgeUpgrade(ctx: ViewContext, job: Job, depth: 'quick' | 'deep-visual') {
  if (depth === 'deep-visual' && ctx.plugin.settings.activeBackend !== 'codex-worker') {
    new Notice('内置 n8n 工作流尚未接通安全的画面凭据。请先在设置中切换 Codex Worker。', 7000);
    return;
  }
  if (!job.notePath) {
    new Notice('先把结果保存为笔记，才能追加处理');
    return;
  }
  const file = ctx.plugin.app.vault.getAbstractFileByPath(job.notePath);
  if (!(file instanceof TFile)) {
    new Notice('目标笔记已不存在');
    return;
  }
  const queued = await ctx.plugin.jobService.submitFile(file, {
    ...ctx.submitOptions(),
    processingDepth: depth,
    attentionAssessment: true,
    generateLearning: false,
    previewBeforeWrite: true,
    useCache: true,
  });
  if (!queued) return;
  ctx.state.tab = 'jobs';
  ctx.closeDetail();
  new Notice(depth === 'deep-visual' ? '已提交深度画面分析' : '已提交快速观看判断');
}

async function queueLearningUpgrade(ctx: ViewContext, job: Job) {
  if (!job.notePath) {
    new Notice('先把结果保存为笔记，才能生成学习卡');
    return;
  }
  const file = ctx.plugin.app.vault.getAbstractFileByPath(job.notePath);
  if (!(file instanceof TFile)) {
    new Notice('目标笔记已不存在');
    return;
  }
  const queued = await ctx.plugin.jobService.submitFile(file, {
    ...ctx.submitOptions(),
    processingDepth: job.input.processingDepth || 'evidence',
    attentionAssessment: Boolean(job.result?.attention),
    generateLearning: true,
    previewBeforeWrite: true,
    useCache: true,
  });
  if (!queued) return;
  ctx.state.tab = 'jobs';
  ctx.closeDetail();
  new Notice('已提交学习卡生成任务');
}

function contentTypeLabel(type: string): string {
  return (
    {
      course: '课程',
      interview: '访谈',
      tutorial: '教程',
      news: '新闻',
      meeting: '会议',
      review: '评测',
      general: '通用',
    }[type] || type
  );
}

function attentionLabel(action: 'watch' | 'skim' | 'skip'): string {
  return {
    watch: '值得完整观看',
    skim: '建议选段浏览',
    skip: '可以跳过',
  }[action];
}

function formatShortTime(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const remainder = safe % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function renderEvidence(container: HTMLElement, ctx: ViewContext, job: Job) {
  if (!job.result) return;
  const markdown = renderEvidenceMarkdown(
    job.result,
    job.input.url || job.result.artifact?.source_url,
  );
  const markdownEl = container.createDiv({ cls: 'vs-markdown vs-evidence-map' });
  void MarkdownRenderer.render(
    ctx.plugin.app,
    markdown,
    markdownEl,
    job.notePath || '',
    ctx.plugin,
  );
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

  const markdown = sanitizeGeneratedMarkdownActiveResources(
    [
      result.summary ? `## 总结\n\n${result.summary}` : '',
      result.note ? `## 笔记\n\n${result.note}` : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
  );

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
  if (entry && !entry.cover) ctx.plugin.noteIndex.ensureCover(entry.path);
  if (!entry?.cover && record.url) ctx.plugin.noteIndex.ensureCoverForUrl(record.url);
  renderBanner(container, ctx, {
    status: record.result,
    platform: record.platform || entry?.platform,
    cover: entry?.cover || ctx.plugin.noteIndex.coverForUrl(record.url),
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

function safeCoverUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cover = value.trim();
  if (!cover) return undefined;
  return normalizeRemoteCoverUrl(cover);
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
