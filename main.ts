// agent: codex (2026-05-21)
// agent: claude (2026-07-02) — history 拆分存储 / 后端 preflight / cookies 管理 / obsidian:// 协议直连
import {
  App,
  Editor,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
  DropdownComponent,
  setIcon,
} from 'obsidian';
import { VideoSummaryModal } from './modals';
import { BatchProcessingModal } from './BatchProcessingModal';
import {
  VideoSummarySettings,
  ProcessingMode,
  WebhookProfile,
  ProcessingBackend,
  SetupCheckItem,
  ConnectionTestResult,
  PlatformCapability,
} from './types';
import {
  DEFAULT_SETTINGS,
  DEFAULT_N8N_WEBHOOK_URL,
  DEFAULT_HISTORY_LIMIT,
  LEGACY_DEFAULT_N8N_WEBHOOK_URL,
  LEGACY_N8N_WEBHOOK_URL,
  PLATFORM_CAPABILITIES,
  RECOMMENDED_WORKFLOW,
} from './constants';
import { VideoSummaryAPI } from './api/VideoSummaryAPI';
import { VideoSummaryView, VIDEO_SUMMARY_VIEW_TYPE } from './views/VideoSummaryView';
import { ConfirmModal } from './modals';
import { VideoUtils } from './utils/VideoUtils';
import { FileProcessor } from './utils/FileProcessor';
import { RetryUtils } from './utils/RetryUtils';
import { NoteProcessor } from './utils/NoteProcessor';
import { JobStore } from './core/JobStore';
import { JobService } from './core/JobService';
import { NoteIndex } from './core/NoteIndex';
import { Modal } from 'obsidian';

export default class VideoSummaryPlugin extends Plugin {
  settings: VideoSummarySettings;
  api: VideoSummaryAPI;
  fileProcessor: FileProcessor;
  noteProcessor: NoteProcessor;
  /** 任务与索引挂在插件上，侧栏开关不影响它们 */
  jobs: JobStore;
  jobService: JobService;
  noteIndex: NoteIndex;

  // history.json 延迟写入
  private historySaveTimer: number | null = null;

  // preflight 结果缓存（60s 内不重复 ping）
  private lastPreflight: {
    backend: ProcessingBackend;
    url: string;
    ok: boolean;
    at: number;
  } | null = null;

