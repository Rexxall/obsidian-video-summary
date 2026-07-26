// agent: claude (2026-07-26)
import { Notice, TFile, TFolder, setIcon } from 'obsidian';
import { ViewContext } from '../context';
import {
  configChip,
  iconButton,
  languageLabel,
  modeLabel,
  platformText,
  statusMeta,
  textButton,
} from '../ui';
import { platformLabel } from '../../core/NoteIndex';
import { expandParts, isAbsoluteLocalPath, parseInput } from '../../core/InputParser';
import { FolderSelectModal } from '../../modals/FolderSelectModal';
import { ProcessingMode, SupportedLanguage } from '../../types';
import { VideoUtils } from '../../utils/VideoUtils';

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

/**
 * 顶部行动区：当前笔记上下文 + 一个智能输入框 + 配置 chip + 主按钮。
 * 旧版这里是三个 radio、四个 select、两个额外输入框和一个折叠面板。
 */
export function renderActionBar(container: HTMLElement, ctx: ViewContext) {
  const { state } = ctx;
  const root = container.createDiv({ cls: 'vs-action-bar' });

  renderHeader(root, ctx);
  renderContextStrip(root, ctx);

  const inputCard = root.createDiv({ cls: 'vs-input-card' });
  const inputRow = inputCard.createDiv({ cls: 'vs-input-row' });
  const inputIcon = inputRow.createDiv({ cls: 'vs-input-icon' });
  setIcon(inputIcon, 'clipboard-paste');

  const input = inputRow.createEl('textarea', {
    cls: 'vs-input',
    attr: {
      rows: '1',
      placeholder: '粘贴视频链接，多行即批量…',
    },
  });
  input.value = state.inputDraft;
  input.addEventListener('input', () => {
    state.inputDraft = input.value;
  });
  autoGrow(input);

  iconButton(
    inputRow,
    'folder-open',
    '选择本机文件',
    () => pickLocalFiles(ctx, input),
    'vs-input-action',
  );

  const chips = inputCard.createDiv({ cls: 'vs-chip-row' });
  renderChips(chips, ctx);

  const advanced = root.createDiv({ cls: 'vs-advanced' });
  const advancedFields = renderAdvanced(advanced, ctx, input);

  const actions = root.createDiv({ cls: 'vs-action-row' });
  const submitBtn = actions.createEl('button', {
    text: '开始处理',
    cls: 'vs-primary-btn',
    attr: { type: 'button' },
  });

  const cacheBtn = iconButton(
    actions,
    'refresh-cw',
    state.ignoreCache ? '忽略缓存：开（强制重新处理）' : '忽略缓存：关',
    () => {
      state.ignoreCache = !state.ignoreCache;
      cacheBtn.toggleClass('is-active', state.ignoreCache);
      cacheBtn.setAttr(
        'aria-label',
        state.ignoreCache ? '忽略缓存：开（强制重新处理）' : '忽略缓存：关',
      );
    },
    'vs-toggle-btn',
  );
  cacheBtn.toggleClass('is-active', state.ignoreCache);

  iconButton(
    actions,
    'sliders-horizontal',
    state.advancedOpen ? '收起高级选项' : '展开高级选项',
    () => {
      state.advancedOpen = !state.advancedOpen;
      ctx.renderAll();
    },
    state.advancedOpen ? 'is-active' : undefined,
  );

  advanced.toggleClass('is-open', state.advancedOpen);

  submitBtn.addEventListener('click', async () => {
    submitBtn.disabled = true;
    try {
      await submit(ctx, input, advancedFields);
    } finally {
      submitBtn.disabled = false;
    }
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submitBtn.click();
    }
  });
}

