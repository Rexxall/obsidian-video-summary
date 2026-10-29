import { Notice, TFile, TFolder, setIcon } from 'obsidian';
import { ViewContext } from '../context';
import {
  iconButton,
  languageLabel,
  modeLabel,
  platformText,
  segmented,
  showMenu,
  statusMeta,
  textButton,
} from '../ui';
import { platformLabel } from '../../core/NoteIndex';
import { expandParts, isAbsoluteLocalPath, parseInput } from '../../core/InputParser';
import { FolderSelectModal } from '../../modals/FolderSelectModal';
import {
  ProcessingDepth,
  ProcessingMode,
  RequestedContentType,
  SupportedLanguage,
} from '../../types';
import { VideoUtils } from '../../utils/VideoUtils';
import { liveJobForNote, noteDisplayStatus } from '../noteStatus';

import { fire } from '../../utils/fire';
import { errorMessage } from '../../utils/errors';
const BACKEND_PROBE_TIMEOUT_MS = 8_000;
const BACKEND_ONLINE_TTL_MS = 5 * 60_000;
const BACKEND_OFFLINE_TTL_MS = 60_000;

interface BackendInfo {
  key: string;
  label: string;
  endpoint: string;
}

interface BackendProbeResult {
  state: 'is-online' | 'is-offline';
  checkedAt: number;
  /** true = 完整响应诊断通过；false = 只确认端点可达 */
  verified?: boolean;
  durationMs?: number;
  reason?: string;
}

interface BackendProbeCache {
  key: string;
  result?: BackendProbeResult;
  pending?: Promise<BackendProbeResult>;
}

/** 探测缓存跟随插件实例；视图重绘或关闭重开都不会重复请求。 */
const backendProbeCaches = new WeakMap<object, BackendProbeCache>();

/** “选项”行右侧的摘要：只要文稿 / 总结（极速）/ 证据（保留时间轴）。 */
type QuickMode = 'transcript' | 'summary' | 'evidence';

function currentQuickMode(ctx: ViewContext): QuickMode | null {
  const settings = ctx.plugin.settings;
  if (settings.defaultMode === 'transcript-only') return 'transcript';
  if (settings.defaultMode !== 'summary') return null;
  return settings.defaultProcessingDepth === 'quick' ? 'summary' : 'evidence';
}

/**
 * 顶部：标题、后端状态，然后是添加框（“开始”在框内）。
 * 模式、学习卡、语言、模型、保存位置收进一行“选项”展开行；少用的命令在标题旁的“···”。
 */