  async onload() {
    console.log('加载视频总结插件');

    // 加载设置
    await this.loadSettings();

    // 初始化API
    this.initializeApiInstance();

    // 初始化文件与笔记处理器
    this.fileProcessor = new FileProcessor(this.app, this);
    this.noteProcessor = new NoteProcessor(this.app.vault);

    // 任务队列 + 视频笔记索引
    this.jobs = new JobStore();
    this.jobService = new JobService(this, this.jobs);
    this.noteIndex = new NoteIndex(this.app);
    this.app.workspace.onLayoutReady(() => this.noteIndex.build());

    // 注册视图类型
    this.registerView(
      VIDEO_SUMMARY_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new VideoSummaryView(leaf, this),
    );

    // 注册命令
    this.addCommands();

    // 注册右键菜单
    this.registerContextMenu();

    // 注册 obsidian://video-summary 协议：浏览器扩展一键"建笔记 + 触发处理"直连入口
    this.registerObsidianProtocolHandler('video-summary', (params) => {
      void this.handleProtocolRequest(params as Record<string, string>);
    });

    // 注册设置页面
    this.addSettingTab(new VideoSummarySettingTab(this.app, this));

    // 索引增量维护：以前是每次文件变动就整块重建侧栏 DOM，现在只更新受影响的那条记录
    this.registerEvent(
      this.app.metadataCache.on('changed', (file) => {
        if (file instanceof TFile && file.extension === 'md') {
          void this.noteIndex.refreshFile(file);
        }
      }),
    );
    this.registerEvent(this.app.vault.on('delete', (file) => this.noteIndex.handleDelete(file)));
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => this.noteIndex.handleRename(file, oldPath)),
    );

    console.log('Video Summary Plugin loaded');
  }

  onunload() {
    // 卸载前把待写入的历史落盘
    if (this.historySaveTimer !== null) {
      window.clearTimeout(this.historySaveTimer);
      this.historySaveTimer = null;
      void this.writeHistoryFile();
    }
    console.log('Video Summary Plugin unloaded');
  }

  private addCommands() {
    // 主要命令：快速总结当前笔记
    this.addCommand({
      id: 'video-summary-quick',
      name: '📺 快速总结当前笔记',
      editorCallback: (editor: Editor, view: MarkdownView) => {
        this.quickProcessCurrentNote(editor, view, 'summary');
      },
    });

    // 新增命令：将全文作为文稿总结
    this.addCommand({
      id: 'video-summary-full-text',
      name: '📺 将当前笔记全文作为文稿总结',
      editorCallback: (editor: Editor, view: MarkdownView) => {
        this.processFullTextAsTranscript(editor, view);
      },
    });

    // 快速提取文稿
    this.addCommand({
      id: 'video-transcript-quick',
      name: '📝 快速提取文稿',
      editorCallback: (editor: Editor, view: MarkdownView) => {
        this.quickProcessCurrentNote(editor, view, 'transcript-only');
      },
    });

    // 只更新视频信息
    this.addCommand({
      id: 'video-info-update',
      name: 'ℹ️ 更新视频信息（不改正文）',
      editorCallback: (editor: Editor, view: MarkdownView) => {
        this.updateVideoInfoOnly(editor, view, false);
      },
    });

    // 更新视频信息并重命名
    this.addCommand({
      id: 'video-info-update-rename',
      name: 'ℹ️ 更新视频信息并重命名',
      editorCallback: (editor: Editor, view: MarkdownView) => {
        this.updateVideoInfoOnly(editor, view, true);
      },
    });

    // 打开视频总结管理视图
    this.addCommand({
      id: 'video-summary-view',
      name: '📋 视频总结管理',
      callback: () => {
        this.activateView();
      },
    });

    // 批量处理命令
    this.addCommand({
      id: 'video-summary-batch',
      name: '🔄 批量处理视频',
      callback: () => {
        new BatchProcessingModal(this.app, this).open();
      },
    });

    // 重新处理当前笔记
    this.addCommand({
      id: 'video-summary-reprocess',
      name: '🔄 重新处理当前笔记',
      editorCallback: (editor: Editor, view: MarkdownView) => {
        this.reprocessCurrentNote(editor, view);
      },
    });

    // 处理所有待处理视频
    this.addCommand({
      id: 'video-summary-process-all-pending',
      name: '⚡ 处理所有待处理视频',
      callback: () => {
        this.processAllPendingVideos();
      },
    });

    // 测试当前视频处理后端连接
    this.addCommand({
      id: 'video-summary-test-connection',
      name: '🔗 测试当前视频处理后端',
      callback: () => {
        this.testProcessingBackendConnection();
      },
    });

    this.addCommand({
      id: 'video-summary-open-codex-dashboard',
      name: '📊 打开 Codex Worker 控制台',
      callback: () => {
        this.openCodexWorkerDashboard();
      },
    });

    // 标记为非视频笔记
    this.addCommand({
      id: 'video-summary-mark-excluded',
      name: '⛔️ 标记为非视频笔记',
      editorCallback: (editor: Editor, view: MarkdownView) => {
        this.markAsExcluded(editor, view);
      },
    });
  }

  private registerContextMenu() {
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (file instanceof TFile && file.extension === 'md') {
          menu.addItem((item) => {
            item
              .setTitle('视频总结 - 快速处理')
              .setIcon('video')
              .onClick(async () => {
                await this.processFile(file);
              });
          });

          menu.addItem((item) => {
            item
              .setTitle('视频总结 - 仅提取文稿')
              .setIcon('document')
              .onClick(async () => {
                await this.processFileWithMode(file, 'transcript-only');
              });
          });
        }
      }),
    );
  }

  private async processCurrentNote(editor: Editor, view: MarkdownView) {
    try {
      const file = view.file;
      if (!file) {
        new Notice('无法获取当前文件');
        return;
      }

      const content = await this.app.vault.read(file);

      // 检查是否有任何输入数据
      const url = this.extractVideoUrl(content);
      const providedTranscript = this.extractProvidedTranscript(content);
      const localFileName = this.extractLocalFileName(content);

      if (!url && !providedTranscript && !localFileName) {
        new Notice('当前笔记中没有找到视频链接、文稿内容或本地文件名');
        return;
      }

      new VideoSummaryModal(this.app, this, editor, view).open();
    } catch (error) {
      new Notice(`处理当前笔记失败: ${this.formatErrorForNotice(error)}`, 8000);
    }
  }

  private async processCurrentNoteWithMode(
    editor: Editor,
    view: MarkdownView,
    mode: ProcessingMode,
  ) {
    try {
      const file = view.file;
      if (!file) {
        new Notice('无法获取当前文件');
        return;
      }

      const content = await this.app.vault.read(file);

      // 检查是否有任何输入数据
      const url = this.extractVideoUrl(content);
      const providedTranscript = this.extractProvidedTranscript(content);
      const localFileName = this.extractLocalFileName(content);

      if (!url && !providedTranscript && !localFileName) {
        new Notice('当前笔记中没有找到视频链接、文稿内容或本地文件名');
        return;
      }

      // 直接处理，不打开模态框
      await this.processFileWithMode(file, mode);
    } catch (error) {
      new Notice(`处理当前笔记失败: ${this.formatErrorForNotice(error)}`, 8000);
    }
  }

  private async updateVideoInfoOnly(editor: Editor, view: MarkdownView, forceRename: boolean) {
    try {
      const file = view.file;
      if (!file) {
        new Notice('无法获取当前文件');
        return;
      }

      const content = await this.app.vault.read(file);
      const videoInput = this.noteProcessor.buildVideoInput(content);

      if (!videoInput.url && !videoInput.transcript && !videoInput.localFile) {
        new Notice('当前笔记中没有找到视频链接、文稿内容或本地文件名');
        return;
      }

      if (!(await this.ensureBackendReady())) {
        return;
      }

      await this.noteProcessor.setProcessingStatus(file, 'running');

      const statusNotice = new Notice('正在获取视频信息...', 0);

      try {
        const result = await this.api.processVideo(
          file.basename,
          videoInput,
          'info-only',
          this.settings.defaultLanguage,
          this.settings.enableCache !== false,
        );

        await this.noteProcessor.updateNote(file, result, 'info-only', {
          autoRename: forceRename,
          conflictStrategy: this.settings.renameConflictStrategy,
        });

        await this.noteProcessor.setProcessingStatus(
          file,
          this.settings.successStatusValue ?? 'success',
        );
        this.addToHistory(file.basename, 'success', 'info-only');

        statusNotice.setMessage('✅ 视频信息已更新');
        setTimeout(() => statusNotice.hide(), 2000);
      } catch (error) {
        await this.noteProcessor.setProcessingError(file, error);
        this.addToHistory(file.basename, 'error', 'info-only');
        statusNotice.setMessage(`更新失败: ${this.formatErrorForNotice(error)}`);
        setTimeout(() => statusNotice.hide(), 3000);
      }
    } catch (error) {
      new Notice(`更新视频信息失败: ${this.formatErrorForNotice(error)}`, 8000);
    }
  }

  private async reprocessCurrentNote(editor: Editor, view: MarkdownView) {
    try {
      const file = view.file;
      if (!file) {
        new Notice('无法获取当前文件');
        return;
      }

      // 直接重新处理文件
      await this.processFile(file);
    } catch (error) {
      new Notice(`重新处理失败: ${this.formatErrorForNotice(error)}`, 8000);
    }
  }

  private async quickProcessCurrentNote(editor: Editor, view: MarkdownView, mode: ProcessingMode) {
    try {
      const file = view.file;
      if (!file) {
        new Notice('无法获取当前文件');
        return;
      }

      const content = await this.app.vault.read(file);

      // 提取所有可能的输入数据
      const url = this.extractVideoUrl(content);
      const providedTranscript = this.extractProvidedTranscript(content);
      const localFileName = this.extractLocalFileName(content);

      // 检查是否有任何输入数据
      if (!url && !providedTranscript && !localFileName) {
        new Notice('当前笔记中没有找到视频链接、文稿内容或本地文件名');
        return;
      }

      // 后端自检：不可达时提示/建议切换，不再发起注定失败的请求
      if (!(await this.ensureBackendReady())) {
        return;
      }

      // 获取预设配置
      const requestLanguage =
        mode === 'summary'
          ? this.settings.quickSummaryOptions.language
          : mode === 'transcript-only'
            ? this.settings.quickTranscriptOptions.language
            : this.settings.defaultLanguage;

      // 显示处理状态
      const statusNotice = new Notice(`正在处理: ${this.getModeDisplayText(mode)}`, 0);

      // 检查是否为多文件合并场景 (localFileName 包含逗号)
      let isMerge = false;
      let localFiles: string[] = [];

      if (localFileName && localFileName.includes(',')) {
        localFiles = localFileName
          .split(',')
          .map((f) => f.trim())
          .filter((f) => f);
        if (localFiles.length > 1) {
          isMerge = true;
        }
      }

      try {
        let result: any;

        // ===== 多文件合并逻辑 =====
        if (isMerge) {
          const langText =
            requestLanguage === 'zh' ? '中文' : requestLanguage === 'en' ? '英文' : '日文';
          statusNotice.setMessage(`正在合并处理 ${localFiles.length} 个文件...`);

          let combinedTranscript = '';

          // 1. 逐个提取文稿
          for (let i = 0; i < localFiles.length; i++) {
            const localFile = localFiles[i];
            statusNotice.setMessage(`正在提取第 ${i + 1}/${localFiles.length} 个文件的内容...`);

            // 使用 processVideoSimple 仅提取文稿
            const extractResult = await this.api.processVideoSimple(
              { localFile: localFile },
              'transcript-only',
              requestLanguage,
              false, // 不使用缓存
            );

            if (extractResult.video_transcript) {
              combinedTranscript += `\n\n=== FILE START: ${localFile} ===\n${extractResult.video_transcript}\n=== FILE END ===\n`;
            }
          }

          if (!combinedTranscript) {
            throw new Error('未能从文件中提取到任何内容');
          }

          // 2. 使用合并后的文稿进行总结
          statusNotice.setMessage(`正在以${langText}生成合并总结...`);

          // 构建新的输入，使用合并后的文稿
          const mergedInput: any = {
            transcript: combinedTranscript,
            url: url,
          };

          // 调用主处理流程（重试逻辑）
          result = await RetryUtils.withSmartRetry(
            async () => {
              return await this.api.processVideo(
                file.basename,
                mergedInput,
                mode,
                requestLanguage,
                this.settings.enableCache !== false,
              );
            },
            1,
            2000,
            (attempt, error) => {
              statusNotice.setMessage(`重试中: ${error.message}`);
            },
          );
        } else {
          // ===== 单文件/常规逻辑 =====

          // 构建输入数据
          const input: any = {};
          if (url) input.url = url;
          if (providedTranscript) input.transcript = providedTranscript;
          if (localFileName) input.localFile = localFileName; // 单文件情况

          // 设置处理中状态
          await this.noteProcessor.setProcessingStatus(file, 'running');

          // 使用重试机制调用API处理
          result = await RetryUtils.withSmartRetry(
            async () => {
              return await this.api.processVideo(
                file.basename,
                input,
                mode,
                requestLanguage,
                this.settings.enableCache !== false, // 根据设置决定是否使用缓存
              );
            },
            1, // 重试1次
            2000, // 2秒延迟
            (attempt, error) => {
              statusNotice.setMessage(`重试中 (${attempt}/2): ${error.message}`);
            },
          );
        }

        // ===== 处理结果 =====

        // 更新笔记内容（按设置控制自动重命名）
        await this.noteProcessor.updateNote(file, result, mode, {
          autoRename: this.settings.autoRenameEnabled,
          conflictStrategy: this.settings.renameConflictStrategy,
        });

        // 更新状态（使用可配置的成功状态值）
        await this.noteProcessor.setProcessingStatus(
          file,
          this.settings.successStatusValue ?? 'success',
        );

        // 添加到历史记录
        this.addToHistory(file.basename, 'success', mode);

        statusNotice.setMessage(`✅ 处理完成`);
        setTimeout(() => statusNotice.hide(), 2000);
      } catch (error) {
        // 更新状态为错误
        await this.noteProcessor.setProcessingError(file, error);

        // 添加到历史记录
        this.addToHistory(file.basename, 'error', mode);

        statusNotice.setMessage(`处理失败: ${this.formatErrorForNotice(error)}`);
        setTimeout(() => statusNotice.hide(), 3000);
      }
    } catch (error) {
      new Notice(`处理失败: ${this.formatErrorForNotice(error)}`, 8000);
    }
  }

  private async processFullTextAsTranscript(editor: Editor, view: MarkdownView) {
    try {
      const file = view.file;
      if (!file) {
        new Notice('无法获取当前文件');
        return;
      }

      // 获取全文本
      const fullText = editor.getValue();
      if (!fullText.trim()) {
        new Notice('笔记中没有发现任何文本内容');
        return;
      }

      // 获取设置
      const requestLanguage =
        this.settings.quickSummaryOptions?.language || this.settings.defaultLanguage;
      const mode = 'summary';

      if (!(await this.ensureBackendReady())) {
        return;
      }

      // 设置处理中状态
      await this.noteProcessor.setProcessingStatus(file, 'running');
      const statusNotice = new Notice(`正在将全文发送处理...`, 0);

      try {
        const input: any = {
          transcript: fullText,
        };

        // 使用重试机制调用API处理全文文本
        const result = await RetryUtils.withSmartRetry(
          async () => {
            return await this.api.processVideo(
              file.basename,
              input,
              mode,
              requestLanguage,
              this.settings.enableCache !== false,
            );
          },
          1, // 重试1次
          2000, // 2秒延迟
          (attempt, error) => {
            statusNotice.setMessage(`重试中 (${attempt}/2): ${error.message}`);
          },
        );

        // 更新笔记内容，强制开启 autoRename 以便此模式下总是应用由 n8n 生成的好的标题
        await this.noteProcessor.updateNote(file, result, mode, {
          autoRename: true,
          conflictStrategy: this.settings.renameConflictStrategy,
        });
        await this.noteProcessor.setProcessingStatus(
          file,
          this.settings.successStatusValue ?? 'success',
        );
        this.addToHistory(file.basename, 'success', mode);

        statusNotice.setMessage(`✅ 全文处理完成`);
        setTimeout(() => statusNotice.hide(), 2000);
      } catch (error) {
        await this.noteProcessor.setProcessingError(file, error);
        this.addToHistory(file.basename, 'error', mode);
        statusNotice.setMessage(`处理失败: ${this.formatErrorForNotice(error)}`);
        setTimeout(() => statusNotice.hide(), 5000);
      }
    } catch (error) {
      new Notice(`处理启动失败: ${this.formatErrorForNotice(error)}`, 8000);
    }
  }

  private async processAllPendingVideos() {
    try {
      const files = this.app.vault.getMarkdownFiles();
      const pendingFiles: TFile[] = [];

      // 扫描所有待处理的视频文件（优先使用 frontmatter）
      for (const file of files) {
        try {
          const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
          if (VideoUtils.isVideoNoteFromFrontmatter(fm)) {
            const status = VideoUtils.getProcessingStatusFromFrontmatter(fm);
            if (status === 'pending' || status === 'error') {
              pendingFiles.push(file);
            }
            continue;
          }
          // 回退读取正文
          const content = await this.app.vault.read(file);
          const isVideo = VideoUtils.isVideoNote(content);
          const status = this.getProcessingStatus(content);
          if (isVideo && (status === 'pending' || status === 'error')) {
            pendingFiles.push(file);
          }
        } catch (error) {
          console.error(`读取文件失败: ${file.basename}`, error);
        }
      }

      if (pendingFiles.length === 0) {
        new Notice('没有找到待处理的视频笔记');
        return;
      }

      // 显示确认对话框
      const confirmed = await this.showConfirmDialog(
        `批量处理 ${pendingFiles.length} 个视频`,
        `是否要批量处理这些视频？\n\n文件列表：\n${pendingFiles
          .slice(0, 10)
          .map((f) => `• ${f.basename}`)
          .join(
            '\n',
          )}${pendingFiles.length > 10 ? `\n... 还有 ${pendingFiles.length - 10} 个文件` : ''}`,
      );

      if (!confirmed) {
        return;
      }

      // 批量开始前先确认后端可用
      if (!(await this.ensureBackendReady())) {
        return;
      }

      // 创建进度通知
      const progressNotice = new Notice(`正在处理 ${pendingFiles.length} 个视频...`, 0);
      let successCount = 0;
      let errorCount = 0;

      // 批量处理文件
      for (let i = 0; i < pendingFiles.length; i++) {
        const file = pendingFiles[i];
        try {
          // 更新进度
          progressNotice.setMessage(`处理中 (${i + 1}/${pendingFiles.length})`);

          // 处理文件（历史记录由 JobService 统一写，这里不再重复追加）
          await this.processFileWithMode(file, this.settings.defaultMode);
          successCount++;
        } catch (error) {
          errorCount++;
          console.error(`处理文件失败: ${file.basename}`, error);
        }

        // 添加延迟避免API限制
        if (i < pendingFiles.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }

      // 保存历史记录
      await this.saveSettings();

      // 显示最终结果
      progressNotice.setMessage(`完成！成功: ${successCount}, 失败: ${errorCount}`);
      setTimeout(() => progressNotice.hide(), 3000);
    } catch (error) {
      new Notice(`批量处理失败: ${this.formatErrorForNotice(error)}`, 8000);
    }
  }

  private async showConfirmDialog(title: string, message: string): Promise<boolean> {
    return new Promise((resolve) => {
      const modal = new ConfirmModal(this.app, title, message, resolve);
      modal.open();
    });
  }

  addToHistory(
    fileName: string,
    result: 'success' | 'error',
    mode: string,
    meta?: { url?: string; platform?: string; error?: string; durationMs?: number },
  ) {
    if (!this.settings.history) {
      this.settings.history = [];
    }

    // 添加新记录（失败原因一并记下，界面上就能看到为什么挂了）
    this.settings.history.push({
      file: fileName,
      result: result,
      mode: mode as any,
      time: new Date().toLocaleString('zh-CN'),
      language: this.settings.defaultLanguage,
      url: meta?.url,
      platform: meta?.platform,
      error: meta?.error,
      durationMs: meta?.durationMs,
    });

    // 限容并直接排队落盘（不依赖调用方随后是否 saveSettings）
    this.trimHistory();
    this.queueHistorySave();
  }

  async clearProcessingHistory() {
    try {
      this.settings.history = [];
      await this.saveSettings();
      new Notice('处理历史已清理');
    } catch (error) {
      new Notice(`清理历史失败: ${error.message}`);
    }
  }

  private async testProcessingBackendConnection() {
    try {
      const result = await this.api.testConnection();
      const label =
        this.settings.activeBackend === 'codex-worker' ? 'Codex Worker' : 'n8n / 兼容 Webhook';

      if (result.success) {
        new Notice(`${label} 连接成功（${result.durationMs ?? 0}ms）`);
      } else {
        const hint = result.hint ? `\n建议: ${result.hint}` : '';
        new Notice(`${label} 连接失败: ${result.error || '未知错误'}${hint}`, 8000);
      }
    } catch (error) {
      new Notice(`连接失败: ${this.api.formatUserFacingError(error)}`, 8000);
    }
  }

  formatErrorForNotice(error: unknown): string {
    return this.api ? this.api.formatUserFacingError(error) : String(error);
  }

  /**
   * 处理前的后端自检（preflight）。
   * - 60 秒内的成功结果直接复用，批量处理不会反复 ping。
   * - 当前后端不可达时探测另一个后端；若可用，弹确认框提议切换并继续。
   * 返回 false 表示应中止本次处理。
   */
  async ensureBackendReady(): Promise<boolean> {
    if (this.settings.preflightCheckEnabled === false) {
      return true;
    }

    const backend = this.settings.activeBackend ?? DEFAULT_SETTINGS.activeBackend;
    const endpoint = this.getActiveProcessingEndpoint();
    const now = Date.now();

    if (
      this.lastPreflight &&
      this.lastPreflight.ok &&
      this.lastPreflight.backend === backend &&
      this.lastPreflight.url === endpoint &&
      now - this.lastPreflight.at < 60_000
    ) {
      return true;
    }

    const result = await this.api.quickHealthCheck();
    this.lastPreflight = { backend, url: endpoint, ok: result.ok, at: now };
    if (result.ok) {
      return true;
    }

    const label = backend === 'codex-worker' ? 'Codex Worker' : 'n8n / 兼容 Webhook';
    const otherBackend: ProcessingBackend = backend === 'n8n' ? 'codex-worker' : 'n8n';
    const otherLabel = otherBackend === 'codex-worker' ? 'Codex Worker' : 'n8n / 兼容 Webhook';
    const otherUrl =
      otherBackend === 'codex-worker'
        ? this.settings.codexWorkerUrl || DEFAULT_SETTINGS.codexWorkerUrl
        : this.settings.n8nWebhookUrl || DEFAULT_SETTINGS.n8nWebhookUrl;

    const otherResult = await VideoSummaryAPI.probeEndpoint(otherUrl, otherBackend);

    if (otherResult.ok) {
      const confirmed = await this.showConfirmDialog(
        `${label} 不可用`,
        `当前后端 ${label} 连接失败：\n${result.error || '未知错误'}\n\n检测到 ${otherLabel} 可用。是否切换到 ${otherLabel} 并继续？`,
      );
      if (confirmed) {
        await this.setActiveBackend(otherBackend);
        this.lastPreflight = null;
        new Notice(`已切换到 ${otherLabel}`);
        return true;
      }
      return false;
    }

    new Notice(
      `⚠️ ${label} 不可达：${result.error || '未知错误'}\n（${otherLabel} 也未检测到）请先启动处理服务，或在设置中检查 URL。`,
      8000,
    );
    return false;
  }

  openCodexWorkerDashboard() {
    window.open(this.getCodexWorkerDashboardUrl(), '_blank');
  }

  private async processFile(file: TFile) {
    await this.fileProcessor.processFile(file);
  }

  private async activateView() {
    const { workspace } = this.app;

    let leaf: WorkspaceLeaf;
    const existing = workspace.getLeavesOfType(VIDEO_SUMMARY_VIEW_TYPE)[0];
    if (existing) {
      leaf = existing;
    } else {
      const right = workspace.getRightLeaf(true);
      leaf = right ?? workspace.getLeaf(true);
      await leaf.setViewState({
        type: VIDEO_SUMMARY_VIEW_TYPE,
        active: true,
      });
    }

    workspace.revealLeaf(leaf);
  }

  async loadSettings() {
    const stored = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, stored);

    let shouldSave = false;

    // ===== history 拆分存储（2.2.0）=====
    // history / webhookHistory 持久化在插件目录 history.json；
    // data.json 里若还残留旧数据（首次升级），迁移过去并从 data.json 清除。
    const legacyHistory = Array.isArray(stored?.history) ? stored.history : [];
    const legacyWebhookHistory = Array.isArray(stored?.webhookHistory) ? stored.webhookHistory : [];
    const historyFile = await this.readHistoryFile();

    if (historyFile) {
      this.settings.history = (
        Array.isArray(historyFile.history) ? historyFile.history : []
      ) as VideoSummarySettings['history'];
      this.settings.webhookHistory = (
        Array.isArray(historyFile.webhookHistory) ? historyFile.webhookHistory : []
      ) as VideoSummarySettings['webhookHistory'];
      // 极端情况（旧版本插件又往 data.json 写过）：以条数多的一方为准
      if (legacyHistory.length > this.settings.history.length) {
        this.settings.history = legacyHistory;
      }
      if (legacyWebhookHistory.length > this.settings.webhookHistory.length) {
        this.settings.webhookHistory = legacyWebhookHistory;
      }
    } else {
      this.settings.history = legacyHistory;
      this.settings.webhookHistory = legacyWebhookHistory;
    }
    this.trimHistory();

    if (legacyHistory.length > 0 || legacyWebhookHistory.length > 0 || !historyFile) {
      // 迁移场景：立即把历史落盘（不走防抖），再触发一次保存清空 data.json 里的旧历史
      await this.writeHistoryFile();
      shouldSave = true;
    }
    // ===== history 拆分存储结束 =====

    if (!this.settings.activeBackend) {
      this.settings.activeBackend = DEFAULT_SETTINGS.activeBackend;
      shouldSave = true;
    }

    if (!this.settings.codexWorkerUrl) {
      this.settings.codexWorkerUrl = DEFAULT_SETTINGS.codexWorkerUrl;
      shouldSave = true;
    }

    if (this.settings.setupGuideDismissed === undefined) {
      this.settings.setupGuideDismissed = DEFAULT_SETTINGS.setupGuideDismissed;
      shouldSave = true;
    }

    const normalizedSuccessStatus = normalizeSuccessStatusValue(
      this.settings.successStatusValue,
    );
    if (this.settings.successStatusValue !== normalizedSuccessStatus) {
      this.settings.successStatusValue = normalizedSuccessStatus;
      shouldSave = true;
    }

    if (
      !Array.isArray(this.settings.webhookProfiles) ||
      this.settings.webhookProfiles.length === 0
    ) {
      this.settings.webhookProfiles = [
        {
          id: 'default-webhook',
          name: '默认 Webhook',
          url: this.settings.n8nWebhookUrl || DEFAULT_SETTINGS.n8nWebhookUrl,
        },
      ];
      shouldSave = true;
    }

    this.settings.webhookProfiles.forEach((profile) => {
      const hasDefaultIdentity =
        (profile.id === 'default-webhook' ||
          profile.name === 'Cyrus' ||
          profile.name === '默认 Webhook');
      const isLegacyDefault =
        hasDefaultIdentity &&
        (profile.url === LEGACY_N8N_WEBHOOK_URL ||
          profile.url === LEGACY_DEFAULT_N8N_WEBHOOK_URL);
      if (isLegacyDefault) {
        profile.name = profile.name === 'Cyrus' ? 'Local n8n' : profile.name;
        profile.url = DEFAULT_N8N_WEBHOOK_URL;
        shouldSave = true;
      }
    });

    if (!this.settings.activeWebhookId) {
      this.settings.activeWebhookId = this.settings.webhookProfiles[0].id;
      shouldSave = true;
    }

    const activeProfile =
      this.settings.webhookProfiles.find((p) => p.id === this.settings.activeWebhookId) ||
      this.settings.webhookProfiles[0];
    if (this.settings.n8nWebhookUrl !== activeProfile.url) {
      this.settings.n8nWebhookUrl = activeProfile.url;
      shouldSave = true;
    }

    if (shouldSave) {
      await this.saveSettings();
    }
  }

  async saveSettings() {
    this.trimHistory();
    // data.json 只存配置；history / webhookHistory 落在 history.json（见 queueHistorySave）
    await this.saveData({ ...this.settings, history: [], webhookHistory: [] });
    this.queueHistorySave();
  }

  // ===== history.json 读写 =====

  private get historyFilePath(): string {
    const dir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    return `${dir}/history.json`;
  }

  private async readHistoryFile(): Promise<{
    history?: unknown[];
    webhookHistory?: unknown[];
  } | null> {
    try {
      const adapter = this.app.vault.adapter;
      if (!(await adapter.exists(this.historyFilePath))) {
        return null;
      }
      const raw = await adapter.read(this.historyFilePath);
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (error) {
      console.error('[VideoSummary] 读取 history.json 失败（历史将从空开始）', error);
      return null;
    }
  }

  private async writeHistoryFile(): Promise<void> {
    try {
      const payload = {
        version: 1,
        updatedAt: new Date().toISOString(),
        history: this.settings.history || [],
        webhookHistory: this.settings.webhookHistory || [],
      };
      await this.app.vault.adapter.write(this.historyFilePath, JSON.stringify(payload));
    } catch (error) {
      console.error('[VideoSummary] 写入 history.json 失败', error);
    }
  }

  /** 延迟合并写入，避免设置页输入等高频 saveSettings 反复写大文件 */
  private queueHistorySave() {
    if (this.historySaveTimer !== null) {
      window.clearTimeout(this.historySaveTimer);
    }
    this.historySaveTimer = window.setTimeout(() => {
      this.historySaveTimer = null;
      void this.writeHistoryFile();
    }, 1200);
  }

  /** 历史限容：history 按设置上限裁掉最旧的；webhookHistory（最新在前）固定上限 50 */
  private trimHistory() {
    const limit = Math.max(50, this.settings.historyLimit ?? DEFAULT_HISTORY_LIMIT);
    const history = this.settings.history;
    if (Array.isArray(history) && history.length > limit) {
      history.splice(0, history.length - limit);
    }
    const webhookHistory = this.settings.webhookHistory;
    if (Array.isArray(webhookHistory) && webhookHistory.length > 50) {
      webhookHistory.splice(50);
    }
  }

  // ===== history.json 读写结束 =====

  private getActiveProcessingEndpoint(): string {
    if (this.settings?.activeBackend === 'codex-worker') {
      return this.settings.codexWorkerUrl || DEFAULT_SETTINGS.codexWorkerUrl;
    }
    return this.settings?.n8nWebhookUrl ?? DEFAULT_SETTINGS.n8nWebhookUrl;
  }

  getCodexWorkerDashboardUrl(): string {
    const endpoint = this.settings?.codexWorkerUrl || DEFAULT_SETTINGS.codexWorkerUrl;
    try {
      const url = new URL(endpoint);
      url.pathname = '/dashboard';
      url.search = '';
      url.hash = '';
      return url.toString();
    } catch {
      return 'http://127.0.0.1:8787/dashboard';
    }
  }

  private initializeApiInstance(url?: string) {
    const targetUrl = url ?? this.getActiveProcessingEndpoint();
    const backend = this.settings?.activeBackend ?? DEFAULT_SETTINGS.activeBackend;
    this.api = new VideoSummaryAPI(
      targetUrl,
      this.app.vault,
      // 用插件自身的安装目录，而不是写死某个 vault 的配置目录名（如 .obsidian_mac），保证可移植
      `${this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`}/data`,
      this.settings.payloadKeys,
      backend,
    );
    this.api.setWebhookHistory(this.settings.webhookHistory || []);
    this.api.setAiModel(this.settings.aiModel);
    this.api.onWebhookHistoryChange(async (history) => {
      this.settings.webhookHistory = history;
      await this.saveSettings();
    });
    this.api.setDebug(this.settings.enableDebugMode);
    this.api.setExpandShortLinks(this.settings.expandShortLinks !== false);

    if (this.settings.enableCache !== false) {
      this.api.setCacheConfig(1000, this.settings.cacheExpiryDays);
      this.api.setCacheEnabled(true);
    } else {
      this.api.setCacheEnabled(false);
    }
  }

  reinitializeApi(url?: string) {
    this.initializeApiInstance(url);
  }

  async setActiveWebhook(
    profileId: string,
    options: { silent?: boolean } = {},
  ): Promise<WebhookProfile | null> {
    const profile = this.settings.webhookProfiles.find((p) => p.id === profileId);
    if (!profile) {
      new Notice('未找到对应的 Webhook 配置');
      return null;
    }

    this.settings.activeWebhookId = profileId;
    this.settings.activeBackend = 'n8n';
    this.settings.n8nWebhookUrl = profile.url;
    this.initializeApiInstance(profile.url);
    await this.saveSettings();

    if (!options.silent) {
      new Notice(`已切换到 ${profile.name || profile.url}`);
    }

    return profile;
  }

  getActiveWebhookProfile(): WebhookProfile | undefined {
    return this.settings.webhookProfiles.find((p) => p.id === this.settings.activeWebhookId);
  }

  async setActiveBackend(backend: ProcessingBackend) {
    this.settings.activeBackend = backend;
    this.initializeApiInstance();
    await this.saveSettings();
  }

  private extractVideoUrl(content: string): string | null {
    return VideoUtils.extractVideoUrl(content);
  }

  private hasVideoContent(content: string): boolean {
    return VideoUtils.hasVideoMetadata(content);
  }

  private getProcessingStatus(content: string): string | null {
    return VideoUtils.getProcessingStatus(content);
  }

  private isValidVideoUrl(url: string): boolean {
    return VideoUtils.isValidVideoUrl(url);
  }

  private extractProvidedTranscript(content: string): string | null {
    return VideoUtils.extractProvidedTranscript(content);
  }

  private extractLocalFileName(content: string): string | null {
    return VideoUtils.extractLocalFileName(content);
  }

  /**
   * 命令面板 / 右键菜单的处理入口。
   * 自 2.3.0 起统一走任务队列，这样命令触发的处理也能在侧栏看到进度、取消和失败原因，
   * 状态写回、历史记录、错误处理都由 JobService 统一负责（不再各写一份）。
   */
  private async processFileWithMode(file: TFile, mode: ProcessingMode) {
    const job = await this.jobService.submitFile(file, {
      mode,
      language: this.settings.defaultLanguage,
      useCache: this.settings.enableCache !== false,
      previewBeforeWrite: this.settings.previewBeforeWrite === true,
    });
    if (!job) return;

    const finished = await this.jobs.waitFor(job.id);
    if (!finished) return;

    if (finished.state === 'error') {
      new Notice(`处理失败: ${finished.error || '未知错误'}`, 8000);
      throw new Error(finished.error || '处理失败');
    }
    if (finished.state === 'cancelled') {
      new Notice('处理已取消');
      return;
    }
    if (finished.state === 'review') {
      new Notice(`${this.getModeDisplayText(mode)}已就绪，去侧栏确认写入`, 6000);
      return;
    }
    new Notice(`${this.getModeDisplayText(mode)}完成`);
  }

  /**
   * 刷新视频总结视图
   */
  private getModeDisplayText(mode: ProcessingMode): string {
    switch (mode) {
      case 'summary':
        return '视频总结';
      case 'transcript-only':
        return '文稿提取';
      default:
        return '视频信息';
    }
  }


  /**
   * 自动重命名文件
   */
  private async autoRenameFile(file: TFile, videoTitle: string, body: string): Promise<void> {
    try {
      // 确定要使用的标题
      let titleToUse = '';

      // 规则1：如果YAML中有video_title字段且不为空，使用video_title
      if (videoTitle && videoTitle.trim()) {
        titleToUse = videoTitle.trim();
      } else {
        // 规则2：其他情况使用正文标题
        const bodyTitle = this.extractBodyTitle(body);
        if (bodyTitle && bodyTitle.trim()) {
          titleToUse = bodyTitle.trim();
        } else {
          // 如果都没有，不重命名
          return;
        }
      }

      // 清理文件名中的非法字符
      const cleanTitle = titleToUse.replace(/[<>:"/\\|?*]/g, '_').trim();
      if (!cleanTitle) {
        return; // 如果清理后为空，不重命名
      }

      // 构建新文件名（保持原有路径）
      const newFileName = `${cleanTitle}.md`;

      // 如果文件在子文件夹中，保持原有路径
      if (file.parent && file.parent.path !== '') {
        const newPath = `${file.parent.path}/${newFileName}`;

        // 检查新路径是否已存在
        const existingFile = this.app.vault.getAbstractFileByPath(newPath);
        if (existingFile && existingFile !== file) {
          console.log(`文件 ${newPath} 已存在，跳过重命名`);
          return;
        }

        // 重命名文件（保持路径）
        await this.app.fileManager.renameFile(file, newPath);
        console.log(`文件已重命名为: ${newPath}`);
      } else {
        // 文件在根目录
        const existingFile = this.app.vault.getAbstractFileByPath(newFileName);
        if (existingFile && existingFile !== file) {
          console.log(`文件 ${newFileName} 已存在，跳过重命名`);
          return;
        }

        // 重命名文件
        await this.app.fileManager.renameFile(file, newFileName);
        console.log(`文件已重命名为: ${newFileName}`);
      }
    } catch (error) {
      console.error(`重命名文件失败: ${error.message}`);
    }
  }

  /**
   * 从正文中提取标题
   */
  private extractBodyTitle(body: string): string | null {
    // 移除frontmatter部分
    const bodyOnly = body.replace(/^---\n[\s\S]*?\n---\n/, '');

    // 查找第一个标题（# 开头）
    const titleMatch = bodyOnly.match(/^#\s+(.+)$/m);
    if (titleMatch) {
      return titleMatch[1].trim();
    }

    // 查找第一个二级标题（## 开头）
    const h2Match = bodyOnly.match(/^##\s+(.+)$/m);
    if (h2Match) {
      return h2Match[1].trim();
    }

    // 查找第一个三级标题（### 开头）
    const h3Match = bodyOnly.match(/^###\s+(.+)$/m);
    if (h3Match) {
      return h3Match[1].trim();
    }

    // 如果没有找到标题，返回null
    return null;
  }

  private async markAsExcluded(editor: Editor, view: MarkdownView) {
    try {
      const file = view.file;
      if (!file) {
        new Notice('无法获取当前文件');
        return;
      }

      // 设置状态为排除
      await this.noteProcessor.setProcessingStatus(file, 'excluded');
      new Notice('已标记为非视频笔记');
    } catch (error) {
      new Notice(`标记为非视频笔记失败: ${error.message}`);
    }
  }

  /**
   * obsidian://video-summary 协议入口：一步完成"建笔记 + 触发处理"。
   *
   * 支持参数：
   * - url（必填）：视频链接
   * - title：笔记标题（缺省用日期时间）
   * - mode：summary | transcript-only | info-only（缺省用默认模式）
   * - folder：保存目录（缺省用设置里的输出文件夹）
   * - timestamp_link：带时间戳的链接（写入正文，便于回跳）
   *
   * 示例：obsidian://video-summary?vault=Ithaca&url=https%3A%2F%2Fb23.tv%2Fxxxx&title=xxx
   */
  private async handleProtocolRequest(params: Record<string, string>) {
    try {
      const rawUrl = (params.url || params.link || '').trim();
      if (!rawUrl) {
        new Notice('video-summary 协议调用缺少 url 参数', 6000);
        return;
      }

      const url = VideoUtils.cleanVideoUrlKeepP(rawUrl);
      if (!VideoUtils.isValidVideoUrl(url)) {
        new Notice(`不是受支持的视频链接: ${url}`, 6000);
        return;
      }

      // 标题与文件名
      const fallbackTitle = `Video ${new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '-')}`;
      const title = (params.title || '').trim() || fallbackTitle;
      const cleanTitle = title.replace(/[<>:"/\\|?*#^[\]]/g, '_').trim() || fallbackTitle;

      // 目录（参数优先，其次设置的输出文件夹）
      const folder = ((params.folder ?? this.settings.outputFolder) || '')
        .trim()
        .replace(/^\/+|\/+$/g, '');
      if (folder && !this.app.vault.getAbstractFileByPath(folder)) {
        try {
          await this.app.vault.createFolder(folder);
        } catch {
          // 目录已存在或创建失败——后面 create 时再报错
        }
      }

      // 冲突时追加编号
      const basePath = folder ? `${folder}/${cleanTitle}` : cleanTitle;
      let notePath = `${basePath}.md`;
      let suffix = 1;
      while (this.app.vault.getAbstractFileByPath(notePath)) {
        suffix += 1;
        notePath = `${basePath} ${suffix}.md`;
      }

      const timestampLink = (params.timestamp_link || '').trim();
      const bodyLink = timestampLink || rawUrl;
      const content = [
        '---',
        `link: ${url}`,
        'video_summary: true',
        'source_type: video',
        'video_summary_status: pending',
        'status: pending',
        'source: protocol',
        `captured_at: ${new Date().toISOString()}`,
        '---',
        `# ${title}`,
        '',
        bodyLink,
        '',
      ].join('\n');

      const file = await this.app.vault.create(notePath, content);
      new Notice(`已创建笔记，开始处理: ${file.basename}`);

      // 打开笔记，便于观察处理进度
      const leaf = this.app.workspace.getLeaf(true);
      await leaf.openFile(file);

      // 触发处理
      const requestedMode = (params.mode || '').trim() as ProcessingMode;
      const mode: ProcessingMode = ['summary', 'transcript-only', 'info-only'].includes(
        requestedMode,
      )
        ? requestedMode
        : this.settings.defaultMode;
      await this.processFileWithMode(file, mode);
    } catch (error) {
      new Notice(`video-summary 协议处理失败: ${this.formatErrorForNotice(error)}`, 8000);
    }
  }
}