function renderHeader(root: HTMLElement, ctx: ViewContext) {
  const header = root.createDiv({ cls: 'vs-header' });
  header.createSpan({ text: '视频总结', cls: 'vs-header-title' });
  const actions = header.createDiv({ cls: 'vs-header-actions' });

  const backend = activeBackendInfo(ctx);
  const cachedResult = freshProbeResult(ctx, backend);
  const cachedEntry = backendProbeCaches.get(ctx.plugin);
  const initialState =
    cachedEntry?.key === backend.key && cachedEntry.pending
      ? 'is-checking'
      : cachedResult?.state || 'is-unknown';
  ctx.setBackendState(initialState);

  const statusPillEl = actions.createEl('button', {
    cls: 'vs-backend-pill',
    attr: { type: 'button' },
  });
  const dot = statusPillEl.createSpan({ cls: 'vs-backend-dot' });
  const label = statusPillEl.createSpan();
  updateBackendPill(statusPillEl, dot, label, backend, initialState, cachedResult);

  statusPillEl.addEventListener('click', async (event) => {
    event.preventDefault();
    if (ctx.backendState() === 'is-checking') return;

    ctx.setBackendState('is-checking');
    updateBackendPill(statusPillEl, dot, label, backend, 'is-checking');
    const result = await probeBackend(ctx, backend, true);
    updateBackendPill(statusPillEl, dot, label, backend, result.state, result);
    new Notice(
      result.state === 'is-online'
        ? `${backend.label} 连接正常（${result.durationMs ?? 0}ms）`
        : `${backend.label} 连接失败：${result.reason || '未知原因'}`,
      result.state === 'is-online' ? 3000 : 6000,
    );
    ctx.renderAll();
  });

  // 首次打开或缓存过期时才自动检测；重绘会复用 pending/result，不重复发请求。
  if (initialState === 'is-unknown' || initialState === 'is-checking') {
    ctx.setBackendState('is-checking');
    updateBackendPill(statusPillEl, dot, label, backend, 'is-checking');
    void probeBackend(ctx, backend).then((result) => {
      ctx.setBackendState(result.state);
      ctx.renderAll();
    });
  }

  iconButton(actions, 'settings', '打开插件设置', () => {
    const settingApi = (ctx.plugin.app as any).setting;
    if (settingApi?.open) {
      settingApi.open();
      settingApi.openTabById?.(ctx.plugin.manifest.id);
    }
  });
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
              reason: summarizeBackendFailure(test.error || test.hint || ''),
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
            reason: summarizeBackendFailure(health.error || ''),
          };
    } catch (error) {
      return {
        state: 'is-offline',
        checkedAt: Date.now(),
        reason: summarizeBackendFailure(error instanceof Error ? error.message : String(error)),
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
    label.setText(`${backend.label} 检测中…`);
    pill.setAttr('title', `${backend.label}：正在检测连接`);
    return;
  }
  if (state === 'is-online') {
    const reachabilityOnly = result?.verified === false;
    label.setText(`${backend.label} ${reachabilityOnly ? '可达' : '在线'}`);
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
    label.setText(`${backend.label} 离线 · ${reason}`);
    pill.setAttr(
      'title',
      `${backend.label} 离线：${reason}${
        result ? ` · 最近检测 ${formatProbeTime(result.checkedAt)}` : ''
      }；点击重新检测`,
    );
    return;
  }
  label.setText(`${backend.label} 未检测`);
  pill.setAttr('title', `${backend.label}：点击测试连接`);
}

function formatProbeTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** 连接状态同样只显示分类后的安全原因，避免把 webhook URL 或本机路径带到页头。 */
function summarizeBackendFailure(raw: string): string {
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

  const status = entry?.status || 'pending';
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

  if (status !== 'running') {
    textButton(
      strip,
      status === 'success' ? '重跑' : '处理',
      async () => {
        await ctx.plugin.jobService.submitFile(activeFile, ctx.submitOptions());
        ctx.state.tab = 'jobs';
        ctx.renderPanels();
      },
      'vs-context-action',
    );
  }
}