export function renderActionBar(container: HTMLElement, ctx: ViewContext) {
  const { state } = ctx;
  const root = container.createDiv({ cls: 'vs-action-bar' });

  renderHeader(root, ctx);

  // 最上面是添加框，“开始”就在框里右下角
  const box = root.createDiv({ cls: 'vs-add' });
  const input = box.createEl('textarea', {
    cls: 'vs-input',
    attr: {
      rows: '2',
      placeholder: '粘贴链接、拖入音视频，或直接粘贴文稿',
      'aria-label': '添加视频',
    },
  });
  input.value = state.inputDraft;
  input.addEventListener('input', () => {
    state.inputDraft = input.value;
  });
  autoGrow(input);
  const boxBar = box.createDiv({ cls: 'vs-add-bar' });
  boxBar.createSpan({ cls: 'vs-add-hint', text: '多行即批量 · ⌘ Enter 开始' });
  iconButton(
    boxBar,
    'folder-open',
    '选择本机音视频',
    () => pickLocalFiles(ctx, input),
    'vs-add-file',
  );
  const submitBtn = boxBar.createEl('button', {
    text: '开始',
    cls: 'vs-primary-btn',
    attr: { type: 'button' },
  });
  bindFileDrop(box, ctx, input);

  // 模式、学习卡和其余默认值收进一行“选项”展开行，右侧写当前选择
  const quick = currentQuickMode(ctx);
  const quickLabels: Record<QuickMode, string> = {
    transcript: '只要文稿',
    summary: '总结',
    evidence: '证据',
  };
  const fold = root.createDiv({ cls: `vs-fold${state.advancedOpen ? ' is-open' : ''}` });
  const foldToggle = fold.createEl('button', {
    cls: 'vs-fold-toggle',
    attr: { type: 'button', 'aria-expanded': state.advancedOpen ? 'true' : 'false' },
  });
  foldToggle.createSpan({ text: '选项', cls: 'vs-fold-title' });
  foldToggle.createSpan({
    cls: 'vs-fold-value',
    text: [
      quick ? quickLabels[quick] : modeLabel(ctx.plugin.settings.defaultMode),
      ctx.plugin.settings.generateLearningArtifacts ? '学习卡' : '',
    ]
      .filter(Boolean)
      .join(' · '),
  });
  setIcon(foldToggle.createSpan({ cls: 'vs-fold-chevron' }), 'chevron-right');
  foldToggle.addEventListener('click', () => {
    state.advancedOpen = !state.advancedOpen;
    ctx.renderAll();
  });
  const foldBody = fold.createDiv({ cls: 'vs-fold-body' });

  // 处理方式与理解深度在下面的默认值里各一行，这里只放学习卡开关
  const controls = foldBody.createDiv({ cls: 'vs-add-controls' });
  const learn = controls.createEl('label', { cls: 'vs-check' });
  const learnBox = learn.createEl('input', { attr: { type: 'checkbox' } });
  learnBox.checked = ctx.plugin.settings.generateLearningArtifacts;
  learn.createSpan({ text: '学习卡' });
  learnBox.addEventListener(
    'change',
    fire(async () => {
      ctx.plugin.settings.generateLearningArtifacts = learnBox.checked;
      ctx.plugin.api.setAnalysisDefaults({ generateLearning: learnBox.checked });
      await ctx.plugin.saveSettings();
      ctx.renderAll();
    }),
  );

  renderOptions(foldBody, ctx);
  const advancedFields = renderAdvanced(foldBody, ctx, input);

  renderContextStrip(root, ctx);

  submitBtn.addEventListener(
    'click',
    fire(async () => {
      submitBtn.disabled = true;
      try {
        await submit(ctx, input, advancedFields);
      } finally {
        submitBtn.disabled = false;
      }
    }),
  );

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submitBtn.click();
    }
  });
}

/** 拖进来的本机文件只取文件名：后端（docker/n8n）只认 uploads 目录里的文件名 */
function bindFileDrop(box: HTMLElement, ctx: ViewContext, input: HTMLTextAreaElement) {
  box.addEventListener('dragover', (event) => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    box.addClass('is-drop');
  });
  box.addEventListener('dragleave', () => box.removeClass('is-drop'));
  box.addEventListener('drop', (event) => {
    box.removeClass('is-drop');
    const names = Array.from(event.dataTransfer?.files || [])
      .map((file) => file.name)
      .filter(Boolean);
    if (names.length === 0) return;
    event.preventDefault();
    appendFileNames(ctx, input, names);
  });
}

function renderHeader(root: HTMLElement, ctx: ViewContext) {
  const header = root.createDiv({ cls: 'vs-header' });
  header.createSpan({ text: '视频总结', cls: 'vs-header-title' });
  iconButton(
    header,
    'more-horizontal',
    '更多',
    (event) => showMoreMenu(ctx, event),
    'vs-header-more',
  );

  const backend = activeBackendInfo(ctx);
  const cachedResult = freshProbeResult(ctx, backend);
  const cachedEntry = backendProbeCaches.get(ctx.plugin);
  const initialState =
    cachedEntry?.key === backend.key && cachedEntry.pending
      ? 'is-checking'
      : cachedResult?.state || 'is-unknown';
  ctx.setBackendState(initialState);

  const statusLine = root.createEl('button', {
    cls: 'vs-backend-line',
    attr: { type: 'button' },
  });
  const dot = statusLine.createSpan({ cls: 'vs-backend-dot' });
  const label = statusLine.createSpan();
  updateBackendPill(statusLine, dot, label, backend, initialState, cachedResult);

  statusLine.addEventListener(
    'click',
    fire(async (event) => {
      event.preventDefault();
      if (ctx.backendState() === 'is-checking') return;

      ctx.setBackendState('is-checking');
      updateBackendPill(statusLine, dot, label, backend, 'is-checking');
      const result = await probeBackend(ctx, backend, true);
      updateBackendPill(statusLine, dot, label, backend, result.state, result);
      new Notice(
        result.state === 'is-online'
          ? `${backend.label} 连接正常（${result.durationMs ?? 0}ms）`
          : `${backend.label} 连接失败：${result.reason || '未知原因'}`,
        result.state === 'is-online' ? 3000 : 6000,
      );
      ctx.renderAll();
    }),
  );

  // 首次打开或缓存过期时才自动检测；重绘会复用 pending/result，不重复发请求。
  if (initialState === 'is-unknown' || initialState === 'is-checking') {
    ctx.setBackendState('is-checking');
    updateBackendPill(statusLine, dot, label, backend, 'is-checking');
    void probeBackend(ctx, backend).then((result) => {
      ctx.setBackendState(result.state);
      ctx.renderAll();
    });
  }
}