function normalizeSuccessStatusValue(value: unknown): string {
  const normalized = String(value ?? '').trim();
  if (!normalized) return DEFAULT_SETTINGS.successStatusValue;

  const reservedStatuses = new Set([
    'pending',
    'running',
    'error',
    'excluded',
    '📺',
    '⏳',
    '❌',
    '⛔',
    '⛔️',
    '待处理',
    '处理中',
    '处理失败',
    '非视频笔记',
  ]);
  return reservedStatuses.has(normalized.toLowerCase())
    ? DEFAULT_SETTINGS.successStatusValue
    : normalized;
}

class VideoSummarySettingTab extends PluginSettingTab {
  plugin: VideoSummaryPlugin;
  private activeTab: 'general' | 'workflow' | 'core' | 'advanced' = 'general';

  constructor(app: App, plugin: VideoSummaryPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass('video-summary-settings-tabs-container');
    containerEl.addClass('vs-settings');

    this.renderSettingsHeader(containerEl);

    // 渲染标签页切换按钮
    this.renderTabs(containerEl);

    const tabContent = containerEl.createDiv({ cls: 'tab-content-container' });

    // 根据当前选中的标签渲染内容
    switch (this.activeTab) {
      case 'general':
        this.createSetupGuideSection(tabContent);
        this.createBasicSection(tabContent);
        break;
      case 'workflow':
        this.createApiSection(tabContent);
        this.createCookiesSection(tabContent);
        this.createPlatformMatrixSection(tabContent);
        break;
      case 'core':
        this.createQuickProcessingSection(tabContent);
        this.createFileProcessingSection(tabContent);
        break;
      case 'advanced':
        this.createPayloadKeysSection(tabContent);
        this.createAdvancedSection(tabContent);
        break;
    }
  }

