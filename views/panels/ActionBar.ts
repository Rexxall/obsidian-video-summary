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

function backendStateLabel(state: string): string {
  if (state === 'is-online') return '在线';
  if (state === 'is-offline') return '离线';
  return '未检测';
}

function renderHeader(root: HTMLElement, ctx: ViewContext) {
  const header = root.createDiv({ cls: 'vs-header' });
  header.createSpan({ text: '视频总结', cls: 'vs-header-title' });
  const actions = header.createDiv({ cls: 'vs-header-actions' });

  const backend = ctx.plugin.settings.activeBackend === 'codex-worker' ? 'Codex Worker' : 'n8n';
  const statusPillEl = actions.createEl('button', {
    cls: 'vs-backend-pill',
    attr: { type: 'button', title: `${backend}：点击测试连接` },
  });
  const dot = statusPillEl.createSpan({ cls: `vs-backend-dot ${ctx.backendState()}` });
  statusPillEl.createSpan({ text: `${backend} ${backendStateLabel(ctx.backendState())}` });
  statusPillEl.addEventListener('click', async (event) => {
    event.preventDefault();
    dot.className = 'vs-backend-dot is-checking';
    try {
      const result = await ctx.plugin.api.testConnection();
      ctx.setBackendState(result.success ? 'is-online' : 'is-offline');
      dot.className = `vs-backend-dot ${ctx.backendState()}`;
      new Notice(
        result.success
          ? `${backend} 连接正常（${result.durationMs ?? 0}ms）`
          : `${backend} 连接失败：${result.error || '未知错误'}`,
        result.success ? 3000 : 8000,
      );
      ctx.renderAll();
    } catch (error) {
      ctx.setBackendState('is-offline');
      dot.className = 'vs-backend-dot is-offline';
      new Notice(`连接失败：${ctx.plugin.formatErrorForNotice(error)}`, 8000);
    }
  });

  iconButton(actions, 'settings', '打开插件设置', () => {
    const settingApi = (ctx.plugin.app as any).setting;
    if (settingApi?.open) {
      settingApi.open();
      settingApi.openTabById?.(ctx.plugin.manifest.id);
    }
  });
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

  const profiles = settings.webhookProfiles || [];
  if (profiles.length > 1) {
    const active = profiles.find((profile) => profile.id === settings.activeWebhookId);
    configChip(
      chips,
      'Webhook',
      active?.name || active?.url || '默认',
      profiles.map((profile) => ({
        title: profile.name || profile.url,
        onClick: async () => {
          await plugin.setActiveWebhook(profile.id, { silent: false });
          ctx.renderAll();
        },
      })),
    );
  }

  const folderChip = chips.createEl('button', {
    cls: 'vs-chip',
    attr: { type: 'button', title: `保存位置：${settings.outputFolder || '当前文件夹'}` },
  });
  folderChip.createSpan({
    text: shortenPath(settings.outputFolder || '当前文件夹'),
    cls: 'vs-chip-value',
  });
  const folderCaret = folderChip.createSpan({ cls: 'vs-chip-caret' });
  setIcon(folderCaret, 'folder');
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
  previewChip.createSpan({ text: '写入前预览', cls: 'vs-chip-value' });
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
    new Notice(`"${raw}" 不像链接或文件名。要当作文稿处理，请把内容贴进高级选项里的「手动文稿」。`, 8000);
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