/** “···”：不常用但保留的入口，都转给已有命令 */
function showMoreMenu(ctx: ViewContext, event: MouseEvent) {
  const run = (id: string) => {
    const commands = (
      ctx.plugin.app as unknown as { commands?: { executeCommandById(id: string): boolean } }
    ).commands;
    commands?.executeCommandById(`${ctx.plugin.manifest.id}:${id}`);
  };
  showMenu(event, [
    { title: '批量处理视频', icon: 'list-plus', onClick: () => run('batch') },
    { title: '处理所有待处理视频', icon: 'zap', onClick: () => run('process-all-pending') },
    { title: '复习到期的学习卡', icon: 'brain', onClick: () => run('learning-review-due') },
    { title: '搜索跨模态视频记忆', icon: 'search', onClick: () => run('memory-search') },
    { title: '多视频论点实验室', icon: 'flask-conical', onClick: () => run('claim-lab') },
    { title: '生成或更新视频库 Base', icon: 'table', onClick: () => run('generate-base') },
    { title: '测试处理后端', icon: 'plug', onClick: () => run('test-connection') },
    {
      title: '打开 Codex Worker 控制台',
      icon: 'gauge',
      disabled: ctx.plugin.settings.activeBackend !== 'codex-worker',
      onClick: () => run('open-worker-dashboard'),
    },
    { title: '插件设置', icon: 'settings', onClick: () => openSettings(ctx) },
  ]);
}

export function openSettings(ctx: ViewContext) {
  const settingApi = (
    ctx.plugin.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }
  ).setting;
  if (settingApi) {
    settingApi.open();
    settingApi.openTabById(ctx.plugin.manifest.id);
  }
}

function activeBackendInfo(ctx: ViewContext): BackendInfo {
  const isWorker = ctx.plugin.settings.activeBackend === 'codex-worker';
  const endpoint = (
    (isWorker ? ctx.plugin.settings.codexWorkerUrl : ctx.plugin.settings.n8nWebhookUrl) || ''
  ).trim();
  return {
    key: `${isWorker ? 'codex-worker' : 'n8n'}:${endpoint}`,
    label: isWorker ? 'Codex Worker' : 'n8n',
    endpoint,
  };
}

function freshProbeResult(ctx: ViewContext, backend: BackendInfo): BackendProbeResult | undefined {
  const cached = backendProbeCaches.get(ctx.plugin);
  if (!cached || cached.key !== backend.key || !cached.result) return undefined;
  const ttl = cached.result.state === 'is-online' ? BACKEND_ONLINE_TTL_MS : BACKEND_OFFLINE_TTL_MS;
  return Date.now() - cached.result.checkedAt < ttl ? cached.result : undefined;
}