  /** 页头：渐变图标 + 标题 + 版本副行 + 后端状态胶囊（替代原来的 emoji h2） */
  private renderSettingsHeader(containerEl: HTMLElement) {
    const header = containerEl.createDiv({ cls: 'vs-settings-header' });
    const badge = header.createDiv({ cls: 'vs-settings-badge' });
    setIcon(badge, 'clapperboard');

    const text = header.createDiv({ cls: 'vs-settings-heading' });
    text.createDiv({ text: '视频总结', cls: 'vs-settings-title' });
    const backendLabel =
      this.plugin.settings.activeBackend === 'codex-worker' ? 'Codex Worker' : 'n8n webhook';
    text.createDiv({
      text: `v${this.plugin.manifest.version} · 连接 ${backendLabel} 处理视频、文稿与笔记`,
      cls: 'vs-settings-sub',
    });

    const pill = header.createEl('button', {
      cls: 'vs-settings-pill',
      attr: { type: 'button', title: '点击测试后端连接' },
    });
    const dot = pill.createSpan({ cls: 'vs-backend-dot' });
    const label = pill.createSpan({ text: '未检测' });
    pill.addEventListener('click', async () => {
      dot.className = 'vs-backend-dot is-checking';
      label.setText('检测中…');
      try {
        const result = await this.plugin.api.testConnection();
        dot.className = `vs-backend-dot ${result.success ? 'is-online' : 'is-offline'}`;
        label.setText(
          result.success ? `后端在线 · ${result.durationMs ?? 0}ms` : '后端离线',
        );
      } catch {
        dot.className = 'vs-backend-dot is-offline';
        label.setText('后端离线');
      }
    });
  }

  /** 统一的分区卡片：lucide 图标 + 标题，取代各处 emoji h3 */
  private sectionCard(
    containerEl: HTMLElement,
    icon: string,
    title: string,
    extraCls = '',
  ): { section: HTMLElement; titleRow: HTMLElement } {
    const section = containerEl.createDiv({
      cls: `vs-settings-card ${extraCls}`.trim(),
    });
    const titleRow = section.createDiv({ cls: 'vs-settings-card-title' });
    const iconEl = titleRow.createSpan({ cls: 'vs-settings-card-icon' });
    setIcon(iconEl, icon);
    titleRow.createSpan({ text: title, cls: 'vs-settings-card-text' });
    return { section, titleRow };
  }

  private renderTabs(containerEl: HTMLElement) {
    const tabsContainer = containerEl.createDiv({ cls: 'settings-tabs-bar' });

    const tabs: { id: typeof this.activeTab; label: string; icon: string }[] = [
      { id: 'general', label: '通用', icon: 'settings' },
      { id: 'workflow', label: '工作流', icon: 'link' },
      { id: 'core', label: '核心功能', icon: 'zap' },
      { id: 'advanced', label: '高级', icon: 'wrench' },
    ];

    const seg = tabsContainer.createDiv({ cls: 'vs-seg' });
    tabs.forEach((tab) => {
      const tabBtn = seg.createEl('button', {
        cls: `vs-seg-item${this.activeTab === tab.id ? ' is-active' : ''}`,
        attr: { type: 'button' },
      });
      const iconEl = tabBtn.createSpan({ cls: 'vs-seg-icon' });
      setIcon(iconEl, tab.icon);
      tabBtn.createSpan({ text: tab.label });
      tabBtn.onclick = () => {
        this.activeTab = tab.id;
        this.display();
      };
    });
  }