function renderChips(chips: HTMLElement, ctx: ViewContext) {
  const { plugin } = ctx;
  const settings = plugin.settings;

  configChip(
    chips,
    '处理模式',
    modeLabel(settings.defaultMode),
    (['summary', 'transcript-only', 'info-only'] as ProcessingMode[]).map((mode) => ({
      title: modeLabel(mode),
      onClick: async () => {
        settings.defaultMode = mode;
        await plugin.saveSettings();
        ctx.renderAll();
      },
    })),
  );

  configChip(
    chips,
    '输出语言',
    languageLabel(settings.defaultLanguage),
    (['zh', 'en', 'ja'] as SupportedLanguage[]).map((language) => ({
      title: languageLabel(language),
      onClick: async () => {
        settings.defaultLanguage = language;
        await plugin.saveSettings();
        ctx.renderAll();
      },
    })),
  );

  const models = settings.customAiModels?.length ? settings.customAiModels : [settings.aiModel];
  configChip(
    chips,
    '处理模型',
    settings.aiModel || models[0] || '默认',
    models.filter(Boolean).map((model) => ({
      title: model,
      onClick: async () => {
        settings.aiModel = model;
        plugin.api.setAiModel(model);
        await plugin.saveSettings();
        ctx.renderAll();
      },
    })),
  );

  const folderChip = chips.createEl('button', {
    cls: 'vs-chip',
    attr: { type: 'button', title: `保存位置：${settings.outputFolder || '当前文件夹'}` },
  });
  const folderCaret = folderChip.createSpan({ cls: 'vs-chip-caret' });
  setIcon(folderCaret, 'folder');
  folderChip.createSpan({
    text: shortenPath(settings.outputFolder || '当前文件夹'),
    cls: 'vs-chip-value',
  });
  folderChip.addEventListener('click', (event) => {
    event.preventDefault();
    const folders = plugin.app.vault
      .getAllLoadedFiles()
      .filter((file): file is TFolder => file instanceof TFolder)
      .map((folder) => folder.path)
      .sort();
    new FolderSelectModal(plugin.app, folders, async (selected: string) => {
      settings.outputFolder = selected;
      await plugin.saveSettings();
      ctx.renderAll();
    }).open();
  });

  const previewChip = chips.createEl('button', {
    cls: `vs-chip vs-chip-toggle${settings.previewBeforeWrite ? ' is-active' : ''}`,
    attr: {
      type: 'button',
      title: settings.previewBeforeWrite
        ? '结果先预览，确认后才写入笔记'
        : '结果直接写入笔记（点击改为先预览）',
    },
  });
  const previewIcon = previewChip.createSpan({ cls: 'vs-chip-caret' });
  setIcon(previewIcon, settings.previewBeforeWrite ? 'eye' : 'eye-off');
  previewChip.createSpan({ text: '先预览', cls: 'vs-chip-value' });
  previewChip.addEventListener('click', async (event) => {
    event.preventDefault();
    settings.previewBeforeWrite = !settings.previewBeforeWrite;
    await plugin.saveSettings();
    ctx.renderAll();
  });
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
    backendSelect.addEventListener('change', async () => {
      await plugin.setActiveWebhook(backendSelect.value, { silent: false });
      ctx.renderAll();
    });
  }

  const transcriptRow = container.createDiv({ cls: 'vs-field' });
  transcriptRow.createEl('label', { text: '手动文稿', cls: 'vs-field-label' });
  const transcript = transcriptRow.createEl('textarea', {
    cls: 'vs-field-input',
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
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.multiple = true;
  picker.addEventListener('change', () => {
    const names = Array.from(picker.files || [])
      .map((file) => file.name)
      .filter(Boolean);
    if (names.length === 0) return;
    // 浏览器只给得到文件名，不给完整路径；n8n/docker 场景本来也只认 uploads 里的文件名
    const current = input.value.trim();
    input.value = current ? `${current}\n${names.join('\n')}` : names.join('\n');
    ctx.state.inputDraft = input.value;
    input.dispatchEvent(new Event('input'));
    new Notice(`已填入 ${names.length} 个文件名，确认它们在后端可访问的目录里`);
  });
  picker.click();
}

function autoGrow(input: HTMLTextAreaElement) {
  const resize = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(140, Math.max(32, input.scrollHeight))}px`;
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