async function probeBackend(
  ctx: ViewContext,
  backend: BackendInfo,
  force = false,
): Promise<BackendProbeResult> {
  let cached = backendProbeCaches.get(ctx.plugin);
  if (!cached || cached.key !== backend.key) {
    cached = { key: backend.key };
    backendProbeCaches.set(ctx.plugin, cached);
  }

  if (cached.pending) return cached.pending;
  if (!force) {
    const fresh = freshProbeResult(ctx, backend);
    if (fresh) return fresh;
  }

  const pending = (async (): Promise<BackendProbeResult> => {
    const checkedAt = Date.now();
    if (!backend.endpoint) {
      return { state: 'is-offline', checkedAt, reason: '未配置服务地址' };
    }

    try {
      if (force) {
        // 用户主动点击时跑完整诊断；它能返回耗时和更精确的 workflow 原因。
        const test = await withTimeout(ctx.plugin.api.testConnection(), BACKEND_PROBE_TIMEOUT_MS);
        return test.success
          ? {
              state: 'is-online',
              checkedAt: Date.now(),
              verified: true,
              durationMs: test.durationMs,
            }
          : {
              state: 'is-offline',
              checkedAt: Date.now(),
              verified: true,
              durationMs: test.durationMs,
              reason: summarizeBackendFailure(test.error || test.hint || '', backend.endpoint),
            };
      }

      // 自动探测只走已有的 4 秒 quick health check，不做完整 workflow 诊断。
      const health = await ctx.plugin.api.quickHealthCheck();
      return health.ok
        ? { state: 'is-online', checkedAt: Date.now(), verified: false }
        : {
            state: 'is-offline',
            checkedAt: Date.now(),
            verified: false,
            reason: summarizeBackendFailure(health.error || '', backend.endpoint),
          };
    } catch (error) {
      return {
        state: 'is-offline',
        checkedAt: Date.now(),
        reason: summarizeBackendFailure(
          error instanceof Error ? errorMessage(error) : String(error),
          backend.endpoint,
        ),
      };
    }
  })();

  cached.pending = pending;
  ctx.setBackendState('is-checking');
  const result = await pending;
  cached.result = result;
  cached.pending = undefined;
  ctx.setBackendState(result.state);
  return result;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer = 0;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = window.setTimeout(() => reject(new Error('连接超时')), timeoutMs);
    });
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) window.clearTimeout(timer);
  }
}

function updateBackendPill(
  pill: HTMLElement,
  dot: HTMLElement,
  label: HTMLElement,
  backend: BackendInfo,
  state: string,
  result?: BackendProbeResult,
) {
  dot.className = `vs-backend-dot ${state}`;
  if (state === 'is-checking') {
    label.setText(`正在检测 ${backend.label}…`);
    pill.setAttr('title', `${backend.label}：正在检测连接`);
    return;
  }
  if (state === 'is-online') {
    const reachabilityOnly = result?.verified === false;
    label.setText(`${backend.label} 已连接`);
    pill.setAttr(
      'title',
      `${backend.label} ${
        reachabilityOnly ? '端点可达，尚未验证完整响应' : '在线'
      }${result?.durationMs !== undefined ? ` · ${result.durationMs}ms` : ''}${
        result ? ` · 最近检测 ${formatProbeTime(result.checkedAt)}` : ''
      }；点击运行完整检测`,
    );
    return;
  }
  if (state === 'is-offline') {
    const reason = result?.reason || '无法连接';
    label.setText(`${backend.label} 未连接 · ${reason}`);
    pill.setAttr(
      'title',
      `${backend.label} 离线：${reason}${
        result ? ` · 最近检测 ${formatProbeTime(result.checkedAt)}` : ''
      }；点击重新检测`,
    );
    return;
  }
  label.setText(`${backend.label} 未检测 · 点此测试`);
  pill.setAttr('title', `${backend.label}：点击测试连接`);
}

function formatProbeTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** 连接状态同样只显示分类后的安全原因，避免把 webhook URL 或本机路径带到页头。 */
function summarizeBackendFailure(raw: string, endpoint = ''): string {
  const error = raw.toLowerCase();
  if (!error) return '未知原因';
  if (/空响应|empty response|no response body/.test(error)) return '空响应';
  if (/404|webhook.*(?:不存在|not found)|workflow.*(?:未激活|inactive)/.test(error)) {
    return '流程未启用';
  }
  if (/401|unauthorized|api.?key|鉴权|授权失败/.test(error)) return '授权失败';
  if (/403|forbidden|拒绝访问/.test(error)) return '访问被拒绝';
  if (/429|rate.?limit|too many requests|限流/.test(error)) return '请求过频';
  if (/json|返回格式|unexpected token/.test(error)) return '格式异常';
  if (/timeout|timed out|etimedout|超时|abort/.test(error)) return '连接超时';
  if (/econnrefused|enotfound|network|failed to fetch|fetch failed|无法连接|连接失败/.test(error)) {
    if (/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(endpoint)) {
      return '本机服务未启动';
    }
    return '无法连接';
  }
  return '检测失败';
}