  private createSetupGuideSection(containerEl: HTMLElement) {
    const { section, titleRow } = this.sectionCard(
      containerEl,
      'shield-check',
      '安装检查',
      'setup-guide-section',
    );
    titleRow.addClass('setup-guide-title-row');

    if (this.plugin.settings.setupGuideDismissed) {
      new Setting(section)
        .setName('安装检查已收起')
        .setDesc('需要排查连接问题时，可以重新显示检查清单。')
        .addButton((button) =>
          button.setButtonText('显示检查清单').onClick(async () => {
            this.plugin.settings.setupGuideDismissed = false;
            await this.plugin.saveSettings();
            this.display();
          }),
        );
      return;
    }

    section.createEl('p', {
      text: '第一次使用时，先确认这几项。连接诊断会发送一个轻量测试请求，不会处理真实视频。',
      cls: 'setting-item-description',
    });

    const checks = this.getSetupChecks();
    const list = section.createDiv({ cls: 'setup-check-list' });
    checks.forEach((check) => {
      const row = list.createDiv({ cls: `setup-check-item is-${check.state}` });
      row.createSpan({ text: this.getSetupCheckIcon(check.state), cls: 'setup-check-icon' });
      const textWrap = row.createDiv({ cls: 'setup-check-text' });
      textWrap.createEl('strong', { text: check.label });
      textWrap.createEl('span', { text: check.detail });
    });

    const resultBox = section.createDiv({ cls: 'setup-diagnostic-result' });

    new Setting(section)
      .setName('连接诊断')
      .setDesc('如果这里失败，优先按诊断建议处理，再查看 n8n Execution 日志。')
      .addButton((button) =>
        button
          .setButtonText('运行诊断')
          .setCta()
          .onClick(async () => {
            button.setDisabled(true);
            button.setButtonText('诊断中...');
            resultBox.empty();
            resultBox.createEl('p', { text: '正在发送测试请求...' });

            try {
              const result = await this.plugin.api.testConnection();
              this.renderConnectionResult(resultBox, result);
            } catch (error) {
              this.renderConnectionResult(resultBox, {
                success: false,
                error: this.plugin.formatErrorForNotice(error),
                hint: '确认服务已启动后重试；必要时打开调试模式查看控制台。',
              });
            } finally {
              button.setDisabled(false);
              button.setButtonText('运行诊断');
            }
          }),
      )
      .addButton((button) =>
        button.setButtonText('收起').onClick(async () => {
          this.plugin.settings.setupGuideDismissed = true;
          await this.plugin.saveSettings();
          this.display();
        }),
      );
  }

  private getSetupChecks(): SetupCheckItem[] {
    const backend = this.plugin.settings.activeBackend || DEFAULT_SETTINGS.activeBackend;
    const activeProfile = this.plugin.getActiveWebhookProfile();
    const endpoint =
      backend === 'codex-worker'
        ? this.plugin.settings.codexWorkerUrl
        : activeProfile?.url || this.plugin.settings.n8nWebhookUrl;
    const modelList = this.plugin.settings.customAiModels || [];
    const currentModel = this.plugin.settings.aiModel;

    const endpointCheck = this.getEndpointSetupCheck(endpoint || '', backend);

    return [
      {
        label: '处理后端',
        state: backend ? 'ready' : 'missing',
        detail:
          backend === 'codex-worker'
            ? '当前使用 Codex Video Worker。'
            : '当前使用 n8n / 兼容 Webhook。',
      },
      endpointCheck,
      {
        label: 'Workflow 版本',
        state: 'warning',
        detail: `推荐版本 ${RECOMMENDED_WORKFLOW.version}；运行连接诊断可读取当前 n8n workflow 回传的版本信息。`,
      },
      {
        label: '处理模型',
        state: modelList.includes(currentModel) ? 'ready' : 'warning',
        detail: modelList.includes(currentModel)
          ? `默认模型 ${currentModel} 已在列表中。`
          : `默认模型 ${currentModel || '未设置'} 不在模型列表中，n8n Switch 可能匹配失败。`,
      },
      {
        label: '本地文件',
        state: 'warning',
        detail: 'Docker 场景建议只填 uploads 目录内的文件名或相对路径，不要直接填 macOS 绝对路径。',
      },
    ];
  }

  private getEndpointSetupCheck(endpoint: string, backend: ProcessingBackend): SetupCheckItem {
    const trimmedEndpoint = endpoint.trim();
    if (!trimmedEndpoint) {
      return {
        label: '服务 URL',
        state: 'missing',
        detail: '还没有填写处理服务 URL。',
      };
    }

    if (backend === 'n8n' && trimmedEndpoint === LEGACY_N8N_WEBHOOK_URL) {
      return {
        label: '服务 URL',
        state: 'warning',
        detail: `仍在使用旧路径 ${LEGACY_N8N_WEBHOOK_URL}，公开版工作流默认路径是 ${DEFAULT_N8N_WEBHOOK_URL}。`,
      };
    }

    if (backend === 'n8n' && !trimmedEndpoint.includes('/webhook/')) {
      return {
        label: '服务 URL',
        state: 'warning',
        detail: 'n8n URL 通常应包含 /webhook/ 路径。',
      };
    }

    return {
      label: '服务 URL',
      state: 'ready',
      detail: trimmedEndpoint,
    };
  }

  private getSetupCheckIcon(state: SetupCheckItem['state']): string {
    switch (state) {
      case 'ready':
        return 'OK';
      case 'warning':
        return '!';
      default:
        return 'X';
    }
  }

  private renderConnectionResult(containerEl: HTMLElement, result: ConnectionTestResult) {
    containerEl.empty();
    containerEl.removeClass('is-success');
    containerEl.removeClass('is-error');
    containerEl.addClass(result.success ? 'is-success' : 'is-error');

    containerEl.createEl('strong', {
      text: result.success ? '连接诊断通过' : '连接诊断失败',
    });

    const details = [
      result.durationMs !== undefined ? `耗时 ${result.durationMs}ms` : '',
      result.status ? `HTTP ${result.status}` : '',
      result.error || '',
    ]
      .filter(Boolean)
      .join(' | ');

    if (details) {
      containerEl.createEl('p', { text: details });
    }

    if (result.hint) {
      containerEl.createEl('p', { text: `建议: ${result.hint}` });
    }

    if (result.workflow) {
      const workflow = result.workflow;
      const workflowLines = [
        workflow.name ? `名称: ${workflow.name}` : '',
        workflow.version ? `版本: ${workflow.version}` : '',
        workflow.variant ? `类型: ${workflow.variant}` : '',
        workflow.webhookPath ? `Path: ${workflow.webhookPath}` : '',
        workflow.models?.length ? `模型标签: ${workflow.models.join(', ')}` : '',
        workflow.requiredTools?.length ? `依赖工具: ${workflow.requiredTools.join(', ')}` : '',
      ].filter(Boolean);
      if (workflowLines.length > 0) {
        containerEl.createEl('pre', { text: workflowLines.join('\n') });
      }
    }

    if (result.warnings && result.warnings.length > 0) {
      const warningList = containerEl.createEl('ul', { cls: 'setup-warning-list' });
      result.warnings.forEach((warning) => warningList.createEl('li', { text: warning }));
    }

    if (result.bodySnippet) {
      containerEl.createEl('pre', { text: result.bodySnippet });
    }
  }

  private createPlatformMatrixSection(containerEl: HTMLElement) {
    const { section } = this.sectionCard(containerEl, 'layout-grid', '平台能力矩阵', 'platform-matrix-section');
    section.createEl('p', {
      text: '不同平台的可用性不一样。优先用本地文件、公开 YouTube/Bilibili 或已粘贴文稿；短视频平台通常需要 cookies。',
      cls: 'setting-item-description',
    });

    const grid = section.createDiv({ cls: 'platform-matrix-grid' });
    PLATFORM_CAPABILITIES.forEach((item) => {
      const card = grid.createDiv({ cls: `platform-matrix-card is-${item.status}` });
      const header = card.createDiv({ cls: 'platform-matrix-card-header' });
      header.createEl('strong', { text: item.platform });
      header.createSpan({
        text: this.getPlatformStatusLabel(item.status),
        cls: 'platform-status-label',
      });
      card.createEl('p', { text: `输入: ${item.input}` });
      card.createEl('p', { text: `要求: ${item.requirements}` });
      card.createEl('p', { text: item.notes });
    });
  }

  private getPlatformStatusLabel(status: PlatformCapability['status']) {
    switch (status) {
      case 'recommended':
        return '推荐';
      case 'supported':
        return '可用';
      case 'limited':
        return '受限';
      default:
        return '本地';
    }
  }

  /**
   * Cookies 管理：定位 n8n 的 docker/cookies 目录，一键打开 + 检测各平台 cookies 文件状态。
   * 解决 Bilibili HTTP 412 / 抖音小红书下载失败时"cookies 到底放没放、过没过期"的排查痛点。
   */
  private createCookiesSection(containerEl: HTMLElement) {
    const { section } = this.sectionCard(containerEl, 'cookie', 'Cookies 管理');
    section.createEl('p', {
      text: '受限平台（Bilibili / 抖音 / 小红书 / TikTok）经常需要浏览器导出的 cookies。目录一般是 n8n docker 项目里的 docker/cookies；文件名如 bilibili_cookies.txt。',
      cls: 'setting-item-description',
    });

    const resultBox = section.createDiv({ cls: 'setup-diagnostic-result' });

    new Setting(section)
      .setName('Cookies 目录')
      .setDesc('docker/cookies 的绝对路径，例如 /Users/you/n8n-project/docker/cookies')
      .addText((text) =>
        text
          .setPlaceholder('/path/to/docker/cookies')
          .setValue(this.plugin.settings.cookiesDirPath || '')
          .onChange(async (value) => {
            this.plugin.settings.cookiesDirPath = value.trim();
            await this.plugin.saveSettings();
          }),
      )
      .addButton((button) =>
        button.setButtonText('打开目录').onClick(() => {
          const dir = (this.plugin.settings.cookiesDirPath || '').trim();
          if (!dir) {
            new Notice('请先填写 Cookies 目录路径');
            return;
          }
          try {
            const electron = (window as any).require?.('electron');
            if (!electron?.shell?.openPath) {
              new Notice('当前环境不支持打开系统目录（仅桌面端可用）');
              return;
            }
            electron.shell.openPath(dir);
          } catch (error) {
            new Notice(`打开目录失败: ${(error as Error).message}`);
          }
        }),
      )
      .addButton((button) =>
        button
          .setButtonText('检测 cookies')
          .setCta()
          .onClick(() => {
            this.renderCookiesCheckResult(resultBox);
          }),
      );
  }

  /** 扫描 cookies 目录，列出 *_cookies.txt 的存在性与新鲜度 */
  private renderCookiesCheckResult(containerEl: HTMLElement) {
    containerEl.empty();
    containerEl.removeClass('is-success');
    containerEl.removeClass('is-error');

    const dir = (this.plugin.settings.cookiesDirPath || '').trim();
    if (!dir) {
      containerEl.addClass('is-error');
      containerEl.createEl('p', { text: '请先填写 Cookies 目录路径。' });
      return;
    }

    let fs: any;
    let pathModule: any;
    try {
      const nodeRequire = (window as any).require;
      fs = nodeRequire?.('fs');
      pathModule = nodeRequire?.('path');
    } catch {
      // fallthrough
    }
    if (!fs || !pathModule) {
      containerEl.addClass('is-error');
      containerEl.createEl('p', { text: '当前环境不支持文件系统访问（仅桌面端可用）。' });
      return;
    }

    try {
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        containerEl.addClass('is-error');
        containerEl.createEl('strong', { text: '目录不存在' });
        containerEl.createEl('p', { text: `找不到目录: ${dir}` });
        return;
      }

      const STALE_DAYS = 30;
      const files: string[] = fs
        .readdirSync(dir)
        .filter((name: string) => /_cookies\.txt$/i.test(name) || /^cookies\.txt$/i.test(name));

      if (files.length === 0) {
        containerEl.addClass('is-error');
        containerEl.createEl('strong', { text: '没有找到任何 cookies 文件' });
        containerEl.createEl('p', {
          text: `目录里没有 *_cookies.txt。Bilibili 需要 bilibili_cookies.txt；用浏览器扩展（如 Get cookies.txt LOCALLY）导出后放进来即可。`,
        });
        return;
      }

      containerEl.addClass('is-success');
      containerEl.createEl('strong', { text: `找到 ${files.length} 个 cookies 文件` });

      const now = Date.now();
      const list = containerEl.createEl('ul', { cls: 'setup-warning-list' });
      let hasStale = false;
      files.forEach((name: string) => {
        try {
          const stat = fs.statSync(pathModule.join(dir, name));
          const ageDays = Math.floor((now - stat.mtimeMs) / (24 * 60 * 60 * 1000));
          const sizeKb = Math.max(1, Math.round(stat.size / 1024));
          const stale = ageDays > STALE_DAYS;
          if (stale) hasStale = true;
          list.createEl('li', {
            text: `${stale ? '⚠️ ' : ''}${name} — ${sizeKb}KB，更新于 ${ageDays} 天前${stale ? `（超过 ${STALE_DAYS} 天，可能已失效）` : ''}`,
          });
        } catch {
          list.createEl('li', { text: `${name} — 无法读取文件信息` });
        }
      });

      if (!files.some((name: string) => /^bilibili_/i.test(name))) {
        containerEl.createEl('p', {
          text: '提示: 未发现 bilibili_cookies.txt。遇到 Bilibili HTTP 412 时需要它。',
        });
      }
      if (hasStale) {
        containerEl.createEl('p', {
          text: '有文件较旧。平台 cookies 通常几周内失效，下载失败时优先重新导出。',
        });
      }
    } catch (error) {
      containerEl.addClass('is-error');
      containerEl.createEl('p', { text: `检测失败: ${(error as Error).message}` });
    }
  }

  private createWorkflowCompatibilityCard(containerEl: HTMLElement) {
    const card = containerEl.createDiv({ cls: 'workflow-compatibility-card' });
    card.createEl('div', { text: '推荐 workflow', cls: 'vs-subsection-title' });
    card.createEl('p', {
      text: '连接诊断会读取测试分支返回的 workflow 元数据，用来发现旧 workflow、path 不匹配或模型标签不一致。',
      cls: 'setting-item-description',
    });

    const rows = [
      ['推荐版本', RECOMMENDED_WORKFLOW.version],
      ['Webhook Path', RECOMMENDED_WORKFLOW.webhookPath],
      ['推荐模型标签', RECOMMENDED_WORKFLOW.models.join(', ')],
      ['依赖工具', RECOMMENDED_WORKFLOW.requiredTools.join(', ')],
      ['本地文件目录', RECOMMENDED_WORKFLOW.uploadsPath],
    ];

    const table = card.createEl('table', { cls: 'workflow-compatibility-table' });
    rows.forEach(([label, value]) => {
      const row = table.createEl('tr');
      row.createEl('th', { text: label });
      row.createEl('td', { text: value });
    });

    const activeEndpoint =
      this.plugin.settings.activeBackend === 'codex-worker'
        ? this.plugin.settings.codexWorkerUrl
        : this.plugin.getActiveWebhookProfile()?.url || this.plugin.settings.n8nWebhookUrl;
    card.createEl('p', {
      text: `当前入口: ${activeEndpoint || '未设置'}`,
      cls: 'setting-item-description',
    });
  }

  private createApiSection(containerEl: HTMLElement) {
    const { section } = this.sectionCard(containerEl, 'link', '主入口与 API 配置');

    this.createWorkflowCompatibilityCard(section);

    new Setting(section)
      .setName('主处理后端')
      .setDesc(
        'Obsidian 插件是主入口：选择当前一键总结、批量处理、重新处理时要调用 n8n 还是本地 Codex worker。',
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption('n8n', 'n8n / 兼容 Webhook')
          .addOption('codex-worker', 'Codex Video Worker')
          .setValue(this.plugin.settings.activeBackend || DEFAULT_SETTINGS.activeBackend)
          .onChange(async (value) => {
            await this.plugin.setActiveBackend(value as ProcessingBackend);
            new Notice(
              value === 'codex-worker'
                ? '已切换到 Codex Video Worker'
                : '已切换到 n8n / 兼容 Webhook',
            );
            this.display();
          }),
      );

    new Setting(section)
      .setName('Codex Worker URL')
      .setDesc('本地 Codex 视频处理服务的同步入口。控制台默认位于同一 host 的 /dashboard。')
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.codexWorkerUrl)
          .setValue(this.plugin.settings.codexWorkerUrl || DEFAULT_SETTINGS.codexWorkerUrl)
          .onChange(async (value) => {
            this.plugin.settings.codexWorkerUrl = value.trim() || DEFAULT_SETTINGS.codexWorkerUrl;
            if (this.plugin.settings.activeBackend === 'codex-worker') {
              this.plugin.reinitializeApi();
            }
            await this.plugin.saveSettings();
          }),
      )
      .addButton((button) =>
        button.setButtonText('打开控制台').onClick(() => {
          this.plugin.openCodexWorkerDashboard();
        }),
      );

    const webhookSetting = new Setting(section)
      .setName('默认 n8n / 兼容 Webhook')
      .setDesc(
        '为不同工作流保存多个 Webhook。选择这里的默认项会把主处理后端切回 n8n / 兼容 Webhook。',
      );

    let webhookDropdown: DropdownComponent | null = null;

    webhookSetting.addDropdown((dropdown) => {
      webhookDropdown = dropdown;
      dropdown.onChange(async (value) => {
        await this.plugin.setActiveWebhook(value);
        refreshDropdownOptions();
      });
    });

    const refreshDropdownOptions = () => {
      if (!webhookDropdown) return;
      webhookDropdown.selectEl.empty();
      this.plugin.settings.webhookProfiles.forEach((profile) => {
        const option = document.createElement('option');
        option.value = profile.id;
        option.textContent = profile.name || profile.url || '未命名 Webhook';
        webhookDropdown!.selectEl.appendChild(option);
      });
      if (this.plugin.settings.activeWebhookId) {
        try {
          webhookDropdown.setValue(this.plugin.settings.activeWebhookId);
        } catch {
          // ignore invalid value errors
        }
      }
    };

    refreshDropdownOptions();

    const workflowDiagnosticResult = section.createDiv({ cls: 'setup-diagnostic-result' });

    webhookSetting.addButton((button) =>
      button.setButtonText('测试当前后端').onClick(async () => {
        button.setDisabled(true);
        button.setButtonText('测试中...');
        try {
          const res = await this.plugin.api.testConnection();
          const label =
            this.plugin.settings.activeBackend === 'codex-worker'
              ? 'Codex Worker'
              : 'n8n / 兼容 Webhook';
          if (res.success) {
            new Notice(`${label} 连接成功（${res.durationMs}ms）`, 3000);
          } else {
            const hint = res.hint ? `\n建议: ${res.hint}` : '';
            new Notice(`${label} 连接失败: ${res.error || '未知错误'}${hint}`, 8000);
          }
          this.renderConnectionResult(workflowDiagnosticResult, res);
        } catch (error) {
          this.renderConnectionResult(workflowDiagnosticResult, {
            success: false,
            error: this.plugin.formatErrorForNotice(error),
          });
        } finally {
          button.setDisabled(false);
          button.setButtonText('测试当前后端');
        }
      }),
    );

    const profilesContainer = section.createEl('div', { cls: 'webhook-profiles-container' });

    const renderProfiles = () => {
      profilesContainer.empty();

      if (this.plugin.settings.webhookProfiles.length === 0) {
        profilesContainer.createEl('p', {
          text: '尚未配置任何 Webhook。',
          cls: 'setting-item-description',
        });
        return;
      }

      this.plugin.settings.webhookProfiles.forEach((profile) => {
        const row = profilesContainer.createDiv({ cls: 'webhook-profile-row' });

        const nameInput = row.createEl('input', {
          type: 'text',
          value: profile.name || '',
          cls: 'webhook-name-input',
          attr: { placeholder: 'Webhook 名称' },
        });
        nameInput.oninput = async () => {
          profile.name = nameInput.value;
          await this.plugin.saveSettings();
          refreshDropdownOptions();
        };

        const urlInput = row.createEl('input', {
          type: 'text',
          value: profile.url || '',
          cls: 'webhook-url-input',
          attr: { placeholder: 'https://your-n8n/webhook/...' },
        });
        urlInput.oninput = async () => {
          profile.url = urlInput.value.trim();
          await this.plugin.saveSettings();
          if (profile.id === this.plugin.settings.activeWebhookId) {
            await this.plugin.setActiveWebhook(profile.id, { silent: true });
            refreshDropdownOptions();
          }
        };

        const actions = row.createDiv({ cls: 'webhook-profile-actions' });

        const isActive = profile.id === this.plugin.settings.activeWebhookId;
        const defaultBtn = actions.createEl('button', {
          text: isActive ? '✅ 默认' : '设为默认',
          cls: 'action-btn secondary webhook-default-btn',
        });
        defaultBtn.onclick = async () => {
          await this.plugin.setActiveWebhook(profile.id);
          refreshDropdownOptions();
          renderProfiles();
        };

        const deleteBtn = actions.createEl('button', {
          text: '删除',
          cls: 'btn-text-only webhook-delete-btn',
        });
        deleteBtn.onclick = async () => {
          if (this.plugin.settings.webhookProfiles.length <= 1) {
            new Notice('至少需要保留一个 Webhook');
            return;
          }

          this.plugin.settings.webhookProfiles = this.plugin.settings.webhookProfiles.filter(
            (p) => p.id !== profile.id,
          );

          if (this.plugin.settings.activeWebhookId === profile.id) {
            const fallback = this.plugin.settings.webhookProfiles[0];
            await this.plugin.setActiveWebhook(fallback.id, { silent: true });
          } else {
            await this.plugin.saveSettings();
          }

          refreshDropdownOptions();
          renderProfiles();
        };
      });
    };

    renderProfiles();

    new Setting(section).addButton((button) =>
      button
        .setButtonText('添加 Webhook')
        .setCta()
        .onClick(async () => {
          const newProfile: WebhookProfile = {
            id: `webhook-${Date.now()}`,
            name: `Webhook ${this.plugin.settings.webhookProfiles.length + 1}`,
            url: '',
          };
          this.plugin.settings.webhookProfiles.push(newProfile);
          await this.plugin.saveSettings();
          refreshDropdownOptions();
          renderProfiles();
        }),
    );
  }

  private createBasicSection(containerEl: HTMLElement) {
    const { section } = this.sectionCard(containerEl, 'sliders-horizontal', '基础配置');

    // 默认语言设置
    new Setting(section)
      .setName('默认语言')
      .setDesc('生成总结的默认语言')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('zh', '中文')
          .addOption('en', '英文')
          .addOption('ja', '日文')
          .setValue(this.plugin.settings.defaultLanguage)
          .onChange(async (value) => {
            this.plugin.settings.defaultLanguage = value as 'zh' | 'en' | 'ja';
            await this.plugin.saveSettings();
          }),
      );

    const aiSection = section.createDiv({ cls: 'vs-subsection' });
    aiSection.createEl('div', { text: '自定义处理模型', cls: 'vs-subsection-title' });
    aiSection.createEl('p', {
      text: '添加你要在 n8n 中使用的模型名称（需与 n8n Switch 节点的值完全一致）。',
      cls: 'setting-item-description',
    });

    const aiModelsContainer = aiSection.createEl('div', { cls: 'webhook-profiles-container' });

    let aiDropdown: DropdownComponent | null = null;

    const refreshAiDropdownOptions = () => {
      if (!aiDropdown) return;
      aiDropdown.selectEl.empty();
      this.plugin.settings.customAiModels.forEach((model) => {
        const option = document.createElement('option');
        option.value = model;
        option.textContent = model;
        aiDropdown!.selectEl.appendChild(option);
      });
      const selectedModel = this.plugin.settings.aiModel;
      if (selectedModel && this.plugin.settings.customAiModels.includes(selectedModel)) {
        aiDropdown.setValue(selectedModel);
      }
    };

    const renderAiModels = () => {
      aiModelsContainer.empty();

      if (this.plugin.settings.customAiModels.length === 0) {
        aiModelsContainer.createEl('p', {
          text: '尚未配置任何自定义处理模型。',
          cls: 'setting-item-description',
        });
        return;
      }

      this.plugin.settings.customAiModels.forEach((model, index) => {
        const row = aiModelsContainer.createDiv({ cls: 'webhook-profile-row' });

        const nameInput = row.createEl('input', {
          type: 'text',
          value: model,
          cls: 'webhook-name-input',
          attr: { placeholder: '模型名称 (如 Gemini 3.1)' },
        });

        nameInput.oninput = async () => {
          this.plugin.settings.customAiModels[index] = nameInput.value;
          await this.plugin.saveSettings();
          refreshAiDropdownOptions();
        };

        const actions = row.createDiv({ cls: 'webhook-profile-actions' });

        const deleteBtn = actions.createEl('button', {
          text: '删除',
          cls: 'btn-text-only webhook-delete-btn',
        });
        deleteBtn.onclick = async () => {
          if (this.plugin.settings.customAiModels.length <= 1) {
            new Notice('至少需要保留一个处理模型');
            return;
          }

          this.plugin.settings.customAiModels.splice(index, 1);

          if (this.plugin.settings.aiModel === model) {
            this.plugin.settings.aiModel = this.plugin.settings.customAiModels[0];
          }
          await this.plugin.saveSettings();

          refreshAiDropdownOptions();
          renderAiModels();
        };
      });
    };

    renderAiModels();

    new Setting(aiSection).addButton((button) =>
      button.setButtonText('添加新模型').onClick(async () => {
        this.plugin.settings.customAiModels.push('新模型');
        await this.plugin.saveSettings();
        refreshAiDropdownOptions();
        renderAiModels();
      }),
    );

    // 默认处理模型设置
    new Setting(section)
      .setName('默认处理模型')
      .setDesc('在 n8n 中使用的默认模型标签')
      .addDropdown((dropdown) => {
        aiDropdown = dropdown;
        dropdown.onChange(async (value) => {
          this.plugin.settings.aiModel = value;
          await this.plugin.saveSettings();
        });
      });

    refreshAiDropdownOptions();

    // 超时时间设置
    new Setting(section)
      .setName('请求超时时间')
      .setDesc('API请求的超时时间（分钟）')
      .addSlider((slider) =>
        slider
          .setLimits(1, 30, 1)
          .setValue(this.plugin.settings.timeoutMinutes)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.timeoutMinutes = value;
            this.plugin.reinitializeApi();
            await this.plugin.saveSettings();
          }),
      );

    // 自动保存设置
    new Setting(section)
      .setName('自动保存')
      .setDesc('处理完成后自动保存文件')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoSave).onChange(async (value) => {
          this.plugin.settings.autoSave = value;
          await this.plugin.saveSettings();
        }),
      );

    // 输出文件夹设置
    new Setting(section)
      .setName('输出文件夹')
      .setDesc('新建视频笔记的默认保存位置（留空则使用当前文件所在文件夹）')
      .addText((text) =>
        text
          .setPlaceholder('例如: Videos/2024')
          .setValue(this.plugin.settings.outputFolder)
          .onChange(async (value) => {
            this.plugin.settings.outputFolder = value;
            await this.plugin.saveSettings();
          }),
      );
  }

  private createQuickProcessingSection(containerEl: HTMLElement) {
    const { section } = this.sectionCard(containerEl, 'zap', '一键处理配置');

    // 一键总结配置
    const summarySubsection = section.createEl('div', { cls: 'vs-subsection' });
    summarySubsection.createEl('div', { text: '一键总结配置', cls: 'vs-subsection-title' });

    new Setting(summarySubsection)
      .setName('总结语言')
      .setDesc('一键总结时使用的语言')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('zh', '中文')
          .addOption('en', '英文')
          .addOption('ja', '日文')
          .setValue(this.plugin.settings.quickSummaryOptions.language)
          .onChange(async (value) => {
            this.plugin.settings.quickSummaryOptions.language = value as 'zh' | 'en' | 'ja';
            await this.plugin.saveSettings();
          }),
      );

    new Setting(summarySubsection)
      .setName('总结超时时间')
      .setDesc('一键总结的超时时间（分钟）')
      .addSlider((slider) =>
        slider
          .setLimits(1, 30, 1)
          .setValue(this.plugin.settings.quickSummaryOptions.timeoutMinutes)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.quickSummaryOptions.timeoutMinutes = value;
            await this.plugin.saveSettings();
          }),
      );

    // 一键提取文稿配置
    const transcriptSubsection = section.createEl('div', { cls: 'vs-subsection' });
    transcriptSubsection.createEl('div', { text: '一键提取文稿配置', cls: 'vs-subsection-title' });

    new Setting(transcriptSubsection)
      .setName('文稿语言')
      .setDesc('一键提取文稿时使用的语言')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('zh', '中文')
          .addOption('en', '英文')
          .addOption('ja', '日文')
          .setValue(this.plugin.settings.quickTranscriptOptions.language)
          .onChange(async (value) => {
            this.plugin.settings.quickTranscriptOptions.language = value as 'zh' | 'en' | 'ja';
            await this.plugin.saveSettings();
          }),
      );

    new Setting(transcriptSubsection)
      .setName('文稿超时时间')
      .setDesc('一键提取文稿的超时时间（分钟）')
      .addSlider((slider) =>
        slider
          .setLimits(1, 30, 1)
          .setValue(this.plugin.settings.quickTranscriptOptions.timeoutMinutes)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.quickTranscriptOptions.timeoutMinutes = value;
            await this.plugin.saveSettings();
          }),
      );
  }

  private createFileProcessingSection(containerEl: HTMLElement) {
    const { section } = this.sectionCard(containerEl, 'files', '文件处理配置');

    // 自动重命名开关
    new Setting(section)
      .setName('处理后自动重命名')
      .setDesc('根据视频标题/正文标题自动重命名笔记，避免重复名将追加编号')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoRenameEnabled).onChange(async (value) => {
          this.plugin.settings.autoRenameEnabled = value;
          await this.plugin.saveSettings();
        }),
      );

    // 重命名冲突策略
    new Setting(section)
      .setName('重命名冲突策略')
      .setDesc('当目标文件名已存在时的处理方式')
      .addDropdown((drop) =>
        drop
          .addOption('append-number', '追加编号')
          .addOption('append-date', '追加日期')
          .addOption('skip', '跳过')
          .setValue(this.plugin.settings.renameConflictStrategy)
          .onChange(async (v) => {
            this.plugin.settings.renameConflictStrategy = v as any;
            await this.plugin.saveSettings();
          }),
      );

    // 批量处理设置
    new Setting(section)
      .setName('批量处理并发数')
      .setDesc('同时处理的最大文件数量')
      .addSlider((slider) =>
        slider
          .setLimits(1, 10, 1)
          .setValue(this.plugin.settings.batchConcurrency)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.batchConcurrency = value;
            await this.plugin.saveSettings();
          }),
      );

    // 成功状态值
    new Setting(section)
      .setName('成功状态值')
      .setDesc('处理成功后写入 frontmatter 的 status 文本，例如 success/已处理/✅ 等')
      .addText((text) =>
        text
          .setPlaceholder('success')
          .setValue(this.plugin.settings.successStatusValue ?? 'success')
          .onChange(async (value) => {
            const normalized = normalizeSuccessStatusValue(value);
            if (normalized !== value.trim()) {
              new Notice('成功状态不能使用待处理、处理中或失败标记，已恢复为 success');
            }
            this.plugin.settings.successStatusValue = normalized;
            await this.plugin.saveSettings();
          }),
      );
  }

  private createPayloadKeysSection(containerEl: HTMLElement) {
    const { section } = this.sectionCard(containerEl, 'radio', 'Webhook Payload 键配置');
    section.createEl('p', {
      text: '自定义发送到 n8n webhook 的 JSON 对象中的键名。这允许您适应不同的 n8n 工作流配置。',
      cls: 'setting-item-description',
    });

    const keys = this.plugin.settings.payloadKeys;

    const createKeySetting = (name: string, desc: string, key: keyof typeof keys) => {
      new Setting(section)
        .setName(name)
        .setDesc(desc)
        .addText((text) =>
          text
            .setPlaceholder(DEFAULT_SETTINGS.payloadKeys[key])
            .setValue(keys[key])
            .onChange(async (value) => {
              keys[key] = value.trim() || DEFAULT_SETTINGS.payloadKeys[key];
              this.plugin.api.setPayloadKeys(keys);
              await this.plugin.saveSettings();
            }),
        );
    };

    createKeySetting('处理模式键', '发送处理模式（summary/transcript-only 等）的键名', 'mode');
    createKeySetting('语言键', '发送语言代码（zh/en/ja）的键名', 'language');
    createKeySetting('模型键', '发送模型标签的键名', 'ai');
    createKeySetting('仅信息标志键', '当模式为 info-only 时发送 true 的键名', 'info_only');
    createKeySetting('视频链接键', '发送视频 URL 的键名', 'link');
    createKeySetting('手动文稿键', '发送手动提供的文稿内容的键名', 'provided_transcript');
    createKeySetting('本地文件键', '发送本地文件路径的键名', 'local_file');
  }

  private createAdvancedSection(containerEl: HTMLElement) {
    const { section } = this.sectionCard(containerEl, 'wrench', '高级配置');

    // 调试模式
    new Setting(section)
      .setName('调试模式')
      .setDesc('输出更多调试日志（控制台）')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enableDebugMode).onChange(async (value) => {
          this.plugin.settings.enableDebugMode = value;
          this.plugin.api.setDebug(!!value);
          await this.plugin.saveSettings();
        }),
      );

    // 处理前后端自检
    new Setting(section)
      .setName('处理前后端自检')
      .setDesc(
        '发起处理前先 ping 当前后端（结果缓存 60 秒）。不可达时会提示，并在另一个后端可用时建议切换。',
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.preflightCheckEnabled !== false)
          .onChange(async (value) => {
            this.plugin.settings.preflightCheckEnabled = value;
            await this.plugin.saveSettings();
          }),
      );

    // 短链自动展开
    new Setting(section)
      .setName('短链自动展开')
      .setDesc(
        '发送前把 b23.tv / v.douyin.com / xhslink.com 等短链展开成最终链接，减少后端下载失败（仅桌面端生效，失败时自动回退原链接）。',
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.expandShortLinks !== false).onChange(async (value) => {
          this.plugin.settings.expandShortLinks = value;
          this.plugin.api.setExpandShortLinks(value);
          await this.plugin.saveSettings();
        }),
      );

    // 历史记录上限
    const historyLimitSetting = new Setting(section)
      .setName('处理历史上限')
      .setDesc(
        `历史与 webhook 结果已拆分存储到插件目录的 history.json（data.json 不再膨胀）。当前上限：${this.plugin.settings.historyLimit ?? 300} 条。`,
      )
      .addSlider((slider) =>
        slider
          .setLimits(100, 1000, 50)
          .setValue(this.plugin.settings.historyLimit ?? 300)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.historyLimit = value;
            await this.plugin.saveSettings();
            historyLimitSetting.setDesc(
              `历史与 webhook 结果已拆分存储到插件目录的 history.json（data.json 不再膨胀）。当前上限：${value} 条。`,
            );
          }),
      );

    // 缓存配置
    const cacheSubsection = section.createEl('div', { cls: 'vs-subsection' });
    cacheSubsection.createEl('div', { text: '缓存配置', cls: 'vs-subsection-title' });

    // 缓存状态概览
    const cacheStatusSetting = new Setting(cacheSubsection)
      .setName('缓存状态')
      .setDesc('点击查看当前缓存状态和统计信息')
      .addButton((button) =>
        button
          .setButtonText('📊 查看状态')
          .setClass('cache-status-btn')
          .onClick(async () => {
            try {
              const stats = await this.plugin.api.getCacheStats();
              await this.showCachePreviewModal(stats);
            } catch (error) {
              console.error('获取缓存统计失败:', error);
              new Notice(`❌ 获取缓存统计失败: ${error.message}`, 5000);
            }
          }),
      );
    cacheStatusSetting.controlEl.addClass('cache-setting-item');

    // 启用缓存
    const enableCacheSetting = new Setting(cacheSubsection)
      .setName('✅ 启用缓存')
      .setDesc('缓存已处理的视频结果，避免重复调用API（节省费用）')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enableCache ?? true).onChange(async (value) => {
          this.plugin.settings.enableCache = value;
          this.plugin.api.setCacheEnabled(value);
          await this.plugin.saveSettings();
          new Notice(value ? '✅ 缓存已启用' : '❌ 缓存已禁用', 2000);
        }),
      );
    enableCacheSetting.controlEl.addClass('cache-setting-item');

    // 缓存过期时间
    const expirySetting = new Setting(cacheSubsection)
      .setName('⏰ 缓存过期时间')
      .setDesc(`缓存结果的有效期（当前：${this.plugin.settings.cacheExpiryDays ?? 30} 天）`)
      .addSlider((slider) =>
        slider
          .setLimits(1, 365, 1)
          .setValue(this.plugin.settings.cacheExpiryDays ?? 30)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.cacheExpiryDays = value;
            this.plugin.api.setCacheConfig(1000, value);
            await this.plugin.saveSettings();
            // 更新描述
            expirySetting.setDesc(`缓存结果的有效期（当前：${value} 天）`);
          }),
      );
    expirySetting.controlEl.addClass('cache-setting-item');
    expirySetting.controlEl.addClass('cache-expiry-slider');

    // 分隔线
    cacheSubsection.createEl('hr', { cls: 'cache-divider' });

    // 缓存管理操作
    cacheSubsection.createEl('div', { text: '缓存管理', cls: 'vs-subsection-title' });

    // 快速操作按钮组
    const quickActionsContainer = cacheSubsection.createEl('div', { cls: 'cache-quick-actions' });

    // 测试缓存
    const testBtn = quickActionsContainer.createEl('button', {
      text: '🧪 添加测试',
      cls: 'cache-quick-btn',
    });
    testBtn.onclick = async () => {
      try {
        await this.addTestCacheData();
      } catch (error) {
        new Notice(`❌ 添加测试数据失败: ${error.message}`, 5000);
      }
    };

    // 清理过期
    const cleanupBtn = quickActionsContainer.createEl('button', {
      text: '🧹 清理过期',
      cls: 'cache-quick-btn',
    });
    cleanupBtn.onclick = async () => {
      try {
        await this.plugin.api.cleanupCache();
        const stats = await this.plugin.api.getCacheStats();
        new Notice(`🧹 已清理过期缓存，当前缓存 ${stats.size} 项`, 3000);
      } catch (error) {
        console.error('清理过期缓存失败:', error);
        new Notice(`❌ 清理过期缓存失败: ${error.message}`, 5000);
      }
    };

    // 清空所有
    const clearBtn = quickActionsContainer.createEl('button', {
      text: '🗑️ 清空所有',
      cls: 'cache-quick-btn cache-danger-btn',
    });
    clearBtn.onclick = async () => {
      // 显示确认对话框
      const confirmed = await new Promise<boolean>((resolve) => {
        const confirmModal = new ConfirmModal(
          this.app,
          '确认清空所有缓存',
          '此操作将删除所有缓存项，无法恢复。确定要继续吗？',
          resolve,
        );
        confirmModal.open();
      });

      if (confirmed) {
        try {
          await this.plugin.api.clearCache();
          new Notice('🗑️ 已清空所有缓存', 3000);
        } catch (error) {
          console.error('清空缓存失败:', error);
          new Notice(`❌ 清空缓存失败: ${error.message}`, 5000);
        }
      }
    };

    // 缓存信息提示
    const cacheInfoContainer = cacheSubsection.createEl('div', { cls: 'cache-info-container' });
    cacheInfoContainer.innerHTML = `
			<div class="cache-info-tip">
				<strong>💡 缓存提示：</strong>
				<ul>
					<li>缓存文件存储在：<code>.obsidian/plugins/video-summary-plugin/data/cache/</code></li>
					<li>缓存会自动清理过期项</li>
					<li>禁用缓存后，所有缓存操作将被忽略</li>
					<li>建议定期清理过期缓存以节省空间</li>
				</ul>
			</div>
		`;
  }

  /**
   * 显示缓存预览模态框
   */
  private async showCachePreviewModal(stats: {
    size: number;
    maxSize: number;
    expiredCount: number;
    totalSize: number;
  }) {
    console.log('🎬 开始创建缓存预览模态框');
    console.log('📊 统计信息:', stats);

    // 创建模态框
    const modal = new Modal(this.app);
    modal.titleEl.setText('📊 缓存预览');
    console.log('📝 模态框标题已设置');

    const { contentEl } = modal;

    // 创建刷新函数，用于更新当前模态框内容
    const refreshModalContent = async () => {
      try {
        console.log('🔄 正在刷新模态框内容...');
        const newStats = await this.plugin.api.getCacheStats();
        contentEl.empty();
        await renderModalContent(contentEl, newStats);
      } catch (error) {
        console.error('❌ 刷新模态框内容失败:', error);
        new Notice(`❌ 刷新失败: ${error.message}`, 5000);
      }
    };

    // 渲染模态框内容的函数
    const renderModalContent = async (container: HTMLElement, currentStats: typeof stats) => {
      // 统计信息
      const statsSection = container.createEl('div', { cls: 'cache-preview-stats' });
      statsSection.innerHTML = `
				<div class="stat-card">
					<div class="stat-title">总缓存项</div>
					<div class="stat-value">${currentStats.size}</div>
				</div>
				<div class="stat-card">
					<div class="stat-title">最大容量</div>
					<div class="stat-value">${currentStats.maxSize}</div>
				</div>
				<div class="stat-card">
					<div class="stat-title">过期项</div>
					<div class="stat-value ${currentStats.expiredCount > 0 ? 'expired' : ''}">${currentStats.expiredCount}</div>
				</div>
				<div class="stat-card">
					<div class="stat-title">总大小</div>
					<div class="stat-value">${this.formatBytes(currentStats.totalSize)}</div>
				</div>
			`;
      console.log('📊 统计信息区域已创建');

      // 缓存内容预览
      if (currentStats.size > 0) {
        console.log('📋 缓存不为空，创建内容预览');
        const previewSection = container.createEl('div', { cls: 'cache-preview-content' });
        previewSection.createEl('h3', { text: '缓存内容预览' });

        // 获取缓存内容
        await this.showCacheContentPreview(previewSection);
      } else {
        console.log('📭 缓存为空，显示空状态');
        const emptySection = container.createEl('div', { cls: 'cache-empty-section' });
        emptySection.innerHTML = `
					<div class="cache-empty-message">
						<p>📭 暂无缓存内容</p>
						<p class="cache-empty-tip">提示：处理视频后会自动添加到缓存，或者点击"添加测试"按钮添加测试数据</p>
					</div>
				`;
      }

      // 操作按钮
      const actionsSection = container.createEl('div', { cls: 'cache-preview-actions' });
      console.log('🔘 操作按钮区域已创建');

      // 刷新按钮
      actionsSection.createEl('button', {
        text: '🔄 刷新',
        cls: 'cache-action-btn',
      }).onclick = refreshModalContent;

      // 关闭按钮
      actionsSection.createEl('button', {
        text: '❌ 关闭',
        cls: 'cache-action-btn',
      }).onclick = () => {
        console.log('❌ 关闭按钮被点击');
        modal.close();
      };
    };

    // 初始渲染
    await renderModalContent(contentEl, stats);

    console.log('🚀 准备打开模态框');
    modal.open();
    console.log('✅ 模态框已打开');
  }

  /**
   * 显示缓存内容预览
   */
  private async showCacheContentPreview(container: HTMLElement) {
    try {
      // 获取所有缓存项
      const items = await this.plugin.api.getAllCacheItems();

      if (items.length === 0) {
        container.createEl('p', {
          text: '暂无缓存内容',
          cls: 'cache-empty-message',
        });
        return;
      }

      // 创建缓存项列表
      const itemsList = container.createEl('div', { cls: 'cache-items-list' });

      // 显示前20项
      const displayItems = items.slice(0, 20);

      for (const item of displayItems) {
        const itemEl = itemsList.createEl('div', { cls: 'cache-item' });

        // 缓存项信息
        const infoEl = itemEl.createEl('div', { cls: 'cache-item-info' });

        // URL
        const urlEl = infoEl.createEl('div', { cls: 'cache-item-url' });
        urlEl.innerHTML = `<strong>URL:</strong> <a href="${item.url}" target="_blank">${this.truncateUrl(item.url)}</a>`;

        // 元数据
        const metaEl = infoEl.createEl('div', { cls: 'cache-item-meta' });
        metaEl.innerHTML = `
					<span class="cache-item-mode">${this.getModeLabel(item.mode)}</span>
					<span class="cache-item-language">${this.getLanguageLabel(item.language)}</span>
					<span class="cache-item-time">${this.formatTime(item.timestamp)}</span>
					<span class="cache-item-status ${item.isExpired ? 'expired' : 'valid'}">${item.isExpired ? '已过期' : '有效'}</span>
				`;

        // 删除按钮
        const deleteBtn = itemEl.createEl('button', {
          text: '🗑️',
          cls: 'cache-item-delete-btn',
        });
        deleteBtn.onclick = async () => {
          try {
            await this.plugin.api.removeCacheItem(item.url, item.mode, item.language);
            itemEl.remove();
            new Notice(`✅ 已删除缓存项: ${item.url}`, 3000);
          } catch (error) {
            new Notice(`❌ 删除失败: ${error.message}`, 5000);
          }
        };
      }

      // 如果还有更多项，显示提示
      if (items.length > 20) {
        container.createEl('p', {
          text: `还有 ${items.length - 20} 项未显示`,
          cls: 'cache-more-items',
        });
      }
    } catch (error) {
      container.createEl('p', {
        text: `获取缓存内容失败: ${error.message}`,
        cls: 'cache-error-message',
      });
    }
  }

  /**
   * 格式化字节数
   */
  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  /**
   * 删除指定的缓存项
   */
  private deleteCacheItem(key: string) {
    try {
      const cacheData = localStorage.getItem('video-summary-cache');
      if (cacheData) {
        const entries = JSON.parse(cacheData);
        const filteredEntries = entries.filter((entry: [string, any]) => entry[0] !== key);
        localStorage.setItem('video-summary-cache', JSON.stringify(filteredEntries));
      }
    } catch (error) {
      console.error('删除缓存项失败:', error);
    }
  }

  /**
   * 添加测试缓存数据
   */
  private async addTestCacheData() {
    try {
      // 使用新的缓存系统添加测试数据
      const testResult = {
        summary: '这是一个测试视频摘要，用于验证缓存功能是否正常工作。',
        video_transcript: '这是一个测试视频文稿，包含了完整的视频内容转录。',
        video_title: '测试视频标题',
        processed_at: new Date().toISOString(),
      };

      await this.plugin.api.setCacheItem(
        'https://example.com/video-test.mp4',
        'summary',
        'zh',
        testResult,
      );

      new Notice('✅ 已添加测试缓存项', 3000);

      // 刷新缓存统计显示
      const stats = await this.plugin.api.getCacheStats();
      console.log('测试数据添加后的缓存统计:', stats);
    } catch (error) {
      console.error('添加测试缓存数据失败:', error);
      new Notice(`❌ 添加测试缓存数据失败: ${error.message}`, 5000);
    }
  }

  /**
   * 截断URL显示
   */
  private truncateUrl(url: string): string {
    if (url.length <= 50) return url;
    return url.substring(0, 47) + '...';
  }

  /**
   * 获取模式标签
   */
  private getModeLabel(mode: string): string {
    const modeLabels: { [key: string]: string } = {
      summary: '完整总结',
      'transcript-only': '仅文稿',
      'info-only': '仅视频信息',
    };
    return modeLabels[mode] || mode;
  }

  /**
   * 获取语言标签
   */
  private getLanguageLabel(language: string): string {
    const languageLabels: { [key: string]: string } = {
      zh: '中文',
      en: '英文',
      ja: '日文',
    };
    return languageLabels[language] || language;
  }

  /**
   * 格式化时间
   */
  private formatTime(timestamp: number): string {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) {
      return '今天';
    } else if (diffDays === 1) {
      return '昨天';
    } else if (diffDays < 7) {
      return `${diffDays}天前`;
    } else {
      return date.toLocaleDateString();
    }
  }

  /**
   * 获取 localStorage 大小
   */
  private getLocalStorageSize(): number {
    let totalSize = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('video-summary-cache')) {
        const value = localStorage.getItem(key);
        if (value) {
          totalSize += value.length;
        }
      }
    }
    return totalSize;
  }
}