/** 当前笔记上下文条：侧栏里直接看到正在编辑的这篇处于什么状态 */
function renderContextStrip(root: HTMLElement, ctx: ViewContext) {
  const activeFile = ctx.plugin.app.workspace.getActiveFile();
  if (!activeFile || activeFile.extension !== 'md') return;

  const entry = ctx.plugin.noteIndex.get(activeFile.path);
  const frontmatter = ctx.plugin.app.metadataCache.getFileCache(activeFile)?.frontmatter;
  const isVideoNote = entry !== undefined || VideoUtils.isVideoNoteFromFrontmatter(frontmatter);
  if (!isVideoNote) return;

  const status = entry ? noteDisplayStatus(entry, ctx.plugin.jobs) : 'pending';
  const meta = statusMeta(status);
  const strip = root.createDiv({ cls: 'vs-context-strip' });
  const icon = strip.createDiv({ cls: 'vs-context-icon' });
  setIcon(icon, 'file-text');

  const body = strip.createDiv({ cls: 'vs-context-body' });
  body.createDiv({ text: activeFile.basename, cls: 'vs-context-title' });
  const sub = body.createDiv({ cls: 'vs-context-sub' });
  sub.createSpan({ text: '当前笔记 · ' });
  sub.createSpan({ text: meta.label, cls: `vs-state-text ${meta.cls}` });
  if (entry?.platform) {
    sub.createSpan({ text: ' · ' });
    platformText(sub, entry.platform, platformLabel(entry.platform));
  }

  const liveJob = entry ? liveJobForNote(ctx.plugin.jobs, entry.path) : undefined;
  if (entry?.artifactId && status === 'success') {
    const artifactId = entry.artifactId;
    textButton(
      strip,
      '陪读',
      () => ctx.openDetail({ kind: 'note', path: entry.path, artifactId }),
      'vs-context-action',
    );
  }
  if (status === 'review' && liveJob) {
    textButton(
      strip,
      '确认',
      () => ctx.openDetail({ kind: 'job', id: liveJob.id }),
      'vs-context-action',
    );
  } else if (status !== 'running' && status !== 'queued') {
    textButton(
      strip,
      status === 'success' || status === 'interrupted' ? '重跑' : '处理',
      fire(async () => {
        await ctx.plugin.jobService.submitFile(activeFile, ctx.submitOptions());
        ctx.state.tab = 'jobs';
        ctx.renderPanels();
      }),
      'vs-context-action',
    );
  }
}

/** “选项”展开行里的默认值：一行一个，标签在左，当前值在右 */
function renderOptions(container: HTMLElement, ctx: ViewContext) {
  const { plugin } = ctx;
  const settings = plugin.settings;
  const row = (label: string) => {
    const el = container.createDiv({ cls: 'vs-opt' });
    el.createSpan({ text: label, cls: 'vs-opt-label' });
    return el.createDiv({ cls: 'vs-opt-value' });
  };

  const modeHost = row('处理方式');
  segmented<ProcessingMode>(
    modeHost,
    (['summary', 'transcript-only', 'info-only'] as ProcessingMode[]).map((mode) => ({
      value: mode,
      label: modeLabel(mode),
    })),
    settings.defaultMode,
    fire(async (mode) => {
      settings.defaultMode = mode;
      await plugin.saveSettings();
      ctx.renderAll();
    }),
  );

  const depthLabels: Record<ProcessingDepth, string> = {
    quick: '极速',
    evidence: '证据',
    'deep-visual': '深度视觉',
  };
  segmented<ProcessingDepth>(
    row('理解深度'),
    (['quick', 'evidence', 'deep-visual'] as ProcessingDepth[]).map((depth) => ({
      value: depth,
      label: depthLabels[depth],
    })),
    settings.defaultProcessingDepth,
    fire(async (depth) => {
      if (depth === 'deep-visual' && settings.activeBackend !== 'codex-worker') {
        new Notice('深度视觉只由 Codex Worker 执行；当前 n8n 后端可用到证据模式。', 7000);
        return;
      }
      settings.defaultProcessingDepth = depth;
      plugin.api.setAnalysisDefaults({ processingDepth: depth });
      await plugin.saveSettings();
      ctx.renderAll();
    }),
  );

  segmented<SupportedLanguage>(
    row('输出语言'),
    (['zh', 'en', 'ja'] as SupportedLanguage[]).map((language) => ({
      value: language,
      label: languageLabel(language),
    })),
    settings.defaultLanguage,
    fire(async (language) => {
      settings.defaultLanguage = language;
      await plugin.saveSettings();
      ctx.renderAll();
    }),
  );

  const contentLabels: Record<RequestedContentType, string> = {
    auto: '自动识别',
    course: '课程',
    interview: '访谈',
    tutorial: '教程',
    news: '新闻',
    meeting: '会议',
    review: '评测',
    general: '通用',
  };
  const contentSelect = row('内容类型').createEl('select', { cls: 'dropdown' });
  (Object.keys(contentLabels) as RequestedContentType[]).forEach((value) =>
    contentSelect.createEl('option', { text: contentLabels[value], attr: { value } }),
  );
  contentSelect.value = settings.defaultContentType;
  contentSelect.addEventListener(
    'change',
    fire(async () => {
      const contentType = contentSelect.value as RequestedContentType;
      settings.defaultContentType = contentType;
      settings.autoRouteContent = contentType === 'auto';
      plugin.api.setAnalysisDefaults({ contentType, autoRoute: settings.autoRouteContent });
      await plugin.saveSettings();
    }),
  );

  const models = (
    settings.customAiModels?.length ? settings.customAiModels : [settings.aiModel]
  ).filter(Boolean);
  const modelSelect = row('处理模型').createEl('select', { cls: 'dropdown' });
  models.forEach((model) =>
    modelSelect.createEl('option', { text: model, attr: { value: model } }),
  );
  modelSelect.value = settings.aiModel || models[0] || '';
  modelSelect.addEventListener(
    'change',
    fire(async () => {
      settings.aiModel = modelSelect.value;
      plugin.api.setAiModel(modelSelect.value);
      await plugin.saveSettings();
    }),
  );

  const folderBtn = row('保存位置').createEl('button', {
    text: shortenPath(settings.outputFolder || '当前文件夹'),
    cls: 'vs-link-btn',
    attr: { type: 'button', title: settings.outputFolder || '当前文件夹' },
  });
  folderBtn.addEventListener('click', (event) => {
    event.preventDefault();
    const folders = plugin.app.vault
      .getAllLoadedFiles()
      .filter((file): file is TFolder => file instanceof TFolder)
      .map((folder) => folder.path)
      .sort();
    new FolderSelectModal(
      plugin.app,
      folders,
      fire(async (selected: string) => {
        settings.outputFolder = selected;
        await plugin.saveSettings();
        ctx.renderAll();
      }),
    ).open();
  });

  const toggles = container.createDiv({ cls: 'vs-opt-checks' });
  const check = (
    label: string,
    title: string,
    value: boolean,
    onChange: (value: boolean) => Promise<void>,
  ) => {
    const el = toggles.createEl('label', { cls: 'vs-check', attr: { title } });
    const box = el.createEl('input', { attr: { type: 'checkbox' } });
    box.checked = value;
    el.createSpan({ text: label });
    box.addEventListener('change', () => void onChange(box.checked));
  };
  check(
    '先预览再写入',
    '结果先预览，确认后才写入笔记',
    settings.previewBeforeWrite === true,
    async (value) => {
      settings.previewBeforeWrite = value;
      await plugin.saveSettings();
    },
  );
  check(
    '观看判断',
    '输出值得看、建议略读或可以跳过',
    settings.attentionAssessmentEnabled,
    async (value) => {
      settings.attentionAssessmentEnabled = value;
      plugin.api.setAnalysisDefaults({ attentionAssessment: value });
      await plugin.saveSettings();
    },
  );
  check(
    '这次跳过缓存',
    '强制重新处理，只对本次打开的侧栏有效',
    ctx.state.ignoreCache,
    async (value) => {
      ctx.state.ignoreCache = value;
    },
  );
}

interface AdvancedFields {
  transcript: HTMLTextAreaElement;
  localFile: HTMLInputElement;
  partsToggle: HTMLInputElement;
  partsStart: HTMLInputElement;
  partsEnd: HTMLInputElement;
}

function renderAdvanced(
  container: HTMLElement,
  ctx: ViewContext,
  mainInput: HTMLTextAreaElement,
): AdvancedFields {
  const { plugin } = ctx;
  const profiles = plugin.settings.webhookProfiles || [];
  if (profiles.length > 1) {
    const backendRow = container.createDiv({ cls: 'vs-field' });
    backendRow.createEl('label', { text: '处理后端', cls: 'vs-field-label' });
    const backendSelect = backendRow.createEl('select', { cls: 'vs-field-input' });
    profiles.forEach((profile) => {
      backendSelect.createEl('option', {
        text: profile.name || profile.url,
        attr: { value: profile.id },
      });
    });
    backendSelect.value = plugin.settings.activeWebhookId || profiles[0]?.id || '';
    backendSelect.addEventListener(
      'change',
      fire(async () => {
        await plugin.setActiveWebhook(backendSelect.value, { silent: false });
        ctx.renderAll();
      }),
    );
  }

  const transcriptRow = container.createDiv({ cls: 'vs-field' });
  transcriptRow.createEl('label', { text: '手动文稿', cls: 'vs-field-label' });
  const transcript = transcriptRow.createEl('textarea', {
    cls: 'vs-field-input vs-transcript-input',
    attr: { rows: '3', placeholder: '视频没有字幕时，在这里贴文稿' },
  });
  transcript.value = ctx.state.transcriptDraft;
  transcript.addEventListener('input', () => {
    ctx.state.transcriptDraft = transcript.value;
  });

  const localRow = container.createDiv({ cls: 'vs-field' });
  localRow.createEl('label', { text: '本地文件', cls: 'vs-field-label' });
  const localFile = localRow.createEl('input', {
    cls: 'vs-field-input',
    attr: { type: 'text', placeholder: 'lecture-01.mp4，多个用逗号分隔' },
  });
  localFile.value = ctx.state.localFileDraft;
  localFile.addEventListener('input', () => {
    ctx.state.localFileDraft = localFile.value;
  });
  localRow.createDiv({
    text: 'Docker/n8n 场景请把文件放进 docker/uploads，这里只填文件名或相对路径。',
    cls: 'vs-field-hint',
  });
  localFile.addEventListener('blur', () => {
    if (isAbsoluteLocalPath(localFile.value)) {
      new Notice('这看起来是绝对路径。Docker 场景请改填 uploads 里的文件名或相对路径。');
    }
  });

  const partsRow = container.createDiv({ cls: 'vs-field vs-field-inline' });
  const partsToggle = partsRow.createEl('input', {
    attr: { type: 'checkbox', id: 'vs-parts-toggle' },
  });
  partsToggle.checked = ctx.state.partsEnabled;
  partsRow.createEl('label', {
    text: '按分P范围展开',
    attr: { for: 'vs-parts-toggle' },
    cls: 'vs-field-label',
  });
  const partsStart = partsRow.createEl('input', {
    cls: 'vs-num-input',
    attr: { type: 'number', min: '1', max: '1000', value: String(ctx.state.partsStart) },
  });
  partsRow.createSpan({ text: '到', cls: 'vs-field-hint' });
  const partsEnd = partsRow.createEl('input', {
    cls: 'vs-num-input',
    attr: { type: 'number', min: '1', max: '1000', value: String(ctx.state.partsEnd) },
  });
  partsToggle.addEventListener('change', () => {
    ctx.state.partsEnabled = partsToggle.checked;
    if (!partsToggle.checked) return;
    // 链接里带 ?p=N 时，起点自动跟上（旧版的"从当前P往后处理"就是这个意思）
    const url = (mainInput.value.match(/https?:\/\/\S+/) || [])[0];
    const currentPart = url ? VideoUtils.extractCurrentPFromUrl(url) : null;
    if (currentPart) {
      partsStart.value = String(currentPart);
      partsEnd.value = String(currentPart + 4);
    }
  });

  return { transcript, localFile, partsToggle, partsStart, partsEnd };
}

async function submit(ctx: ViewContext, input: HTMLTextAreaElement, fields: AdvancedFields) {
  const raw = input.value.trim();
  const transcript = fields.transcript.value.trim();
  const localFiles = fields.localFile.value.trim();

  if (!raw && !transcript && !localFiles) {
    new Notice('先粘贴一个链接、本地文件名或文稿');
    return;
  }

  let drafts = parseInput(raw, {
    transcript,
    localFiles,
    keepPartParam: !fields.partsToggle.checked,
  });

  if (fields.partsToggle.checked) {
    const url = drafts.find((draft) => draft.source === 'url')?.input.url;
    if (!url) {
      new Notice('分P展开需要一条视频链接');
      return;
    }
    const start = Math.max(1, parseInt(fields.partsStart.value, 10) || 1);
    const end = Math.max(start, parseInt(fields.partsEnd.value, 10) || start);
    if (end - start + 1 > 100) {
      new Notice('一次最多展开 100 个分P');
      return;
    }
    const expanded = expandParts(url, start, end, { transcript, localFiles });
    if (expanded.length === 0) {
      new Notice('无法从链接里识别视频 ID，改用逐条链接吧');
      return;
    }
    drafts = expanded;
    ctx.state.partsStart = start;
    ctx.state.partsEnd = end;
  }

  if (drafts.length === 0) {
    new Notice('没解析出可处理的内容');
    return;
  }

  // 输入框里打了一小段既不是链接也不是路径的文字，多半是手滑，不该悄悄建一篇"文稿"笔记
  const looksAccidental =
    drafts.length === 1 &&
    drafts[0].source === 'transcript' &&
    !transcript &&
    raw.length > 0 &&
    raw.length < 40 &&
    !raw.includes('\n');
  if (looksAccidental) {
    new Notice(
      `"${raw}" 不像链接或文件名。要当作文稿处理，请把内容贴进高级选项里的「手动文稿」。`,
      8000,
    );
    return;
  }

  if (drafts.length > 50) {
    new Notice('一次最多提交 50 条');
    return;
  }

  const queued = await ctx.plugin.jobService.submit(drafts, ctx.submitOptions());
  if (queued > 0) {
    input.value = '';
    fields.transcript.value = '';
    fields.localFile.value = '';
    ctx.state.inputDraft = '';
    ctx.state.transcriptDraft = '';
    ctx.state.localFileDraft = '';
    input.dispatchEvent(new Event('input'));
    new Notice(`已提交 ${queued} 个任务`);
    ctx.state.tab = 'jobs';
    ctx.renderPanels();
  }
}

function pickLocalFiles(ctx: ViewContext, input: HTMLTextAreaElement) {
  const picker = createEl('input');
  picker.type = 'file';
  picker.multiple = true;
  picker.addEventListener('change', () => {
    const names = Array.from(picker.files || [])
      .map((file) => file.name)
      .filter(Boolean);
    if (names.length > 0) appendFileNames(ctx, input, names);
  });
  picker.click();
}

// 浏览器只给得到文件名，不给完整路径；n8n/docker 场景本来也只认 uploads 里的文件名
function appendFileNames(ctx: ViewContext, input: HTMLTextAreaElement, names: string[]) {
  const current = input.value.trim();
  input.value = current ? `${current}\n${names.join('\n')}` : names.join('\n');
  ctx.state.inputDraft = input.value;
  input.dispatchEvent(new Event('input'));
  new Notice(`已填入 ${names.length} 个文件名，确认它们在后端可访问的目录里`);
}

function autoGrow(input: HTMLTextAreaElement) {
  const resize = () => {
    input.setCssStyles({ height: 'auto' });
    input.setCssStyles({ height: `${Math.min(140, Math.max(32, input.scrollHeight))}px` });
  };
  input.addEventListener('input', resize);
  resize();
}

function shortenPath(path: string): string {
  if (path.length <= 22) return path;
  return `…${path.slice(-20)}`;
}

export function isProcessableFile(file: TFile | null): boolean {
  return !!file && file.extension === 'md';
}
