import { relinkVideoJobs } from './utils/NoteOutput';
import {
  App,
  ButtonComponent,
  Editor,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
  DropdownComponent,
  getLanguage,
  type SettingDefinitionItem,
} from 'obsidian';
import { setInterfaceLanguage } from './utils/i18n';
import { DEMO_NOTE_NAME, demoNoteContent } from './core/DemoNote';
import { VideoSummaryModal } from './modals';
import { BatchProcessingModal } from './BatchProcessingModal';
import {
  VideoSummarySettings,
  ProcessingMode,
  WebhookProfile,
  ProcessingBackend,
  ConnectionTestResult,
  PlatformCapability,
  ProcessingDepth,
  RequestedContentType,
  VideoInput,
  VideoKnowledgeArtifact,
  ProcessingResult,
} from './types';
import {
  BACKEND_DEFAULT_MODEL_LABEL,
  platformCapabilities,
  DEFAULT_SETTINGS,
  DEFAULT_N8N_WEBHOOK_URL,
  DEFAULT_WEBHOOK_AUTH_HEADER,
  DEFAULT_HISTORY_LIMIT,
  LEGACY_DEFAULT_N8N_WEBHOOK_URL,
  LEGACY_N8N_WEBHOOK_URL,
  SETUP_GUIDE_URL,
  SETUP_TRIAL_TRANSCRIPT,
  SUPPORTED_PLATFORMS,
} from './constants';
import { pollQrLogin, startQrLogin, type QrLoginTicket } from './core/BilibiliLogin';
import { drawQrCode } from './views/qrCode';
import {
  interpretSetupCheck,
  parseConnectionCode,
  reportedChatModel,
  type ConnectionCode,
  type SetupStep,
} from './core/BackendSetup';
import { VideoSummaryAPI } from './api/VideoSummaryAPI';
import { VideoSummaryView, VIDEO_SUMMARY_VIEW_TYPE } from './views/VideoSummaryView';
import { ConfirmModal } from './modals';
import { VideoUtils } from './utils/VideoUtils';
import { FileProcessor } from './utils/FileProcessor';
import { RetryUtils } from './utils/RetryUtils';
import { NoteProcessor } from './utils/NoteProcessor';
import { safeExternalHttpUrl } from './utils/SafeExternalUrl';
import { JobStore } from './core/JobStore';
import { JobService } from './core/JobService';
import { NoteIndex } from './core/NoteIndex';
import { ArtifactStore } from './core/ArtifactStore';
import { CrossModalMemoryIndex } from './core/CrossModalMemory';
import { KnowledgeLabModal } from './modals/KnowledgeLabModal';
import { LearningProgressStore, learningItemsFromArtifact } from './core/LearningProgressStore';
import { LearningReviewModal, selectReviewItems } from './views/LearningReviewModal';
import {
  CaptureInbox,
  CaptureInboxEntry,
  CaptureInboxRepositoryResult,
  CaptureInboxAction,
  CaptureNoteDraft,
} from './core/CaptureInbox';
import { normalizeVideoSummaryBaseFolder, upsertVideoSummaryBase } from './core/BasesGenerator';
import { restoreReprocessPayload } from './core/ReproducibilityManifest';
import { ReproducibilityStore } from './core/ReproducibilityStore';
import { CourseStore } from './core/CourseStore';
import { DEFAULT_QUOTE_TEMPLATE } from './core/TranscriptQuote';
import { syncCourseIndexAtomic } from './core/CourseIndexWriter';
import { Modal } from 'obsidian';

import { fire } from './utils/fire';
import { errorMessage } from './utils/errors';
import { asArray, asRecord, isRecord, scalarText, type JsonRecord } from './utils/json';
import {
  desktopRequire,
  openPathInSystem,
  type DesktopFs,
  type DesktopPath,
} from './utils/desktop';
import { watchSettingGroups } from './utils/settingGroups';
import {
  LEGACY_PLUGIN_IDS,
  isHistoryEntry,
  isWebhookEntry,
  mergeHistory,
  mergeWebhookHistory,
  salvageSettingsJson,
} from './core/LegacyData';
import { SETTINGS_SEARCH_TERMS } from './views/settingsSearch';
import { tr } from './utils/i18n';
export default class VideoSummaryPlugin extends Plugin {
  settings: VideoSummarySettings;
  api: VideoSummaryAPI;
  fileProcessor: FileProcessor;
  noteProcessor: NoteProcessor;
  /** 任务与索引挂在插件上，侧栏开关不影响它们 */
  jobs: JobStore;
  jobService: JobService;
  noteIndex: NoteIndex;
  artifactStore: ArtifactStore;
  /** Rebuilt from versioned sidecars after restart; never scrapes arbitrary notes. */
  memoryIndex: CrossModalMemoryIndex;
  learningStore: LearningProgressStore;
  reproducibilityStore: ReproducibilityStore;
  courseStore: CourseStore;
  captureInbox: CaptureInbox;
  private readonly captureLocks = new Map<string, Promise<CaptureInboxRepositoryResult>>();
  private readonly capturedEntries = new Map<string, CaptureInboxEntry>();
  private readonly captureProcessingLocks = new Map<string, Promise<void>>();

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
    setInterfaceLanguage(getLanguage());
    // 加载设置
    await this.loadSettings();

    // 初始化API
    this.initializeApiInstance();

    // 初始化文件与笔记处理器
    this.fileProcessor = new FileProcessor(this.app, this);
    this.noteProcessor = new NoteProcessor(this.app.vault);
    const pluginDir =
      this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    this.artifactStore = new ArtifactStore(
      this.app.vault.adapter,
      `${pluginDir}/data/knowledge-artifacts`,
    );
    this.memoryIndex = new CrossModalMemoryIndex();
    this.learningStore = new LearningProgressStore(
      this.app.vault.adapter,
      `${pluginDir}/data/learning-progress`,
    );
    this.reproducibilityStore = new ReproducibilityStore(
      this.app.vault.adapter,
      `${pluginDir}/data/reproducibility`,
    );
    this.courseStore = new CourseStore(
      this.app.vault.adapter,
      `${pluginDir}/data/course-manifests`,
    );
    this.captureInbox = new CaptureInbox({
      putIfAbsent: (sourceHash, draft) => this.putCaptureIfAbsent(sourceHash, draft),
    });

    // 任务队列 + 视频笔记索引
    this.jobs = new JobStore();
    this.jobService = new JobService(this, this.jobs);
    this.noteIndex = new NoteIndex(this.app);
    this.app.workspace.onLayoutReady(() => this.noteIndex.build());
    this.app.workspace.onLayoutReady(() => {
      void this.memoryIndex.rebuildFromStore(this.artifactStore).catch((error) => {
        console.warn('[Video Summary] 跨模态记忆索引重建失败', error);
      });
    });
    this.app.workspace.onLayoutReady(() => {
      void this.ensureVideoLibraryBase(false).catch((error) => {
        console.warn('[Video Summary] 视频库 Base 初始化失败', error);
      });
    });

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
      void this.handleProtocolRequest(params);
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
    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        this.noteIndex.handleDelete(file);
        if (file instanceof TFile && file.extension === 'md') {
          void this.handleVideoNoteDeleted(file.path).catch((error) => {
            console.warn('[Video Summary] 删除后的关联清理失败', error);
          });
        }
      }),
    );
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        this.noteIndex.handleRename(file, oldPath);
        if (file instanceof TFile && file.extension === 'md') {
          relinkVideoJobs(this.jobs, oldPath, file);
          void this.handleVideoNoteRenamed(file, oldPath).catch((error) => {
            console.warn('[Video Summary] 重命名后的关联更新失败', error);
          });
        }
      }),
    );
  }

  onunload() {
    // 卸载前把待写入的历史落盘
    if (this.historySaveTimer !== null) {
      window.clearTimeout(this.historySaveTimer);
      this.historySaveTimer = null;
      void this.writeHistoryFile();
    }
  }

  private addCommands() {
    // 主要命令：快速总结当前笔记
    this.addCommand({
      id: 'quick',
      name: tr('快速总结当前笔记', 'Quick summary of the current note'),
      editorCallback: (editor: Editor, view: MarkdownView) => {
        void this.quickProcessCurrentNote(editor, view, 'summary');
      },
    });

    // 新增命令：将全文作为文稿总结
    this.addCommand({
      id: 'full-text',
      name: tr('将当前笔记全文作为文稿总结', 'Summarise the whole note as a transcript'),
      editorCallback: (editor: Editor, view: MarkdownView) => {
        void this.processFullTextAsTranscript(editor, view);
      },
    });

    // 快速提取文稿
    this.addCommand({
      id: 'transcript-quick',
      name: tr('快速提取文稿', 'Quick transcript'),
      editorCallback: (editor: Editor, view: MarkdownView) => {
        void this.quickProcessCurrentNote(editor, view, 'transcript-only');
      },
    });

    // 只更新视频信息
    this.addCommand({
      id: 'info-update',
      name: tr('更新视频信息（不改正文）', 'Update video info (body unchanged)'),
      editorCallback: (editor: Editor, view: MarkdownView) => {
        void this.updateVideoInfoOnly(editor, view, false);
      },
    });

    // 更新视频信息并重命名
    this.addCommand({
      id: 'info-update-rename',
      name: tr('更新视频信息并重命名', 'Update video info and rename'),
      editorCallback: (editor: Editor, view: MarkdownView) => {
        void this.updateVideoInfoOnly(editor, view, true);
      },
    });

    // 把当前笔记里的视频链接收进侧栏添加框，确认后再批量处理
    this.addCommand({
      id: 'collect-note-links',
      name: tr(
        '收集当前笔记里的视频链接到侧栏',
        'Collect the video links in this note into the side panel',
      ),
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== 'md') return false;
        if (!checking) void this.collectVideoLinksFromNote(file);
        return true;
      },
    });

    // 打开视频总结管理视图
    this.addCommand({
      id: 'view',
      name: tr('打开视频总结侧栏', 'Open the Video Summary side panel'),
      callback: () => {
        void this.activateView();
      },
    });

    // 批量处理命令
    this.addCommand({
      id: 'batch',
      name: tr('批量处理视频', 'Batch process videos'),
      callback: () => {
        new BatchProcessingModal(this.app, this).open();
      },
    });

    // 重新处理当前笔记
    this.addCommand({
      id: 'reprocess',
      name: tr('重新处理当前笔记', 'Process the current note again'),
      editorCallback: (editor: Editor, view: MarkdownView) => {
        void this.reprocessCurrentNote(editor, view);
      },
    });

    // 处理所有待处理视频
    this.addCommand({
      id: 'process-all-pending',
      name: tr('处理所有待处理视频', 'Process all pending videos'),
      callback: () => {
        void this.processAllPendingVideos();
      },
    });

    // 测试当前视频处理后端连接
    this.addCommand({
      id: 'test-connection',
      name: tr('测试当前视频处理后端', 'Test the current video backend'),
      callback: () => {
        void this.testProcessingBackendConnection();
      },
    });

    this.addCommand({
      id: 'open-worker-dashboard',
      name: tr('Codex 本地服务控制台', 'Codex local service dashboard'),
      callback: () => {
        this.openCodexWorkerDashboard();
      },
    });

    this.addCommand({
      id: 'memory-search',
      name: tr('搜索跨模态视频记忆', 'Search video memory across media'),
      callback: () => {
        new KnowledgeLabModal(this.app, this, 'memory').open();
      },
    });

    this.addCommand({
      id: 'claim-lab',
      name: tr('生成多视频论点实验室', 'Build a multi-video claim lab'),
      callback: () => {
        new KnowledgeLabModal(this.app, this, 'claim-lab').open();
      },
    });

    this.addCommand({
      id: 'learning-review',
      name: tr('复习当前视频的学习卡', "Review this video's learning cards"),
      editorCallback: (_editor: Editor, view: MarkdownView) => {
        if (view.file) void this.openLearningReviewForFile(view.file);
      },
    });

    this.addCommand({
      id: 'learning-review-due',
      name: tr('复习所有到期的视频学习卡', 'Review all due video learning cards'),
      callback: () => {
        void this.openGlobalLearningReview();
      },
    });

    this.addCommand({
      id: 'reprocess-from-artifact',
      name: tr('用本地可复现工件重新处理', 'Process again from the local reproducible artifact'),
      editorCallback: (_editor: Editor, view: MarkdownView) => {
        if (view.file) void this.reprocessFromPersistedArtifact(view.file);
      },
    });

    this.addCommand({
      id: 'generate-base',
      name: tr(
        '生成或安全更新视频库数据视图（.base 文件）',
        'Create or safely update the video library view (.base file)',
      ),
      callback: () => {
        void this.ensureVideoLibraryBase(true);
      },
    });

    // 标记为非视频笔记
    this.addCommand({
      id: 'mark-excluded',
      name: tr('标记为非视频笔记', 'Mark as not a video note'),
      editorCallback: (editor: Editor, view: MarkdownView) => {
        void this.markAsExcluded(editor, view);
      },
    });
  }

  private registerContextMenu() {
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (file instanceof TFile && file.extension === 'md') {
          menu.addItem((item) => {
            item
              .setTitle(tr('视频总结 - 快速处理', 'Video Summary - quick process'))
              .setIcon('video')
              .onClick(async () => {
                await this.processFile(file);
              });
          });

          menu.addItem((item) => {
            item
              .setTitle(tr('视频总结 - 仅提取文稿', 'Video Summary - transcript only'))
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
        new Notice(tr('无法获取当前文件', 'Cannot get the current file'));
        return;
      }

      const content = await this.app.vault.read(file);

      // 检查是否有任何输入数据
      const url = this.extractVideoUrl(content);
      const providedTranscript = this.extractProvidedTranscript(content);
      const localFileName = this.extractLocalFileName(content);

      if (!url && !providedTranscript && !localFileName) {
        new Notice(
          tr(
            '当前笔记中没有找到视频链接、文稿内容或本地文件名',
            'No video link, transcript or local file name in this note',
          ),
        );
        return;
      }

      new VideoSummaryModal(this.app, this, editor, view).open();
    } catch (error) {
      new Notice(
        tr(
          `处理当前笔记失败: ${this.formatErrorForNotice(error)}`,
          `Could not process the current note: ${this.formatErrorForNotice(error)}`,
        ),
        8000,
      );
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
        new Notice(tr('无法获取当前文件', 'Cannot get the current file'));
        return;
      }

      const content = await this.app.vault.read(file);

      // 检查是否有任何输入数据
      const url = this.extractVideoUrl(content);
      const providedTranscript = this.extractProvidedTranscript(content);
      const localFileName = this.extractLocalFileName(content);

      if (!url && !providedTranscript && !localFileName) {
        new Notice(
          tr(
            '当前笔记中没有找到视频链接、文稿内容或本地文件名',
            'No video link, transcript or local file name in this note',
          ),
        );
        return;
      }

      // 直接处理，不打开模态框
      await this.processFileWithMode(file, mode);
    } catch (error) {
      new Notice(
        tr(
          `处理当前笔记失败: ${this.formatErrorForNotice(error)}`,
          `Could not process the current note: ${this.formatErrorForNotice(error)}`,
        ),
        8000,
      );
    }
  }

  private async updateVideoInfoOnly(editor: Editor, view: MarkdownView, forceRename: boolean) {
    try {
      const file = view.file;
      if (!file) {
        new Notice(tr('无法获取当前文件', 'Cannot get the current file'));
        return;
      }

      const content = await this.app.vault.read(file);
      const videoInput = this.noteProcessor.buildVideoInput(content);

      if (!videoInput.url && !videoInput.transcript && !videoInput.localFile) {
        new Notice(
          tr(
            '当前笔记中没有找到视频链接、文稿内容或本地文件名',
            'No video link, transcript or local file name in this note',
          ),
        );
        return;
      }

      if (!(await this.ensureBackendReady())) {
        return;
      }

      await this.noteProcessor.setProcessingStatus(file, 'running');
      await this.jobService.updateCourseProgressForFile(file, 'processing', 10);

      const statusNotice = new Notice(tr('正在获取视频信息...', 'Getting video info...'), 0);

      try {
        const result = await this.api.processVideo(
          file.basename,
          videoInput,
          'info-only',
          this.settings.defaultLanguage,
          this.settings.enableCache !== false,
        );
        const artifactContext = {
          title: file.basename,
          notePath: file.path,
          input: videoInput,
          platform: result.video_platform,
        };
        await this.jobService.persistExternalResult(artifactContext, result);

        await this.noteProcessor.updateNote(file, result, 'info-only', {
          autoRename: forceRename,
          conflictStrategy: this.settings.renameConflictStrategy,
        });
        await this.jobService.relinkExternalResult(artifactContext, result, file);

        await this.noteProcessor.setProcessingStatus(
          file,
          this.settings.successStatusValue ?? 'success',
        );
        await this.jobService.updateCourseProgressForFile(
          file,
          'complete',
          100,
          result.artifact?.artifact_id,
        );
        this.addToHistory(file.basename, 'success', 'info-only');

        statusNotice.setMessage(tr('✅ 视频信息已更新', '✅ Video info updated'));
        window.setTimeout(() => statusNotice.hide(), 2000);
      } catch (error) {
        await this.noteProcessor.setProcessingError(file, error);
        await this.jobService.updateCourseProgressForFile(file, 'error', 0);
        this.addToHistory(file.basename, 'error', 'info-only');
        statusNotice.setMessage(
          tr(
            `更新失败: ${this.formatErrorForNotice(error)}`,
            `Update failed: ${this.formatErrorForNotice(error)}`,
          ),
        );
        window.setTimeout(() => statusNotice.hide(), 3000);
      }
    } catch (error) {
      new Notice(
        tr(
          `更新视频信息失败: ${this.formatErrorForNotice(error)}`,
          `Could not update the video info: ${this.formatErrorForNotice(error)}`,
        ),
        8000,
      );
    }
  }

  private async reprocessCurrentNote(editor: Editor, view: MarkdownView) {
    try {
      const file = view.file;
      if (!file) {
        new Notice(tr('无法获取当前文件', 'Cannot get the current file'));
        return;
      }

      // 直接重新处理文件
      await this.processFile(file);
    } catch (error) {
      new Notice(
        tr(
          `重新处理失败: ${this.formatErrorForNotice(error)}`,
          `Could not process again: ${this.formatErrorForNotice(error)}`,
        ),
        8000,
      );
    }
  }

  private async quickProcessCurrentNote(editor: Editor, view: MarkdownView, mode: ProcessingMode) {
    try {
      const file = view.file;
      if (!file) {
        new Notice(tr('无法获取当前文件', 'Cannot get the current file'));
        return;
      }

      const content = await this.app.vault.read(file);

      // 提取所有可能的输入数据
      const url = this.extractVideoUrl(content);
      const providedTranscript = this.extractProvidedTranscript(content);
      const localFileName = this.extractLocalFileName(content);

      // 检查是否有任何输入数据
      if (!url && !providedTranscript && !localFileName) {
        new Notice(
          tr(
            '当前笔记中没有找到视频链接、文稿内容或本地文件名',
            'No video link, transcript or local file name in this note',
          ),
        );
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
      const requestTimeoutMinutes =
        mode === 'summary'
          ? this.settings.quickSummaryOptions.timeoutMinutes
          : mode === 'transcript-only'
            ? this.settings.quickTranscriptOptions.timeoutMinutes
            : this.settings.timeoutMinutes;

      // 显示处理状态
      const statusNotice = new Notice(
        tr(
          `正在处理: ${this.getModeDisplayText(mode)}`,
          `Processing: ${this.getModeDisplayText(mode)}`,
        ),
        0,
      );
      await this.noteProcessor.setProcessingStatus(file, 'running');
      await this.jobService.updateCourseProgressForFile(file, 'processing', 10);

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
        let result: ProcessingResult;
        let artifactInput: VideoInput = {};

        // ===== 多文件合并逻辑 =====
        if (isMerge) {
          const langText =
            requestLanguage === 'zh'
              ? tr('中文', 'Chinese')
              : requestLanguage === 'en'
                ? tr('英文', 'English')
                : tr('日文', 'Japanese');
          statusNotice.setMessage(
            tr(
              `正在合并处理 ${localFiles.length} 个文件...`,
              `Processing ${localFiles.length} files together...`,
            ),
          );

          let combinedTranscript = '';

          // 1. 逐个提取文稿
          for (let i = 0; i < localFiles.length; i++) {
            const localFile = localFiles[i];
            statusNotice.setMessage(
              tr(
                `正在提取第 ${i + 1}/${localFiles.length} 个文件的内容...`,
                `Extracting file ${i + 1}/${localFiles.length}...`,
              ),
            );

            // 使用 processVideoSimple 仅提取文稿
            const extractResult = await this.api.processVideoSimple(
              { localFile: localFile },
              'transcript-only',
              requestLanguage,
              false, // 不使用缓存
              this.settings.quickTranscriptOptions.timeoutMinutes,
            );

            if (extractResult.video_transcript) {
              combinedTranscript += `\n\n=== FILE START: ${localFile} ===\n${extractResult.video_transcript}\n=== FILE END ===\n`;
            }
          }

          if (!combinedTranscript) {
            throw new Error('未能从文件中提取到任何内容');
          }

          // 2. 使用合并后的文稿进行总结
          statusNotice.setMessage(
            tr(
              `正在以${langText}生成合并总结...`,
              `Generating a combined summary in ${langText}...`,
            ),
          );

          // 构建新的输入，使用合并后的文稿
          const mergedInput: VideoInput = {
            transcript: combinedTranscript,
            url: url || undefined,
            localFiles,
            merge: true,
          };
          artifactInput = mergedInput;

          // 调用主处理流程（重试逻辑）
          result = await RetryUtils.withSmartRetry(
            async () => {
              return await this.api.processVideo(
                file.basename,
                mergedInput,
                mode,
                requestLanguage,
                this.settings.enableCache !== false,
                undefined,
                requestTimeoutMinutes,
              );
            },
            1,
            2000,
            (attempt, error) => {
              statusNotice.setMessage(
                tr(`重试中: ${errorMessage(error)}`, `Retrying: ${errorMessage(error)}`),
              );
            },
          );
        } else {
          // ===== 单文件/常规逻辑 =====

          // 构建输入数据
          const input: VideoInput = {};
          if (url) input.url = url;
          if (providedTranscript) input.transcript = providedTranscript;
          if (localFileName) input.localFile = localFileName; // 单文件情况
          artifactInput = input;

          // 使用重试机制调用API处理
          result = await RetryUtils.withSmartRetry(
            async () => {
              return await this.api.processVideo(
                file.basename,
                input,
                mode,
                requestLanguage,
                this.settings.enableCache !== false, // 根据设置决定是否使用缓存
                undefined,
                requestTimeoutMinutes,
              );
            },
            1, // 重试1次
            2000, // 2秒延迟
            (attempt, error) => {
              statusNotice.setMessage(
                tr(
                  `重试中 (${attempt}/2): ${errorMessage(error)}`,
                  `Retrying (${attempt}/2): ${errorMessage(error)}`,
                ),
              );
            },
          );
        }

        // ===== 处理结果 =====
        const artifactContext = {
          title: file.basename,
          notePath: file.path,
          input: artifactInput,
          platform: result.video_platform,
        };
        await this.jobService.persistExternalResult(artifactContext, result);

        // 更新笔记内容（按设置控制自动重命名）
        await this.noteProcessor.updateNote(file, result, mode, {
          autoRename: this.settings.autoRenameEnabled,
          conflictStrategy: this.settings.renameConflictStrategy,
        });
        await this.jobService.relinkExternalResult(artifactContext, result, file);

        // 更新状态（使用可配置的成功状态值）
        await this.noteProcessor.setProcessingStatus(
          file,
          this.settings.successStatusValue ?? 'success',
        );
        await this.jobService.updateCourseProgressForFile(
          file,
          'complete',
          100,
          result.artifact?.artifact_id,
        );

        // 添加到历史记录
        this.addToHistory(file.basename, 'success', mode);

        statusNotice.setMessage(tr(`✅ 处理完成`, `✅ Done`));
        window.setTimeout(() => statusNotice.hide(), 2000);
      } catch (error) {
        // 更新状态为错误
        await this.noteProcessor.setProcessingError(file, error);
        await this.jobService.updateCourseProgressForFile(file, 'error', 0);

        // 添加到历史记录
        this.addToHistory(file.basename, 'error', mode);

        statusNotice.setMessage(
          tr(
            `处理失败: ${this.formatErrorForNotice(error)}`,
            `Processing failed: ${this.formatErrorForNotice(error)}`,
          ),
        );
        window.setTimeout(() => statusNotice.hide(), 3000);
      }
    } catch (error) {
      new Notice(
        tr(
          `处理失败: ${this.formatErrorForNotice(error)}`,
          `Processing failed: ${this.formatErrorForNotice(error)}`,
        ),
        8000,
      );
    }
  }

  private async processFullTextAsTranscript(editor: Editor, view: MarkdownView) {
    try {
      const file = view.file;
      if (!file) {
        new Notice(tr('无法获取当前文件', 'Cannot get the current file'));
        return;
      }

      // 获取全文本
      const fullText = editor.getValue();
      if (!fullText.trim()) {
        new Notice(tr('笔记中没有发现任何文本内容', 'The note has no text'));
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
      await this.jobService.updateCourseProgressForFile(file, 'processing', 10);
      const statusNotice = new Notice(
        tr(`正在将全文发送处理...`, `Sending the whole note for processing...`),
        0,
      );

      try {
        const input: VideoInput = {
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
              undefined,
              this.settings.quickSummaryOptions.timeoutMinutes,
            );
          },
          1, // 重试1次
          2000, // 2秒延迟
          (attempt, error) => {
            statusNotice.setMessage(
              tr(
                `重试中 (${attempt}/2): ${errorMessage(error)}`,
                `Retrying (${attempt}/2): ${errorMessage(error)}`,
              ),
            );
          },
        );
        const artifactContext = {
          title: file.basename,
          notePath: file.path,
          input,
          platform: result.video_platform,
        };
        await this.jobService.persistExternalResult(artifactContext, result);

        // 更新笔记内容，强制开启 autoRename 以便此模式下总是应用由 n8n 生成的好的标题
        await this.noteProcessor.updateNote(file, result, mode, {
          autoRename: true,
          conflictStrategy: this.settings.renameConflictStrategy,
        });
        await this.jobService.relinkExternalResult(artifactContext, result, file);
        await this.noteProcessor.setProcessingStatus(
          file,
          this.settings.successStatusValue ?? 'success',
        );
        await this.jobService.updateCourseProgressForFile(
          file,
          'complete',
          100,
          result.artifact?.artifact_id,
        );
        this.addToHistory(file.basename, 'success', mode);

        statusNotice.setMessage(tr(`✅ 全文处理完成`, `✅ Whole note processed`));
        window.setTimeout(() => statusNotice.hide(), 2000);
      } catch (error) {
        await this.noteProcessor.setProcessingError(file, error);
        await this.jobService.updateCourseProgressForFile(file, 'error', 0);
        this.addToHistory(file.basename, 'error', mode);
        statusNotice.setMessage(
          tr(
            `处理失败: ${this.formatErrorForNotice(error)}`,
            `Processing failed: ${this.formatErrorForNotice(error)}`,
          ),
        );
        window.setTimeout(() => statusNotice.hide(), 5000);
      }
    } catch (error) {
      new Notice(
        tr(
          `处理启动失败: ${this.formatErrorForNotice(error)}`,
          `Could not start: ${this.formatErrorForNotice(error)}`,
        ),
        8000,
      );
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
        new Notice(tr('没有找到待处理的视频笔记', 'No pending video notes found'));
        return;
      }

      // 显示确认对话框
      const confirmed = await this.showConfirmDialog(
        tr(`批量处理 ${pendingFiles.length} 个视频`, `Process ${pendingFiles.length} videos`),
        `${tr('是否要批量处理这些视频？\n\n文件列表：', 'Process these videos?\n\nFiles:')}\n${pendingFiles
          .slice(0, 10)
          .map((f) => `• ${f.basename}`)
          .join('\n')}${
          pendingFiles.length > 10
            ? tr(
                `\n... 还有 ${pendingFiles.length - 10} 个文件`,
                `\n... and ${pendingFiles.length - 10} more`,
              )
            : ''
        }`,
      );

      if (!confirmed) {
        return;
      }

      // 批量开始前先确认后端可用
      if (!(await this.ensureBackendReady())) {
        return;
      }

      // 创建进度通知
      const progressNotice = new Notice(
        tr(
          `正在处理 ${pendingFiles.length} 个视频...`,
          `Processing ${pendingFiles.length} videos...`,
        ),
        0,
      );
      let successCount = 0;
      let errorCount = 0;

      // 批量处理文件
      for (let i = 0; i < pendingFiles.length; i++) {
        const file = pendingFiles[i];
        try {
          // 更新进度
          progressNotice.setMessage(
            tr(
              `处理中 (${i + 1}/${pendingFiles.length})`,
              `Processing (${i + 1}/${pendingFiles.length})`,
            ),
          );

          // 处理文件（历史记录由 JobService 统一写，这里不再重复追加）
          await this.processFileWithMode(file, this.settings.defaultMode);
          successCount++;
        } catch (error) {
          errorCount++;
          console.error(`处理文件失败: ${file.basename}`, error);
        }

        // 添加延迟避免API限制
        if (i < pendingFiles.length - 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 1000));
        }
      }

      // 保存历史记录
      await this.saveSettings();

      // 显示最终结果
      progressNotice.setMessage(
        tr(
          `完成！成功: ${successCount}, 失败: ${errorCount}`,
          `Done! Succeeded: ${successCount}, failed: ${errorCount}`,
        ),
      );
      window.setTimeout(() => progressNotice.hide(), 3000);
    } catch (error) {
      new Notice(
        tr(
          `批量处理失败: ${this.formatErrorForNotice(error)}`,
          `Batch processing failed: ${this.formatErrorForNotice(error)}`,
        ),
        8000,
      );
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
      mode: mode as ProcessingMode,
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
      new Notice(tr('处理历史已清理', 'Processing history cleared'));
    } catch (error) {
      new Notice(
        tr(
          `清理历史失败: ${errorMessage(error)}`,
          `Could not clear the history: ${errorMessage(error)}`,
        ),
      );
    }
  }

  private async testProcessingBackendConnection() {
    try {
      const result = await this.api.testConnection();
      const label =
        this.settings.activeBackend === 'codex-worker'
          ? 'Codex Worker'
          : tr('兼容 n8n 的 webhook', 'n8n-compatible webhook');

      if (result.success) {
        new Notice(
          tr(
            `${label} 连接成功（${result.durationMs ?? 0}ms）`,
            `${label} connected (${result.durationMs ?? 0} ms)`,
          ),
        );
      } else {
        const hint = result.hint
          ? tr(`\n建议: ${result.hint}`, `\nSuggestion: ${result.hint}`)
          : '';
        new Notice(
          tr(
            `${label} 连接失败: ${result.error || '未知错误'}${hint}`,
            `${label} connection failed: ${result.error || 'unknown error'}${hint}`,
          ),
          8000,
        );
      }
    } catch (error) {
      new Notice(
        tr(
          `连接失败: ${this.api.formatUserFacingError(error)}`,
          `Connection failed: ${this.api.formatUserFacingError(error)}`,
        ),
        8000,
      );
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

    const label =
      backend === 'codex-worker'
        ? 'Codex Worker'
        : tr('兼容 n8n 的 webhook', 'n8n-compatible webhook');

    const otherBackend: ProcessingBackend = backend === 'n8n' ? 'codex-worker' : 'n8n';
    const otherLabel =
      otherBackend === 'codex-worker'
        ? 'Codex Worker'
        : tr('兼容 n8n 的 webhook', 'n8n-compatible webhook');
    const otherUrl =
      otherBackend === 'codex-worker'
        ? this.settings.codexWorkerUrl || DEFAULT_SETTINGS.codexWorkerUrl
        : this.settings.n8nWebhookUrl || DEFAULT_SETTINGS.n8nWebhookUrl;

    const fallbackWebhookProfile = this.getActiveWebhookProfile();
    const otherResult = await VideoSummaryAPI.probeEndpoint(
      otherUrl,
      otherBackend,
      4000,
      undefined,
      otherBackend === 'n8n'
        ? {
            headerName: fallbackWebhookProfile?.headerName,
            secret: fallbackWebhookProfile?.secret,
          }
        : undefined,
    );

    if (otherResult.ok) {
      const confirmed = await this.showConfirmDialog(
        tr(`${label} 不可用`, `${label} is unavailable`),
        tr(
          `当前后端 ${label} 连接失败：\n${result.error || '未知错误'}\n\n检测到 ${otherLabel} 可用。是否切换到 ${otherLabel} 并继续？`,
          `The current backend ${label} failed to connect:\n${result.error || 'unknown error'}\n\n${otherLabel} is available. Switch to ${otherLabel} and continue?`,
        ),
      );
      if (confirmed) {
        await this.setActiveBackend(otherBackend);
        this.lastPreflight = null;
        new Notice(tr(`已切换到 ${otherLabel}`, `Switched to ${otherLabel}`));
        return true;
      }
      return false;
    }

    new Notice(
      tr(
        `⚠️ ${label} 不可达：${result.error || '未知错误'}\n（${otherLabel} 也未检测到）请先启动处理服务，或在设置中检查 URL。`,
        `⚠️ ${label} unreachable: ${result.error || 'unknown error'}\n(${otherLabel} not found either) Start the backend, or check the URL in settings.`,
      ),
      8000,
    );
    return false;
  }

  openCodexWorkerDashboard() {
    const dashboardUrl = safeExternalHttpUrl(this.getCodexWorkerDashboardUrl());
    if (dashboardUrl) window.open(dashboardUrl, '_blank', 'noopener,noreferrer');
  }

  private async processFile(file: TFile) {
    await this.fileProcessor.processFile(file);
  }

  private async collectVideoLinksFromNote(file: TFile): Promise<void> {
    const content = await this.app.vault.cachedRead(file);
    const urls = VideoUtils.extractVideoUrls(content);
    if (urls.length === 0) {
      new Notice(
        tr(
          `“${file.basename}”里没有找到支持的视频链接`,
          `No supported video link in "${file.basename}"`,
        ),
      );
      return;
    }
    const view = await this.activateView();
    view?.prefillInput(urls.join('\n'));
    new Notice(
      tr(
        `已把 ${urls.length} 个视频链接放进侧栏，选好模式后点“开始”`,
        `Put ${urls.length} video links into the side panel; pick a mode and press Start`,
      ),
    );
  }

  private async activateView(): Promise<VideoSummaryView | null> {
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

    void workspace.revealLeaf(leaf);
    return leaf.view instanceof VideoSummaryView ? leaf.view : null;
  }

  private get pluginDir(): string {
    return this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
  }

  /**
   * data.json as an object. A file damaged by a sync conflict is kept next to it as
   * data.corrupt-<time>.json and whatever still parses is used; a missing file falls back to an
   * install under the old plugin id.
   */
  private async readStoredData(): Promise<{ stored: JsonRecord; migrated: boolean }> {
    const adapter = this.app.vault.adapter;
    const dataPath = `${this.pluginDir}/data.json`;
    let raw: string | null = null;
    try {
      raw = (await adapter.exists(dataPath)) ? await adapter.read(dataPath) : null;
    } catch {
      raw = null;
    }
    if (raw !== null && raw.trim()) {
      const salvage = salvageSettingsJson(raw);
      if (!salvage.corrupt) return { stored: salvage.settings, migrated: false };
      await adapter.write(`${this.pluginDir}/data.corrupt-${Date.now()}.json`, raw);
      new Notice(
        tr(
          `Video Summary：设置文件损坏（同步冲突），已救回 ${salvage.history.length} 条处理记录和 ${salvage.webhookHistory.length} 条结果，原文件另存为 data.corrupt-*.json。`,
          `Video Summary: the settings file was damaged by a sync conflict. Recovered ${salvage.history.length} job records and ${salvage.webhookHistory.length} results; the original is saved as data.corrupt-*.json.`,
        ),
        15000,
      );
      return {
        stored: {
          ...salvage.settings,
          history: salvage.history,
          webhookHistory: salvage.webhookHistory,
        },
        migrated: true,
      };
    }
    const legacy = await this.importLegacyInstall();
    return { stored: legacy ?? {}, migrated: legacy !== null };
  }

  /** First start under the new id: read the settings, history and data/ of an old install. */
  private async importLegacyInstall(): Promise<JsonRecord | null> {
    const adapter = this.app.vault.adapter;
    const pluginsDir = `${this.app.vault.configDir}/plugins`;
    let folders: string[] = [];
    try {
      folders = (await adapter.list(pluginsDir)).folders;
    } catch {
      return null;
    }
    for (const folder of folders.sort()) {
      if (folder === this.pluginDir) continue;
      let id: unknown;
      try {
        id = asRecord(JSON.parse(await adapter.read(`${folder}/manifest.json`))).id;
      } catch {
        continue;
      }
      if (typeof id !== 'string' || !LEGACY_PLUGIN_IDS.includes(id)) continue;
      if (!(await adapter.exists(`${folder}/data.json`))) continue;

      const salvage = salvageSettingsJson(await adapter.read(`${folder}/data.json`));
      let history = salvage.history;
      let webhookHistory = salvage.webhookHistory;
      if (await adapter.exists(`${folder}/history.json`)) {
        try {
          const file = asRecord(JSON.parse(await adapter.read(`${folder}/history.json`)));
          history = mergeHistory(history, asArray(file.history).filter(isHistoryEntry));
          webhookHistory = mergeWebhookHistory(
            webhookHistory,
            asArray(file.webhookHistory).filter(isWebhookEntry),
          );
        } catch {
          // a broken history.json adds nothing
        }
      }
      await this.copyFolder(`${folder}/data`, `${this.pluginDir}/data`);
      new Notice(
        tr(
          `Video Summary：已从旧版插件目录（${folder}）导入设置、${history.length} 条处理记录和 ${webhookHistory.length} 条结果。确认无误后可停用并删除旧版。`,
          `Video Summary: imported settings, ${history.length} job records and ${webhookHistory.length} results from the old plugin folder (${folder}). Once everything looks right, disable and delete the old version.`,
        ),
        15000,
      );
      return { ...salvage.settings, history, webhookHistory };
    }
    return null;
  }

  /** Copies files that do not exist at the destination yet; never overwrites. */
  private async copyFolder(from: string, to: string): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(from))) return;
    if (!(await adapter.exists(to))) await adapter.mkdir(to);
    const { files, folders } = await adapter.list(from);
    for (const file of files) {
      const target = `${to}/${file.slice(from.length + 1)}`;
      if (!(await adapter.exists(target))) await adapter.copy(file, target);
    }
    for (const folder of folders) {
      await this.copyFolder(folder, `${to}/${folder.slice(from.length + 1)}`);
    }
  }

  async loadSettings() {
    const { stored, migrated } = await this.readStoredData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, stored);

    let shouldSave = migrated;
    try {
      const safeOutputFolder = normalizeVideoSummaryBaseFolder(this.settings.outputFolder);
      if (safeOutputFolder !== this.settings.outputFolder) {
        this.settings.outputFolder = safeOutputFolder;
        shouldSave = true;
      }
    } catch {
      console.warn('[Video Summary] 已忽略不安全的旧输出文件夹设置');
      this.settings.outputFolder = '';
      shouldSave = true;
    }

    // ===== history 拆分存储（2.2.0）=====
    // history / webhookHistory 持久化在插件目录 history.json；
    // data.json 里若还残留旧数据（首次升级），迁移过去并从 data.json 清除。
    const legacyHistory = asArray(stored.history) as VideoSummarySettings['history'];
    const legacyWebhookHistory = asArray(
      stored.webhookHistory,
    ) as VideoSummarySettings['webhookHistory'];
    const historyFile = await this.readHistoryFile();

    if (historyFile) {
      this.settings.history = (
        Array.isArray(historyFile.history) ? historyFile.history : []
      ) as VideoSummarySettings['history'];
      this.settings.webhookHistory = (
        Array.isArray(historyFile.webhookHistory) ? historyFile.webhookHistory : []
      ) as VideoSummarySettings['webhookHistory'];
      // 旧版本插件又往 data.json 写过：两边合并去重，不丢任何一边
      this.settings.history = mergeHistory(
        this.settings.history as unknown as JsonRecord[],
        legacyHistory as unknown as JsonRecord[],
      ) as unknown as VideoSummarySettings['history'];
      this.settings.webhookHistory = mergeWebhookHistory(
        this.settings.webhookHistory as unknown as JsonRecord[],
        legacyWebhookHistory as unknown as JsonRecord[],
      ) as unknown as VideoSummarySettings['webhookHistory'];
    } else {
      this.settings.history = legacyHistory;
      this.settings.webhookHistory = legacyWebhookHistory;
    }
    // 迁移进来的记录比上限多时，上限跟着放大，不在第一次启动就删掉旧记录
    if (migrated && this.settings.history.length > (this.settings.historyLimit ?? 0)) {
      this.settings.historyLimit = this.settings.history.length;
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
    // 3.0 后端只有一个模型，由 .env 决定；旧版的模型标签列表不再起作用
    const settingsRecord = this.settings as unknown as JsonRecord;
    if ('customAiModels' in settingsRecord) {
      delete settingsRecord.customAiModels;
      shouldSave = true;
    }
    if (/^(?:Gemini|AI-Studio)\b/.test(this.settings.aiModel || '')) {
      this.settings.aiModel = BACKEND_DEFAULT_MODEL_LABEL;
      shouldSave = true;
    }
    if (
      this.settings.activeBackend !== 'codex-worker' &&
      this.settings.defaultProcessingDepth === 'deep-visual'
    ) {
      this.settings.defaultProcessingDepth = 'evidence';
      shouldSave = true;
      new Notice(
        tr(
          '旧设置中的“深度视觉”已按 n8n 实际能力迁移为“证据”模式。',
          '"Deep visual" in the old settings was changed to "Evidence", which is what n8n supports.',
        ),
        7000,
      );
    }
    const normalizedConcurrency = Math.max(
      1,
      Math.min(20, Math.floor(Number(this.settings.batchConcurrency) || 1)),
    );
    if (this.settings.batchConcurrency !== normalizedConcurrency) {
      this.settings.batchConcurrency = normalizedConcurrency;
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

    const normalizedSuccessStatus = normalizeSuccessStatusValue(this.settings.successStatusValue);
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
          name: tr('默认 Webhook', 'Default webhook'),
          url: this.settings.n8nWebhookUrl || DEFAULT_SETTINGS.n8nWebhookUrl,
          headerName: DEFAULT_WEBHOOK_AUTH_HEADER,
          secret: '',
        },
      ];
      shouldSave = true;
    }

    this.settings.webhookProfiles.forEach((profile) => {
      if (typeof profile.headerName !== 'string' || !profile.headerName.trim()) {
        profile.headerName = DEFAULT_WEBHOOK_AUTH_HEADER;
        shouldSave = true;
      } else if (profile.headerName !== profile.headerName.trim()) {
        profile.headerName = profile.headerName.trim();
        shouldSave = true;
      }
      if (typeof profile.secret !== 'string') {
        profile.secret = '';
        shouldSave = true;
      }

      const hasDefaultIdentity =
        profile.id === 'default-webhook' ||
        profile.name === 'Cyrus' ||
        profile.name === '默认 Webhook';
      const isLegacyDefault =
        hasDefaultIdentity &&
        (profile.url === LEGACY_N8N_WEBHOOK_URL || profile.url === LEGACY_DEFAULT_N8N_WEBHOOK_URL);
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
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed)) return null;
      return { history: asArray(parsed.history), webhookHistory: asArray(parsed.webhookHistory) };
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
    const activeWebhookProfile = this.getActiveWebhookProfile();
    this.api = new VideoSummaryAPI(
      targetUrl,
      this.app.vault,
      // 用插件自身的安装目录，而不是写死某个 vault 的配置目录名（如 .obsidian_mac），保证可移植
      `${this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`}/data`,
      this.settings.payloadKeys,
      backend,
      backend === 'n8n'
        ? {
            headerName: activeWebhookProfile?.headerName,
            secret: activeWebhookProfile?.secret,
          }
        : undefined,
      this.settings.timeoutMinutes ?? DEFAULT_SETTINGS.timeoutMinutes,
    );
    this.api.setWebhookHistory(this.settings.webhookHistory || []);
    this.api.setAiModel(this.settings.aiModel);
    this.api.onWebhookHistoryChange(
      fire(async (history) => {
        this.settings.webhookHistory = history;
        await this.saveSettings();
      }),
    );
    this.api.setDebug(this.settings.enableDebugMode);
    this.api.setExpandShortLinks(this.settings.expandShortLinks !== false);
    this.api.setAnalysisDefaults({
      processingDepth: this.settings.defaultProcessingDepth,
      contentType: this.settings.defaultContentType,
      autoRoute: this.settings.autoRouteContent,
      attentionAssessment: this.settings.attentionAssessmentEnabled,
      generateLearning: this.settings.generateLearningArtifacts,
    });

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
      new Notice(tr('未找到对应的 webhook 配置', 'Webhook configuration not found'));
      return null;
    }

    this.settings.activeWebhookId = profileId;
    this.settings.activeBackend = 'n8n';
    this.settings.n8nWebhookUrl = profile.url;
    if (this.settings.defaultProcessingDepth === 'deep-visual') {
      this.settings.defaultProcessingDepth = 'evidence';
      if (!options.silent) {
        new Notice(
          tr(
            '当前 n8n 后端暂不执行深度视觉，理解深度已改为“证据”。',
            'The n8n backend cannot do deep visual analysis; depth is set to "Evidence".',
          ),
          7000,
        );
      }
    }
    this.initializeApiInstance(profile.url);
    await this.saveSettings();

    if (!options.silent) {
      new Notice(
        tr(`已切换到 ${profile.name || profile.url}`, `Switched to ${profile.name || profile.url}`),
      );
    }

    return profile;
  }

  /** True once a connection code (or a Worker URL) is in place; the side panel uses it for its first-run state. */
  isBackendConfigured(): boolean {
    if (this.settings.activeBackend === 'codex-worker')
      return !!this.settings.codexWorkerUrl?.trim();
    const profile = this.getActiveWebhookProfile();
    return !!profile?.url?.trim() && !!profile.secret?.trim();
  }

  /** Open (or create) the demo note: a real processed result, made without any backend. */
  async openDemoNote() {
    const path = DEMO_NOTE_NAME();
    let file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) file = await this.app.vault.create(path, demoNoteContent());
    if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
  }

  openSettingsPage() {
    const settingApi = (
      this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }
    ).setting;
    settingApi?.open();
    settingApi?.openTabById(this.manifest.id);
  }

  getActiveWebhookProfile(): WebhookProfile | undefined {
    return this.settings.webhookProfiles.find((p) => p.id === this.settings.activeWebhookId);
  }

  async setActiveBackend(backend: ProcessingBackend) {
    this.settings.activeBackend = backend;
    if (backend !== 'codex-worker' && this.settings.defaultProcessingDepth === 'deep-visual') {
      this.settings.defaultProcessingDepth = 'evidence';
      new Notice(
        tr(
          '当前 n8n 后端暂不执行深度视觉，理解深度已改为“证据”。',
          'The n8n backend cannot do deep visual analysis; depth is set to "Evidence".',
        ),
        7000,
      );
    }
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
      processingDepth: this.settings.defaultProcessingDepth,
      contentType: this.settings.defaultContentType,
      autoRoute: this.settings.autoRouteContent,
      attentionAssessment: this.settings.attentionAssessmentEnabled,
      generateLearning: this.settings.generateLearningArtifacts,
    });
    if (!job) return;

    const finished = await this.jobs.waitFor(job.id);
    if (!finished) return;

    if (finished.state === 'error') {
      new Notice(
        tr(
          `处理失败: ${finished.error || '未知错误'}`,
          `Processing failed: ${finished.error || 'unknown error'}`,
        ),
        8000,
      );
      throw new Error(finished.error || '处理失败');
    }
    if (finished.state === 'cancelled') {
      new Notice(tr('处理已取消', 'Processing cancelled'));
      return;
    }
    if (finished.state === 'review') {
      new Notice(
        tr(
          `${this.getModeDisplayText(mode)}已就绪，去侧栏确认写入`,
          `${this.getModeDisplayText(mode)} ready; confirm writing it in the side panel`,
        ),
        6000,
      );
      return;
    }
    new Notice(tr(`${this.getModeDisplayText(mode)}完成`, `${this.getModeDisplayText(mode)} done`));
  }

  /**
   * 刷新视频总结视图
   */
  private getModeDisplayText(mode: ProcessingMode): string {
    switch (mode) {
      case 'summary':
        return tr('视频总结', 'Video summary');
      case 'transcript-only':
        return tr('文稿提取', 'Transcript');
      default:
        return tr('视频信息', 'Video info');
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
          return;
        }

        // 重命名文件（保持路径）
        await this.app.fileManager.renameFile(file, newPath);
      } else {
        // 文件在根目录
        const existingFile = this.app.vault.getAbstractFileByPath(newFileName);
        if (existingFile && existingFile !== file) {
          return;
        }

        // 重命名文件
        await this.app.fileManager.renameFile(file, newFileName);
      }
    } catch (error) {
      console.error(`重命名文件失败: ${errorMessage(error)}`);
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
        new Notice(tr('无法获取当前文件', 'Cannot get the current file'));
        return;
      }

      // 设置状态为排除
      await this.noteProcessor.setProcessingStatus(file, 'excluded');
      new Notice(tr('已标记为非视频笔记', 'Marked as not a video note'));
    } catch (error) {
      new Notice(
        tr(
          `标记为非视频笔记失败: ${errorMessage(error)}`,
          `Could not mark it: ${errorMessage(error)}`,
        ),
      );
    }
  }

  async openLearningReviewForFile(file: TFile): Promise<void> {
    try {
      const artifactId = await this.artifactIdForFile(file);
      if (!artifactId) {
        new Notice(
          tr(
            '当前笔记还没有持久化视频工件，请先处理一次。',
            'This note has no saved video artifact yet; process it once first.',
          ),
          6000,
        );
        return;
      }
      const artifact = await this.artifactStore.load(artifactId);
      const learningCount =
        (artifact.learning?.flashcards?.length || 0) + (artifact.learning?.questions?.length || 0);
      if (learningCount === 0) {
        new Notice(
          tr(
            '这份工件没有学习卡；重新处理时开启“生成学习练习”。',
            'This artifact has no learning cards; turn on "Generate learning exercises" and process it again.',
          ),
          6000,
        );
        return;
      }
      new LearningReviewModal(this.app, {
        store: this.learningStore,
        artifact,
        onOpenEvidence: async (_source, target) => {
          if (target.start === null) {
            new Notice(tr('这条证据没有可靠时间点', 'This evidence has no reliable timestamp'));
            return;
          }
          const view = await this.activateView();
          const notePath = artifact.source.note_path || file.path;
          view?.openArtifact(notePath, artifact.artifact_id, target.start);
        },
      }).open();
    } catch (error) {
      new Notice(
        tr(
          `打开学习复习失败：${this.formatErrorForNotice(error)}`,
          `Could not open the review: ${this.formatErrorForNotice(error)}`,
        ),
        8000,
      );
    }
  }

  private async openGlobalLearningReview(): Promise<void> {
    try {
      const now = new Date();
      const candidates: Array<{
        artifact: VideoKnowledgeArtifact;
        dueCount: number;
        firstDue: string;
      }> = [];
      for (const artifact of await this.artifactStore.list()) {
        const items = learningItemsFromArtifact(artifact);
        if (items.length === 0) continue;
        const progress = await this.learningStore.getArtifactProgress(artifact.artifact_id);
        const due = selectReviewItems(items, progress, 'due', now);
        if (due.length === 0) continue;
        const dueTimes = due
          .map((item) => progress?.items[`${item.item_kind}:${item.item_id}`]?.due_at)
          .filter((value): value is string => Boolean(value));
        candidates.push({
          artifact,
          dueCount: due.length,
          firstDue: dueTimes.sort()[0] || '',
        });
      }
      candidates.sort(
        (left, right) =>
          left.firstDue.localeCompare(right.firstDue) ||
          right.dueCount - left.dueCount ||
          String(left.artifact.title || '').localeCompare(String(right.artifact.title || '')),
      );
      if (candidates.length === 0) {
        new Notice(tr('当前没有到期的视频学习卡。', 'No video learning cards are due.'));
        return;
      }

      const total = candidates.reduce((sum, item) => sum + item.dueCount, 0);
      new Notice(
        tr(
          `共有 ${candidates.length} 个视频、${total} 张学习卡到期。`,
          `${candidates.length} videos, ${total} cards due.`,
        ),
        5000,
      );
      const openAt = (index: number) => {
        const candidate = candidates[index];
        if (!candidate) {
          new Notice(tr('本轮到期复习已完成。', 'All due reviews done.'));
          return;
        }
        new LearningReviewModal(this.app, {
          store: this.learningStore,
          artifact: candidate.artifact,
          mode: 'due',
          onOpenEvidence: async (artifact, target) => {
            if (target.start === null) {
              new Notice(tr('这条证据没有可靠时间点', 'This evidence has no reliable timestamp'));
              return;
            }
            const notePath = artifact.source.note_path;
            const noteFile = notePath ? this.app.vault.getAbstractFileByPath(notePath) : null;
            if (notePath && noteFile instanceof TFile) {
              const view = await this.activateView();
              view?.openArtifact(notePath, artifact.artifact_id, target.start);
              return;
            }
            const externalUrl = safeExternalHttpUrl(target.timestamp_url);
            if (externalUrl) {
              window.open(externalUrl, '_blank', 'noopener,noreferrer');
              return;
            }
            new Notice(
              tr(
                '工件原笔记已不存在，无法定位播放器。',
                "The artifact's original note is gone; cannot find the player.",
              ),
            );
          },
          ...(index + 1 < candidates.length
            ? {
                continueLabel: tr(
                  `继续下一个视频（还剩 ${candidates.length - index - 1} 个）`,
                  `Continue with the next video (${candidates.length - index - 1} left)`,
                ),
                onContinue: () => openAt(index + 1),
              }
            : {}),
        }).open();
      };
      openAt(0);
    } catch (error) {
      new Notice(
        tr(
          `打开到期复习失败：${this.formatErrorForNotice(error)}`,
          `Could not open the due review: ${this.formatErrorForNotice(error)}`,
        ),
        8000,
      );
    }
  }

  private async reprocessFromPersistedArtifact(file: TFile): Promise<void> {
    try {
      const artifactId = await this.artifactIdForFile(file);
      if (!artifactId) {
        new Notice(tr('当前笔记没有可复现工件。', 'This note has no reproducible artifact.'), 6000);
        return;
      }
      const manifest = await this.reproducibilityStore.load(artifactId);
      const restored = await restoreReprocessPayload(manifest);
      const depth =
        restored.processing.depth === 'deep-visual' &&
        this.settings.activeBackend !== 'codex-worker'
          ? 'evidence'
          : restored.processing.depth;
      const job = await this.jobService.submitPreparedFile(
        file,
        {
          sourceUrl: restored.source.url,
          localFile: restored.source.local_file,
          transcript: restored.transcript,
          artifactId: restored.artifact_id,
          processingDepth: depth,
          skipSourceFetch: true,
          persistedSegments: restored.video_segments,
          persistedEvidenceClaims: restored.evidence_claims,
          persistedVisualEvidence: restored.visual_evidence,
          persistedRun: {
            backend: restored.processing.backend,
            model: restored.processing.model,
            prompt: restored.processing.prompt,
            version: restored.processing.version,
          },
        },
        {
          mode: 'summary',
          language: this.settings.defaultLanguage,
          useCache: false,
          previewBeforeWrite: this.settings.previewBeforeWrite === true,
          processingDepth: depth,
          contentType: this.settings.defaultContentType,
          autoRoute: this.settings.autoRouteContent,
          attentionAssessment: this.settings.attentionAssessmentEnabled,
          generateLearning: this.settings.generateLearningArtifacts,
        },
      );
      if (!job) return;
      new Notice(
        tr(
          '已提交无源重处理：本地文稿会重新总结，校验过的旧证据作为缺失回退；不会下载来源，结果使用当前后端配置。',
          'Sent for source-free reprocessing: the local transcript is summarised again and checked old evidence is kept as a fallback; nothing is downloaded and the current backend settings are used.',
        ),
        9000,
      );
      const finished = await this.jobs.waitFor(job.id);
      if (finished?.state === 'error') {
        throw new Error(finished.error || '可复现重处理失败');
      }
    } catch (error) {
      new Notice(
        tr(
          `可复现重处理失败：${this.formatErrorForNotice(error)}`,
          `Reproducible reprocessing failed: ${this.formatErrorForNotice(error)}`,
        ),
        8000,
      );
    }
  }

  private async artifactIdForFile(file: TFile): Promise<string | undefined> {
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const direct = String(frontmatter?.video_artifact_id || '').trim();
    if (direct) return direct;
    const artifact = (await this.artifactStore.list()).find(
      (item) => item.source.note_path === file.path,
    );
    return artifact?.artifact_id;
  }

  private async ensureVideoLibraryBase(notify: boolean): Promise<void> {
    const folder = normalizeVideoSummaryBaseFolder(this.settings.outputFolder);
    await this.ensureVaultFolder(folder);
    const path = folder ? `${folder}/Video Summary Library.base` : 'Video Summary Library.base';
    const existing = this.app.vault.getAbstractFileByPath(path);
    const existingContent =
      existing instanceof TFile ? await this.app.vault.read(existing) : undefined;
    // The managed Base is stored beside generated notes, but its library query
    // must also include offline captures in the separate `Video Inbox` folder.
    // Metadata (`video_summary` + `source_type`) is the safe global boundary.
    const result = upsertVideoSummaryBase(existingContent);
    if (result.status === 'created') {
      await this.app.vault.create(path, result.content);
    } else if (result.status === 'updated' && existing instanceof TFile) {
      await this.app.vault.modify(existing, result.content);
    }
    if (notify) {
      const message =
        result.status === 'preserved'
          ? tr(
              `已保留用户修改的 Base：${path}。如需新版，请先另存或手动删除该文件。`,
              `Kept your edited Base: ${path}. Save it under another name or delete it to get the new version.`,
            )
          : `${result.reason} ${path}`;
      new Notice(message, 7000);
    }
  }

  private async putCaptureIfAbsent(
    sourceHash: string,
    draft: CaptureNoteDraft,
  ): Promise<CaptureInboxRepositoryResult> {
    const active = this.captureLocks.get(sourceHash);
    if (active) return active;
    const operation = (async () => {
      const remembered = this.capturedEntries.get(sourceHash);
      if (remembered) {
        const rememberedFile = this.app.vault.getAbstractFileByPath(remembered.path);
        if (rememberedFile instanceof TFile) {
          return { created: false, entry: { ...remembered } };
        }
        this.capturedEntries.delete(sourceHash);
      }

      const existing = await this.findCapturedEntry(sourceHash, draft.source.identity);
      if (existing) {
        this.capturedEntries.set(sourceHash, existing);
        return { created: false, entry: existing };
      }

      const folder = draft.path.split('/').slice(0, -1).join('/');
      await this.ensureVaultFolder(folder);
      let path = draft.path;
      let suffix = 2;
      while (this.app.vault.getAbstractFileByPath(path)) {
        path = draft.path.replace(/\.md$/i, ` (${suffix}).md`);
        suffix += 1;
      }
      const file = await this.app.vault.create(path, draft.content);
      const entry: CaptureInboxEntry = {
        path: file.path,
        source_hash: sourceHash,
        source_identity: draft.source.identity,
        status: String(draft.properties.video_summary_status || ''),
      };
      this.capturedEntries.set(sourceHash, entry);
      return { created: true, entry };
    })();
    this.captureLocks.set(sourceHash, operation);
    try {
      return await operation;
    } finally {
      if (this.captureLocks.get(sourceHash) === operation) this.captureLocks.delete(sourceHash);
    }
  }

  private async findCapturedEntry(
    sourceHash: string,
    sourceIdentity: string,
  ): Promise<CaptureInboxEntry | undefined> {
    for (const file of this.app.vault.getMarkdownFiles()) {
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
      let storedHash = String(frontmatter?.video_source_hash || '').trim();
      let storedIdentity = String(frontmatter?.video_source_identity || '').trim();
      let storedStatus = String(frontmatter?.video_summary_status || '').trim();
      if (!storedHash) {
        // MetadataCache can be empty during a cold Obsidian startup. Fall back
        // to the persisted note so a second capture cannot create `(2).md`.
        const content = await this.app.vault.cachedRead(file);
        storedHash = frontmatterScalarValue(content, 'video_source_hash');
        storedIdentity ||= frontmatterScalarValue(content, 'video_source_identity');
        storedStatus ||= frontmatterScalarValue(content, 'video_summary_status');
      }
      if (storedHash !== sourceHash) continue;
      return {
        path: file.path,
        source_hash: sourceHash,
        source_identity: storedIdentity || sourceIdentity,
        status: storedStatus,
      };
    }
    const artifact = (await this.artifactStore.list()).find(
      (item) => item.source.source_hash === sourceHash && item.source.note_path,
    );
    const artifactFile = artifact?.source.note_path
      ? this.app.vault.getAbstractFileByPath(artifact.source.note_path)
      : null;
    return artifact?.source.note_path && artifactFile instanceof TFile
      ? {
          path: artifact.source.note_path,
          source_hash: sourceHash,
          source_identity: sourceIdentity,
          status: 'success',
        }
      : undefined;
  }

  private async handleVideoNoteRenamed(file: TFile, oldPath: string): Promise<void> {
    if (oldPath === file.path) return;
    await this.relinkPersistedNotePath(oldPath, file.path);
  }

  private async handleVideoNoteDeleted(path: string): Promise<void> {
    await this.relinkPersistedNotePath(path);
  }

  /**
   * Keep durable sidecars, reviewed relations, course navigation, and the live
   * memory index aligned with ordinary Obsidian rename/delete events.
   */
  private async relinkPersistedNotePath(oldPath: string, newPath?: string): Promise<void> {
    const artifacts = await this.artifactStore.list();
    for (const artifact of artifacts) {
      let current = artifact;
      const movedSource = artifact.source.note_path === oldPath;
      if (movedSource) {
        current = await this.artifactStore.save({
          ...artifact,
          source: {
            ...artifact.source,
            note_path: newPath,
          },
        });
        try {
          const manifest = await this.reproducibilityStore.load(current.artifact_id);
          await this.reproducibilityStore.save({
            ...manifest,
            source: { ...manifest.source, note_path: newPath },
          });
        } catch (error) {
          if ((error as Error)?.name !== 'ReproducibilityManifestNotFoundError') {
            console.warn('[Video Summary] 可复现清单路径更新失败', error);
          }
        }
      }

      const hasRelatedPath = current.related_notes.some((item) => item.note_path === oldPath);
      if (hasRelatedPath) {
        current = await this.artifactStore.updateRelatedNotes(current.artifact_id, (relations) =>
          newPath
            ? relations.map((relation) =>
                relation.note_path === oldPath ? { ...relation, note_path: newPath } : relation,
              )
            : relations.filter((relation) => relation.note_path !== oldPath),
        );
      }
      if (movedSource || hasRelatedPath) this.memoryIndex.upsert(current);
    }

    for (const course of await this.courseStore.list()) {
      const touchesLesson = course.items.some((item) => item.progress.note_path === oldPath);
      const touchesIndex = course.index_note_path === oldPath;
      if (!touchesLesson && !touchesIndex) continue;
      const saved = await this.courseStore.update(course.course_id, (draft) => {
        if (draft.index_note_path === oldPath) {
          draft.index_note_path = newPath;
        }
        draft.items.forEach((item) => {
          if (item.progress.note_path !== oldPath) return;
          if (newPath) item.progress.note_path = newPath;
          else delete item.progress.note_path;
          item.progress.updated_at = new Date().toISOString();
        });
      });
      if (saved?.index_note_path) {
        await syncCourseIndexAtomic(this.app.vault, this.courseStore, saved.course_id, false);
      }
    }

    for (const [sourceHash, entry] of this.capturedEntries) {
      if (entry.path !== oldPath) continue;
      if (newPath) this.capturedEntries.set(sourceHash, { ...entry, path: newPath });
      else this.capturedEntries.delete(sourceHash);
    }
  }

  private async ensureVaultFolder(folder: string): Promise<void> {
    const parts = folder.split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        await this.app.vault.createFolder(current);
      }
    }
  }

  /**
   * Global capture entry. Default is offline `capture-only`; processing must be
   * requested explicitly with action=capture-and-process (or action=process).
   */
  private async handleProtocolRequest(params: Record<string, string>) {
    try {
      const rawUrl = (params.url || params.link || '').trim();
      const localFile = (params.local_file || params.localFile || '').trim();
      if (!rawUrl && !localFile) {
        new Notice(
          tr(
            '协议调用 video-summary 缺少 URL 或 local_file 参数',
            'The video-summary link is missing a URL or local_file',
          ),
          6000,
        );
        return;
      }
      const requestedAction = String(params.action || '')
        .trim()
        .toLowerCase();
      const action: CaptureInboxAction = [
        'capture-and-process',
        'process',
        'process-now',
        '1',
        'true',
      ].includes(requestedAction)
        ? 'capture-and-process'
        : 'capture-only';
      const result = await this.captureInbox.capture({
        url: rawUrl || undefined,
        local_file: localFile || undefined,
        title: (params.title || '').trim() || undefined,
        action,
        output_folder: (params.folder || '').trim() || undefined,
        captured_at: (params.captured_at || '').trim() || undefined,
      });
      const file = this.app.vault.getAbstractFileByPath(result.entry.path);
      if (!(file instanceof TFile)) {
        throw new Error(`捕获仓储返回的笔记不存在：${result.entry.path}`);
      }
      await this.app.workspace.getLeaf(true).openFile(file);
      if (!result.should_process) {
        new Notice(
          result.status === 'created'
            ? tr('已离线加入视频收件箱', 'Added to the video inbox offline')
            : tr('该来源已存在，已打开原笔记', 'Already captured; opened the existing note'),
        );
        return;
      }
      if (rawUrl && !isSupportedProtocolVideoUrl(rawUrl)) {
        new Notice(
          tr(
            '已捕获到收件箱；当前自动处理只支持 YouTube、哔哩哔哩、抖音、抖音国际版和小红书链接，通用 URL 未发送到后端。',
            'Captured to the inbox. Automatic processing supports YouTube, Bilibili, Douyin, TikTok and Xiaohongshu links only, so this URL was not sent.',
          ),
          8000,
        );
        return;
      }
      if (localFile) {
        if (!isSupportedLocalMediaPath(localFile)) {
          new Notice(
            tr(
              '已捕获到收件箱；该本地路径不是受支持的音视频文件，未读取或发送。',
              'Captured to the inbox. This local path is not a supported media file and was not read or sent.',
            ),
            8000,
          );
          return;
        }
        if ((this.settings.activeBackend ?? DEFAULT_SETTINGS.activeBackend) !== 'codex-worker') {
          new Notice(
            tr(
              '已捕获到收件箱；自带的 n8n 无法读取链接里的主机绝对路径。请先复制到后端文件夹的 uploads 里，再用文件名提交，或切换到能访问该路径的本机服务。',
              "Captured to the inbox. The bundled n8n cannot read absolute paths on your computer: copy the file into the backend's uploads folder and submit its name, or use a local service that can reach that path.",
            ),
            9000,
          );
          return;
        }
        const confirmed = await this.showConfirmDialog(
          tr('允许处理本地媒体？', 'Allow processing a local file?'),
          tr(
            `外部协议请求读取并发送这个本地文件到当前后端：\n${localFile}\n\n仅在你认识该来源时确认。`,
            `An external link asks to read this local file and send it to the current backend:\n${localFile}\n\nConfirm only if you recognise where it came from.`,
          ),
        );
        if (!confirmed) {
          new Notice(
            tr(
              '已保留在视频收件箱；本地文件未读取或发送。',
              'Kept in the video inbox; the local file was not read or sent.',
            ),
            6000,
          );
          return;
        }
      }
      new Notice(
        result.status === 'created'
          ? tr('已捕获，开始处理', 'Captured; processing')
          : tr('该来源已存在，开始重新处理', 'Already captured; processing again'),
      );
      const requestedMode = (params.mode || '').trim() as ProcessingMode;
      const mode: ProcessingMode = ['summary', 'transcript-only', 'info-only'].includes(
        requestedMode,
      )
        ? requestedMode
        : this.settings.defaultMode;
      const activeProcessing = this.captureProcessingLocks.get(result.entry.source_hash);
      if (activeProcessing) {
        new Notice(
          tr('该来源已经在处理，本次没有重复提交。', 'Already processing; not sent twice.'),
          5000,
        );
        return;
      }
      const processing = this.processFileWithMode(file, mode).then(() => undefined);
      this.captureProcessingLocks.set(result.entry.source_hash, processing);
      try {
        await processing;
      } finally {
        if (this.captureProcessingLocks.get(result.entry.source_hash) === processing) {
          this.captureProcessingLocks.delete(result.entry.source_hash);
        }
      }
    } catch (error) {
      new Notice(
        tr(
          `video-summary 协议处理失败: ${this.formatErrorForNotice(error)}`,
          `video-summary link failed: ${this.formatErrorForNotice(error)}`,
        ),
        8000,
      );
    }
  }
}

function normalizeSuccessStatusValue(value: unknown): string {
  const normalized = scalarText(value).trim();
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

  constructor(app: App, plugin: VideoSummaryPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /** Where the page was last drawn: containerEl before Obsidian 1.13, the definition row from 1.13. */
  private host: HTMLElement | null = null;

  /**
   * Obsidian 1.13+ draws the tab from these definitions and indexes them for settings search.
   * The page keeps its own layout: one row that draws the whole page, with every setting name as
   * a search alias.
   */
  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        name: tr('视频总结设置', 'Video Summary settings'),
        desc: tr(
          '连接、输出、处理和高级选项',
          'Connection, output, processing and advanced options',
        ),
        aliases: SETTINGS_SEARCH_TERMS,
        render: (setting) => {
          const host = setting.settingEl;
          host.className = 'vs-settings-host';
          this.renderPage(host);
        },
      },
    ];
  }

  display(): void {
    this.renderPage(this.containerEl);
  }

  /** A row of buttons outside any group, ending on the same right line as the controls. */
  private buttonRow(parent: HTMLElement, build: (button: ButtonComponent) => unknown) {
    build(new ButtonComponent(parent.createDiv({ cls: 'ap-button-row' })));
  }

  private redraw() {
    if (this.host) this.renderPage(this.host);
  }

  /** Stops keeping the group corners current once the page is closed. */
  private stopGroupMarks: (() => void) | null = null;

  hide(): void {
    this.stopGroupMarks?.();
    this.stopGroupMarks = null;
  }

  private renderPage(containerEl: HTMLElement): void {
    this.host = containerEl;
    containerEl.empty();
    containerEl.addClass('vs-settings', 'ap', 'ap-settings');

    this.renderSettingsHeader(containerEl);

    // 一页三段：先连上后端，再定写到哪，最后是怎么处理；不常动的收进“高级”
    this.group(containerEl, tr('连接', 'Connection'));
    this.createSetupGuideSection(containerEl);
    this.createApiSection(containerEl);

    this.group(containerEl, tr('输出', 'Output'));
    this.createOutputSection(containerEl);
    this.createFileProcessingSection(containerEl);

    this.group(containerEl, tr('处理', 'Processing'));
    this.createBasicSection(containerEl);
    this.createQuickProcessingSection(containerEl);

    const advanced = containerEl.createEl('details', { cls: 'vs-settings-advanced' });
    advanced.createEl('summary', {
      text: tr(
        '高级：cookies、平台说明、请求字段名、缓存、调试日志',
        'Advanced: cookies, platforms, request field names, cache, debug log',
      ),
    });
    this.createCookiesSection(advanced);
    this.createPlatformMatrixSection(advanced);
    this.createPayloadKeysSection(advanced);
    this.createAdvancedSection(advanced);

    this.stopGroupMarks?.();
    this.stopGroupMarks = watchSettingGroups(containerEl);
  }

  /** 一段的标题 */
  private group(containerEl: HTMLElement, title: string) {
    const head = new Setting(containerEl).setName(title).setHeading();
    head.settingEl.addClass('vs-settings-group');
  }

  /** 页头：标题 + 版本副行 + 后端状态（点一下测试连接） */
  private renderSettingsHeader(containerEl: HTMLElement) {
    const header = containerEl.createDiv({ cls: 'vs-settings-header' });

    const text = header.createDiv({ cls: 'vs-settings-heading' });
    text.createDiv({ text: tr('视频总结', 'Video summary'), cls: 'vs-settings-title' });
    text.createDiv({ text: `v${this.plugin.manifest.version}`, cls: 'vs-settings-sub' });

    const pill = header.createEl('button', {
      cls: 'vs-settings-pill',
      attr: {
        type: 'button',
        title: tr('点击测试后端连接', 'Click to test the backend connection'),
      },
    });
    const dot = pill.createSpan({ cls: 'vs-backend-dot' });
    const label = pill.createSpan({ text: tr('未检测', 'Not checked') });
    pill.addEventListener(
      'click',
      fire(async () => {
        dot.className = 'vs-backend-dot is-checking';
        label.setText(tr('检测中…', 'Checking…'));
        try {
          const result = await this.plugin.api.testConnection();
          dot.className = `vs-backend-dot ${result.success ? 'is-online' : 'is-offline'}`;
          label.setText(
            result.success
              ? tr(
                  `后端在线 · ${result.durationMs ?? 0}ms`,
                  `Backend online · ${result.durationMs ?? 0} ms`,
                )
              : tr('后端离线', 'Backend offline'),
          );
        } catch {
          dot.className = 'vs-backend-dot is-offline';
          label.setText(tr('后端离线', 'Backend offline'));
        }
      }),
    );
  }

  /** 段内小节：一行小标题，不画卡片框 */
  private sectionCard(
    containerEl: HTMLElement,
    _icon: string,
    title: string,
    extraCls = '',
  ): { section: HTMLElement; titleRow: HTMLElement } {
    const section = containerEl.createDiv({
      cls: `vs-settings-section ${extraCls}`.trim(),
    });
    const titleRow = section.createDiv({ cls: 'vs-settings-section-title' });
    titleRow.createSpan({ text: title });
    return { section, titleRow };
  }

  /** 首次配置：粘贴连接码 → 检查 → 试运行。每一步出错都写明怎么修。 */
  private createSetupGuideSection(containerEl: HTMLElement) {
    const { section, titleRow } = this.sectionCard(
      containerEl,
      'shield-check',
      tr('首次配置', 'First-run setup'),
      'setup-guide-section',
    );
    titleRow.addClass('setup-guide-title-row');

    if (this.plugin.settings.setupGuideDismissed) {
      new Setting(section)
        .setName(tr('首次配置已完成', 'First-run setup done'))
        .setDesc(
          tr(
            '换了后端、连接出错或想重新检查时，再打开它。',
            'Open it again after changing the backend, when the connection fails, or to check again.',
          ),
        )
        .addButton((button) =>
          button.setButtonText(tr('重新打开', 'Open again')).onClick(async () => {
            this.plugin.settings.setupGuideDismissed = false;
            await this.plugin.saveSettings();
            this.redraw();
          }),
        );
      return;
    }

    const intro = section.createEl('p', { cls: 'setting-item-description' });
    intro.appendText(tr('还没有后端？看', 'No backend yet? See the '));
    intro.createEl('a', { text: tr('安装教程', 'install guide'), href: SETUP_GUIDE_URL });
    intro.appendText(tr('。', '.'));

    const results = section.createDiv({ cls: 'setup-check-list' });
    const runCheck = async (deep: boolean) => {
      results.empty();
      results.createDiv({
        text: deep
          ? tr(
              '完整检查中，会调用一次模型和语音转写，约 10–30 秒…',
              'Full check in progress; it calls the model and speech-to-text once, about 10–30 seconds…',
            )
          : tr('检查中…', 'Checking…'),
        cls: 'setup-check-progress',
      });
      const outcome = await this.plugin.api.checkBackend(deep);
      const steps = interpretSetupCheck({ ...outcome, deep });
      this.renderSetupSteps(results, steps);
      const model = reportedChatModel(outcome.report);
      if (model && model !== this.plugin.settings.aiModel) {
        this.plugin.settings.aiModel = model;
        this.plugin.api.setAiModel(model);
        await this.plugin.saveSettings();
      }
    };

    let codeInput: HTMLInputElement | null = null;
    const applyCode = async (raw: string) => {
      const code = parseConnectionCode(raw, DEFAULT_N8N_WEBHOOK_URL);
      if (!code) {
        new Notice(
          tr(
            '这不是连接码。请粘贴启动脚本最后显示的那一整行。',
            'That is not a connection code. Paste the whole last line the start script printed.',
          ),
          8000,
        );
        return;
      }
      await this.applyConnectionCode(code);
      if (codeInput) codeInput.value = '';
      new Notice(tr('连接码已保存，正在检查…', 'Connection code saved; checking…'));
      await runCheck(false);
    };

    new Setting(section)
      .setName(tr('① 连接码', '① Connection code'))
      .setDesc(
        tr(
          '启动脚本的最后一行，已复制到剪贴板。连接码相当于口令，不要发给别人。',
          'The last line of the start script, already on your clipboard. It works like a password; keep it to yourself.',
        ),
      )
      .addText((text) => {
        codeInput = text.inputEl;
        text.inputEl.type = 'password';
        text.setPlaceholder(
          tr('粘贴启动脚本给的连接码', 'Paste the connection code from the start script'),
        );
        text.inputEl.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') fire(() => applyCode(text.getValue()))();
        });
      })
      .addButton((button) =>
        button
          .setButtonText(tr('从剪贴板粘贴', 'Paste from clipboard'))
          .setCta()
          .onClick(async () => {
            let clip = '';
            try {
              clip = await navigator.clipboard.readText();
            } catch {
              new Notice(
                tr(
                  '读不到剪贴板，请手动粘贴到输入框后按回车。',
                  'Cannot read the clipboard; paste into the box and press Enter.',
                ),
              );
              return;
            }
            await applyCode(clip);
          }),
      );

    new Setting(section)
      .setName(tr('② 检查', '② Check'))
      .setDesc(
        tr(
          '快速检查只看后端和连接码；完整检查还会确认模型和语音转写的密钥真的能用。',
          'The quick check covers the backend and the connection code; the full check also confirms the model and speech-to-text keys work.',
        ),
      )
      .addButton((button) =>
        button.setButtonText(tr('快速检查', 'Quick check')).onClick(async () => {
          button.setDisabled(true);
          await runCheck(false);
          button.setDisabled(false);
        }),
      )
      .addButton((button) =>
        button
          .setButtonText(tr('完整检查', 'Full check'))
          .setCta()
          .onClick(async () => {
            button.setDisabled(true);
            await runCheck(true);
            button.setDisabled(false);
          }),
      );
    section.appendChild(results);

    const trialResult = section.createDiv({ cls: 'setup-diagnostic-result' });
    new Setting(section)
      .setName(tr('③ 试运行', '③ Trial run'))
      .setDesc(
        tr(
          '用一段内置的短文稿生成一次总结，确认整条流程能跑通。会消耗极少量模型额度。',
          'Summarises a short built-in text to confirm the whole chain works. Uses a tiny amount of model credit.',
        ),
      )
      .addButton((button) =>
        button.setButtonText(tr('试运行', 'Trial run')).onClick(async () => {
          button.setDisabled(true);
          trialResult.empty();
          trialResult.removeClass('is-success', 'is-error');
          trialResult.createEl('p', { text: tr('正在生成总结…', 'Generating a summary…') });
          const result = await this.plugin.api.trialRun(SETUP_TRIAL_TRANSCRIPT);
          trialResult.empty();
          trialResult.addClass(result.ok ? 'is-success' : 'is-error');
          trialResult.createEl('strong', {
            text: result.ok
              ? tr(
                  `跑通了，用时 ${(result.durationMs / 1000).toFixed(1)} 秒`,
                  `It works, ${(result.durationMs / 1000).toFixed(1)} s`,
                )
              : tr('没有跑通', 'It did not work'),
          });
          trialResult.createEl('p', { text: result.message });
          button.setDisabled(false);
        }),
      );
    section.appendChild(trialResult);

    this.createBilibiliLoginStep(section);

    const cookies = section.createEl('details', { cls: 'setup-cookie-paste' });
    cookies.createEl('summary', {
      text: tr('不方便扫码？粘贴 cookies.txt', 'Cannot scan? Paste a cookies.txt'),
    });
    cookies.createEl('p', {
      text: tr(
        '也可以用视频总结浏览器扩展的“同步 B 站登录”，或用任意“导出 cookies.txt”扩展在 bilibili.com 导出，把全文粘贴到这里。内容只发给你自己的后端。',
        'You can also use the Video Summary browser extension\'s "Sync Bilibili login", or export bilibili.com with any "export cookies.txt" extension and paste the whole file here. It goes only to your own backend.',
      ),
      cls: 'setting-item-description',
    });
    const cookieText = cookies.createEl('textarea', {
      cls: 'setup-cookie-text',
      attr: {
        rows: '4',
        placeholder: tr('粘贴 cookies.txt 的全文', 'Paste the whole cookies.txt'),
        spellcheck: 'false',
      },
    });
    const cookieStatus = cookies.createEl('p', { cls: 'setting-item-description' });
    this.buttonRow(cookies, (button) =>
      button.setButtonText(tr('保存到后端', 'Save to backend')).onClick(async () => {
        button.setDisabled(true);
        const result = await this.plugin.api.uploadCookies('bilibili', cookieText.value);
        cookieStatus.setText(result.message);
        if (result.ok) cookieText.value = '';
        button.setDisabled(false);
      }),
    );

    this.buttonRow(section, (button) =>
      button.setButtonText(tr('完成，收起', 'Done, collapse')).onClick(async () => {
        this.plugin.settings.setupGuideDismissed = true;
        await this.plugin.saveSettings();
        this.redraw();
      }),
    );
  }

  /** ④ 扫码登录 B 站：登录 cookie 直接交给自己的后端，插件不保存。 */
  private createBilibiliLoginStep(section: HTMLElement) {
    const panel = section.createDiv({ cls: 'setup-qr' });
    const status = section.createEl('p', { cls: 'setting-item-description' });
    let polling = 0;
    const stop = () => {
      if (polling) window.clearInterval(polling);
      polling = 0;
    };

    new Setting(section)
      .setName(tr('④ 哔哩哔哩登录（可选）', '④ Bilibili login (optional)'))
      .setDesc(
        tr(
          '用哔哩哔哩手机客户端扫码登录后，能拿到它的字幕和 AI 字幕，不用再转写。登录信息只交给你自己的后端，插件不保存。',
          'Scan with the Bilibili phone app to log in; the backend can then use Bilibili subtitles and AI subtitles instead of transcribing. The login goes only to your own backend; the plugin does not keep it.',
        ),
      )
      .addButton((button) =>
        button.setButtonText(tr('扫码登录', 'Scan to log in')).onClick(async () => {
          stop();
          panel.empty();
          status.setText(tr('正在向哔哩哔哩要二维码…', 'Asking Bilibili for a QR code…'));
          let ticket: QrLoginTicket;
          try {
            ticket = await startQrLogin();
          } catch (error) {
            status.setText(
              tr(
                `拿不到二维码：${this.plugin.formatErrorForNotice(error)}`,
                `Could not get a QR code: ${this.plugin.formatErrorForNotice(error)}`,
              ),
            );
            return;
          }
          drawQrCode(panel, ticket.url);
          status.setText(
            tr(
              '用哔哩哔哩手机客户端扫一扫，并在手机上确认登录。',
              'Scan with the Bilibili phone app and confirm the login on your phone.',
            ),
          );
          const started = Date.now();
          let busy = false;
          polling = window.setInterval(() => {
            if (busy) return;
            if (Date.now() - started > 180_000) {
              stop();
              panel.empty();
              status.setText(
                tr(
                  '二维码过期了，再点一次“扫码登录”。',
                  'The QR code expired; press "Scan to log in" again.',
                ),
              );
              return;
            }
            busy = true;
            fire(async () => {
              try {
                await tick();
              } finally {
                busy = false;
              }
            })();
          }, 2000);
          const tick = async () => {
            const result = await pollQrLogin(ticket.key);
            if (result.state === 'scanned')
              status.setText(tr('已扫码，请在手机上点确认。', 'Scanned; confirm on your phone.'));
            if (result.state === 'expired' || result.state === 'error') {
              stop();
              panel.empty();
              status.setText(
                result.state === 'expired'
                  ? tr(
                      '二维码过期了，再点一次“扫码登录”。',
                      'The QR code expired; press "Scan to log in" again.',
                    )
                  : tr(`登录没有完成：${result.message}`, `Login not completed: ${result.message}`),
              );
            }
            if (result.state === 'done') {
              stop();
              panel.empty();
              status.setText(tr('已登录，正在交给后端…', 'Logged in; handing it to the backend…'));
              const saved = await this.plugin.api.uploadCookies('bilibili', result.cookies);
              status.setText(
                saved.ok
                  ? tr(
                      `B 站登录已交给后端。${saved.message}`,
                      `Bilibili login handed to the backend. ${saved.message}`,
                    )
                  : saved.message,
              );
            }
          };
          this.plugin.register(stop);
        }),
      );
    section.appendChild(panel);
    section.appendChild(status);
  }

  private renderSetupSteps(container: HTMLElement, steps: SetupStep[]) {
    container.empty();
    const icons: Record<SetupStep['state'], string> = {
      ready: '✓',
      warning: '!',
      missing: '✗',
      pending: '·',
    };
    for (const item of steps) {
      const row = container.createDiv({ cls: `setup-check-item is-${item.state}` });
      row.createSpan({ text: icons[item.state], cls: 'setup-check-icon' });
      const body = row.createDiv({ cls: 'setup-check-text' });
      body.createEl('strong', { text: item.label });
      body.createSpan({ text: item.detail });
      if (item.fix && item.state !== 'ready') {
        body.createSpan({
          text: tr(`怎么办：${item.fix}`, `What to do: ${item.fix}`),
          cls: 'setup-check-fix',
        });
      }
    }
  }

  private async applyConnectionCode(code: ConnectionCode) {
    const settings = this.plugin.settings;
    let profile = this.plugin.getActiveWebhookProfile();
    if (!profile) {
      profile = {
        id: 'default-webhook',
        name: tr('本机后端', 'This computer'),
        url: '',
        headerName: '',
        secret: '',
      };
      settings.webhookProfiles.push(profile);
      settings.activeWebhookId = profile.id;
    }
    profile.url = code.url;
    profile.headerName = code.headerName;
    profile.secret = code.secret;
    settings.n8nWebhookUrl = code.url;
    await this.plugin.setActiveBackend('n8n');
  }

  private renderConnectionResult(containerEl: HTMLElement, result: ConnectionTestResult) {
    containerEl.empty();
    containerEl.removeClass('is-success');
    containerEl.removeClass('is-error');
    containerEl.addClass(result.success ? 'is-success' : 'is-error');

    containerEl.createEl('strong', {
      text: result.success
        ? tr('连接诊断通过', 'Connection check passed')
        : tr('连接诊断失败', 'Connection check failed'),
    });

    const details = [
      result.durationMs !== undefined
        ? tr(`耗时 ${result.durationMs}ms`, `Took ${result.durationMs}ms`)
        : '',
      result.status ? `HTTP ${result.status}` : '',
      result.error || '',
    ]
      .filter(Boolean)
      .join(' | ');

    if (details) {
      containerEl.createEl('p', { text: details });
    }

    if (result.hint) {
      containerEl.createEl('p', { text: tr(`建议: ${result.hint}`, `Suggestion: ${result.hint}`) });
    }

    if (result.workflow) {
      const workflow = result.workflow;
      const workflowLines = [
        workflow.name ? tr(`名称: ${workflow.name}`, `Name: ${workflow.name}`) : '',
        workflow.version ? tr(`版本: ${workflow.version}`, `Version: ${workflow.version}`) : '',
        workflow.variant ? tr(`类型: ${workflow.variant}`, `Variant: ${workflow.variant}`) : '',
        workflow.webhookPath ? `Path: ${workflow.webhookPath}` : '',
        workflow.models?.length
          ? tr(
              `模型标签: ${workflow.models.join(', ')}`,
              `Model tags: ${workflow.models.join(', ')}`,
            )
          : '',
        workflow.requiredTools?.length
          ? tr(
              `依赖工具: ${workflow.requiredTools.join(', ')}`,
              `Required tools: ${workflow.requiredTools.join(', ')}`,
            )
          : '',
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
    const { section } = this.sectionCard(
      containerEl,
      'layout-grid',
      tr('各平台说明', 'Platforms'),
      'platform-matrix-section',
    );
    const list = section.createDiv({ cls: 'platform-matrix-list' });
    platformCapabilities().forEach((item) => {
      const row = list.createDiv({ cls: `platform-matrix-row is-${item.status}` });
      row.createEl('strong', { text: item.platform });
      row.createSpan({ text: item.requirements, cls: 'platform-matrix-need' });
      row.createSpan({
        text: this.getPlatformStatusLabel(item.status),
        cls: 'platform-status-label',
      });
    });
  }

  private getPlatformStatusLabel(status: PlatformCapability['status']) {
    switch (status) {
      case 'recommended':
        return tr('推荐', 'Recommended');
      case 'supported':
        return tr('可用', 'Works');
      case 'limited':
        return tr('受限', 'Limited');
      default:
        return tr('本地', 'Local');
    }
  }

  /**
   * Cookies 管理：定位后端文件夹的 cookies 目录，一键打开 + 检测各平台 cookies 文件状态。
   * 解决 Bilibili HTTP 412 / 抖音小红书下载失败时"cookies 到底放没放、过没过期"的排查痛点。
   */
  private createCookiesSection(containerEl: HTMLElement) {
    const { section } = this.sectionCard(containerEl, 'cookie', tr('Cookies 管理', 'Cookies'));
    section.createEl('p', {
      text: tr(
        '受限平台（哔哩哔哩、抖音、抖音国际版、小红书）经常需要浏览器导出的 cookies。目录是后端文件夹里的 cookies；文件名如 bilibili_cookies.txt。',
        'Restricted platforms (Bilibili, Douyin, TikTok, Xiaohongshu) often need cookies exported from your browser. They go in the cookies folder inside the backend folder, named like bilibili_cookies.txt.',
      ),
      cls: 'setting-item-description',
    });

    const resultBox = section.createDiv({ cls: 'setup-diagnostic-result' });

    new Setting(section)
      .setName(tr('Cookies 目录', 'Cookies folder'))
      .addText((text) =>
        text
          .setPlaceholder('/path/to/video-summary-backend/cookies')
          .setValue(this.plugin.settings.cookiesDirPath || '')
          .onChange(async (value) => {
            this.plugin.settings.cookiesDirPath = value.trim();
            await this.plugin.saveSettings();
          }),
      )
      .addButton((button) =>
        button.setButtonText(tr('打开目录', 'Open folder')).onClick(() => {
          const dir = (this.plugin.settings.cookiesDirPath || '').trim();
          if (!dir) {
            new Notice(tr('请先填写 cookies 目录路径', 'Fill in the cookies folder first'));
            return;
          }
          try {
            if (!openPathInSystem(dir)) {
              new Notice(
                tr(
                  '当前环境不支持打开系统目录（仅桌面端可用）',
                  'Opening system folders is not available here (desktop only)',
                ),
              );
            }
          } catch (error) {
            new Notice(
              tr(
                `打开目录失败: ${(error as Error).message}`,
                `Could not open the folder: ${(error as Error).message}`,
              ),
            );
          }
        }),
      )
      .addButton((button) =>
        button
          .setButtonText(tr('检测 cookies', 'Check cookies'))
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
      containerEl.createEl('p', {
        text: tr('请先填写 cookies 目录路径。', 'Fill in the cookies folder first.'),
      });
      return;
    }

    let fs: DesktopFs | undefined;
    let pathModule: DesktopPath | undefined;
    try {
      fs = desktopRequire('fs') as DesktopFs | undefined;
      pathModule = desktopRequire('path') as DesktopPath | undefined;
    } catch {
      // fallthrough
    }
    if (!fs || !pathModule) {
      containerEl.addClass('is-error');
      containerEl.createEl('p', {
        text: tr(
          '当前环境不支持文件系统访问（仅桌面端可用）。',
          'File system access is not available here (desktop only).',
        ),
      });
      return;
    }

    try {
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        containerEl.addClass('is-error');
        containerEl.createEl('strong', { text: tr('目录不存在', 'Folder not found') });
        containerEl.createEl('p', { text: tr(`找不到目录: ${dir}`, `Folder not found: ${dir}`) });
        return;
      }

      const STALE_DAYS = 30;
      const files: string[] = fs
        .readdirSync(dir)
        .filter((name: string) => /_cookies\.txt$/i.test(name) || /^cookies\.txt$/i.test(name));

      if (files.length === 0) {
        containerEl.addClass('is-error');
        containerEl.createEl('strong', {
          text: tr('没有找到任何 cookies 文件', 'No cookies files found'),
        });
        containerEl.createEl('p', {
          text: tr(
            `目录里没有 *_cookies.txt。Bilibili 需要 bilibili_cookies.txt；用浏览器扩展（如 Get cookies.txt LOCALLY）导出后放进来即可。`,
            `No *_cookies.txt in the folder. Bilibili needs bilibili_cookies.txt; export it with a browser extension (such as Get cookies.txt LOCALLY) and put it here.`,
          ),
        });
        return;
      }

      containerEl.addClass('is-success');
      containerEl.createEl('strong', {
        text: tr(`找到 ${files.length} 个 cookies 文件`, `Found ${files.length} cookies files`),
      });

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
            text: tr(
              `${stale ? '⚠️ ' : ''}${name} — ${sizeKb}KB，更新于 ${ageDays} 天前${stale ? `（超过 ${STALE_DAYS} 天，可能已失效）` : ''}`,
              `${stale ? '⚠️ ' : ''}${name} — ${sizeKb} KB, updated ${ageDays} days ago${stale ? ` (over ${STALE_DAYS} days, may have expired)` : ''}`,
            ),
          });
        } catch {
          list.createEl('li', {
            text: tr(`${name} — 无法读取文件信息`, `${name} — cannot read file info`),
          });
        }
      });

      if (!files.some((name: string) => /^bilibili_/i.test(name))) {
        containerEl.createEl('p', {
          text: tr(
            '提示：未发现 bilibili_cookies.txt，哔哩哔哩返回 HTTP 412 时需要它。',
            'Tip: no bilibili_cookies.txt; Bilibili needs it when it returns HTTP 412.',
          ),
        });
      }
      if (hasStale) {
        containerEl.createEl('p', {
          text: tr(
            '有文件较旧。平台 cookies 通常几周内失效，下载失败时优先重新导出。',
            'Some files are old. Platform cookies usually expire within weeks; export again if downloads fail.',
          ),
        });
      }
    } catch (error) {
      containerEl.addClass('is-error');
      containerEl.createEl('p', {
        text: tr(
          `检测失败: ${(error as Error).message}`,
          `Check failed: ${(error as Error).message}`,
        ),
      });
    }
  }

  private createApiSection(containerEl: HTMLElement) {
    const { section } = this.sectionCard(containerEl, 'link', tr('处理服务', 'Backend'));

    new Setting(section).setName(tr('主处理后端', 'Main backend')).addDropdown((dropdown) =>
      dropdown
        .addOption('n8n', tr('兼容 n8n 的 webhook', 'n8n-compatible webhook'))
        .addOption('codex-worker', tr('Codex 本地视频服务', 'Codex local video service'))
        .setValue(this.plugin.settings.activeBackend || DEFAULT_SETTINGS.activeBackend)
        .onChange(async (value) => {
          await this.plugin.setActiveBackend(value as ProcessingBackend);
          new Notice(
            value === 'codex-worker'
              ? tr('已切换到 Codex Video Worker', 'Switched to the Codex Video Worker')
              : tr('已切换到 n8n / 兼容 Webhook', 'Switched to n8n / compatible webhook'),
          );
          this.redraw();
        }),
    );

    new Setting(section)
      .setName(tr('Codex 本地服务地址', 'Codex local service address'))
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
        button.setButtonText(tr('打开控制台', 'Open dashboard')).onClick(() => {
          this.plugin.openCodexWorkerDashboard();
        }),
      );

    const webhookSetting = new Setting(section)
      .setName(tr('默认 webhook（n8n 或兼容服务）', 'Default webhook (n8n or compatible)'))
      .setDesc(
        tr(
          '选这里的默认项会把主处理后端切回 n8n 或兼容服务。',
          'Choosing the default here switches the main backend back to n8n or a compatible service.',
        ),
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
        const option = createEl('option');
        option.value = profile.id;
        option.textContent = profile.name || profile.url || tr('未命名 Webhook', 'Unnamed webhook');
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
      button.setButtonText(tr('测试当前后端', 'Test the current backend')).onClick(async () => {
        button.setDisabled(true);
        button.setButtonText(tr('测试中...', 'Testing...'));
        try {
          const res = await this.plugin.api.testConnection();
          const label =
            this.plugin.settings.activeBackend === 'codex-worker'
              ? 'Codex Worker'
              : tr('兼容 n8n 的 webhook', 'n8n-compatible webhook');
          if (res.success) {
            new Notice(
              tr(
                `${label} 连接成功（${res.durationMs}ms）`,
                `${label} connected (${res.durationMs} ms)`,
              ),
              3000,
            );
          } else {
            const hint = res.hint ? tr(`\n建议: ${res.hint}`, `\nSuggestion: ${res.hint}`) : '';
            new Notice(
              tr(
                `${label} 连接失败: ${res.error || '未知错误'}${hint}`,
                `${label} connection failed: ${res.error || 'unknown error'}${hint}`,
              ),
              8000,
            );
          }
          this.renderConnectionResult(workflowDiagnosticResult, res);
        } catch (error) {
          this.renderConnectionResult(workflowDiagnosticResult, {
            success: false,
            error: this.plugin.formatErrorForNotice(error),
          });
        } finally {
          button.setDisabled(false);
          button.setButtonText(tr('测试当前后端', 'Test the current backend'));
        }
      }),
    );

    const profilesContainer = section.createDiv({ cls: 'webhook-profiles-container' });

    const renderProfiles = () => {
      profilesContainer.empty();

      if (this.plugin.settings.webhookProfiles.length === 0) {
        profilesContainer.createEl('p', {
          text: tr('尚未配置任何 webhook。', 'No webhook configured yet.'),
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
          attr: { placeholder: tr('Webhook 名称', 'Webhook name') },
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
          attr: { placeholder: tr('Webhook 地址', 'Webhook address') },
        });
        urlInput.oninput = async () => {
          profile.url = urlInput.value.trim();
          await this.plugin.saveSettings();
          if (profile.id === this.plugin.settings.activeWebhookId) {
            await this.plugin.setActiveWebhook(profile.id, { silent: true });
            refreshDropdownOptions();
          }
        };

        const headerInput = row.createEl('input', {
          type: 'text',
          value: profile.headerName || DEFAULT_WEBHOOK_AUTH_HEADER,
          cls: 'webhook-auth-header-input',
          attr: {
            placeholder: DEFAULT_WEBHOOK_AUTH_HEADER,
            'aria-label': tr('Webhook 鉴权请求头名称', 'Webhook auth header name'),
            title: tr(
              '附带工作流 2.1.5 必填：须与 n8n Header Auth 的 Header 名称一致',
              'Required by the bundled workflow: must match the n8n Header Auth header name',
            ),
          },
        });
        headerInput.oninput = async () => {
          profile.headerName = headerInput.value.trim() || DEFAULT_WEBHOOK_AUTH_HEADER;
          if (
            profile.id === this.plugin.settings.activeWebhookId &&
            this.plugin.settings.activeBackend === 'n8n'
          ) {
            this.plugin.reinitializeApi(profile.url);
          }
          await this.plugin.saveSettings();
        };

        const secretInput = row.createEl('input', {
          type: 'password',
          value: profile.secret || '',
          cls: 'webhook-auth-secret-input',
          attr: {
            placeholder: tr(
              '鉴权 Secret（工作流 2.1.5 必填）',
              'Auth secret (required by the bundled workflow)',
            ),
            'aria-label': tr('Webhook 鉴权密钥', 'Webhook auth secret'),
            title: tr(
              '附带工作流 2.1.5 必填；只有另行部署的兼容旧端点才可留空（留空时不发送鉴权 Header）',
              'Required by the bundled workflow; only an older compatible endpoint you deployed yourself may leave it empty (then no auth header is sent)',
            ),
            autocomplete: 'off',
            spellcheck: 'false',
          },
        });
        secretInput.oninput = async () => {
          profile.secret = secretInput.value;
          if (
            profile.id === this.plugin.settings.activeWebhookId &&
            this.plugin.settings.activeBackend === 'n8n'
          ) {
            this.plugin.reinitializeApi(profile.url);
          }
          await this.plugin.saveSettings();
        };

        const actions = row.createDiv({ cls: 'webhook-profile-actions' });

        const isActive = profile.id === this.plugin.settings.activeWebhookId;
        const defaultBtn = actions.createEl('button', {
          text: isActive ? tr('默认', 'Default') : tr('设为默认', 'Make default'),
          cls: 'action-btn secondary webhook-default-btn',
        });
        defaultBtn.onclick = async () => {
          await this.plugin.setActiveWebhook(profile.id);
          refreshDropdownOptions();
          renderProfiles();
        };

        const deleteBtn = actions.createEl('button', {
          text: tr('删除', 'Delete'),
          cls: 'btn-text-only webhook-delete-btn',
        });
        deleteBtn.onclick = async () => {
          if (this.plugin.settings.webhookProfiles.length <= 1) {
            new Notice(tr('至少需要保留一个 webhook', 'Keep at least one webhook'));
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

    this.buttonRow(section, (button) =>
      button
        .setButtonText(tr('添加 webhook', 'Add webhook'))
        .setCta()
        .onClick(async () => {
          const newProfile: WebhookProfile = {
            id: `webhook-${Date.now()}`,
            name: `Webhook ${this.plugin.settings.webhookProfiles.length + 1}`,
            url: '',
            headerName: DEFAULT_WEBHOOK_AUTH_HEADER,
            secret: '',
          };
          this.plugin.settings.webhookProfiles.push(newProfile);
          await this.plugin.saveSettings();
          refreshDropdownOptions();
          renderProfiles();
        }),
    );
  }

  private createBasicSection(containerEl: HTMLElement) {
    const { section } = this.sectionCard(
      containerEl,
      'sliders-horizontal',
      tr('默认处理方式', 'Default processing'),
    );

    new Setting(section)
      .setName(tr('默认理解深度', 'Default depth'))
      .setDesc(
        this.plugin.settings.activeBackend === 'codex-worker'
          ? tr(
              '极速只读字幕；证据模式保留时间轴；深度视觉会分析关键画面。',
              'Quick reads subtitles only; evidence keeps the timeline; deep visual analyses key frames.',
            )
          : tr(
              '极速只读字幕；证据模式保留时间轴。深度视觉需要先切换到 Codex Worker。',
              'Quick reads subtitles only; evidence keeps the timeline. Deep visual needs the Codex Worker.',
            ),
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption('quick', tr('极速', 'Quick'))
          .addOption('evidence', tr('证据', 'Evidence'))
          .addOption('deep-visual', tr('深度视觉', 'Deep visual'))
          .setValue(this.plugin.settings.defaultProcessingDepth)
          .onChange(async (value) => {
            const depth = value as ProcessingDepth;
            if (depth === 'deep-visual' && this.plugin.settings.activeBackend !== 'codex-worker') {
              dropdown.setValue('evidence');
              new Notice(
                tr(
                  '深度视觉只能由本机视频处理服务执行；当前 n8n 后端最多用到证据模式。',
                  'Deep visual runs only on the local video service; the n8n backend goes up to evidence.',
                ),
                7000,
              );
              return;
            }
            this.plugin.settings.defaultProcessingDepth = depth;
            this.plugin.api.setAnalysisDefaults({ processingDepth: depth });
            await this.plugin.saveSettings();
          }),
      );

    new Setting(section)
      .setName(tr('默认内容类型', 'Default content type'))
      .addDropdown((dropdown) =>
        dropdown
          .addOption('auto', tr('自动识别', 'Automatic'))
          .addOption('course', tr('课程', 'Course'))
          .addOption('interview', tr('访谈', 'Interview'))
          .addOption('tutorial', tr('教程', 'Tutorial'))
          .addOption('news', tr('新闻', 'News'))
          .addOption('meeting', tr('会议', 'Meeting'))
          .addOption('review', tr('评测', 'Review'))
          .addOption('general', tr('通用', 'General'))
          .setValue(this.plugin.settings.defaultContentType)
          .onChange(async (value) => {
            const contentType = value as RequestedContentType;
            this.plugin.settings.defaultContentType = contentType;
            this.plugin.settings.autoRouteContent = contentType === 'auto';
            this.plugin.api.setAnalysisDefaults({
              contentType,
              autoRoute: this.plugin.settings.autoRouteContent,
            });
            await this.plugin.saveSettings();
          }),
      );

    new Setting(section)
      .setName(tr('观看价值判断', 'Worth watching?'))
      .setDesc(
        tr(
          '输出值得观看、建议略读或可以跳过，并给出高价值片段。',
          'Say whether a video is worth watching, worth skimming or skippable, with its best segments.',
        ),
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.attentionAssessmentEnabled).onChange(async (value) => {
          this.plugin.settings.attentionAssessmentEnabled = value;
          this.plugin.api.setAnalysisDefaults({ attentionAssessment: value });
          await this.plugin.saveSettings();
        }),
      );

    new Setting(section)
      .setName(tr('生成学习练习', 'Generate learning exercises'))
      .setDesc(
        tr(
          '随结果生成闪卡、自测题和费曼解释题；默认关闭以节省处理成本。',
          'Add flashcards, quiz questions and Feynman prompts to the result; off by default to save cost.',
        ),
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.generateLearningArtifacts).onChange(async (value) => {
          this.plugin.settings.generateLearningArtifacts = value;
          this.plugin.api.setAnalysisDefaults({ generateLearning: value });
          await this.plugin.saveSettings();
        }),
      );

    new Setting(section)
      .setName(tr('处理模型', 'Model'))
      .setDesc(
        tr(
          `由后端 .env 里的 VS_CHAT_MODEL 决定，所有总结步骤共用一个模型。上次检查：${this.plugin.settings.aiModel || '还没检查'}。换模型时改 .env，再运行一次启动脚本。`,
          `Set by VS_CHAT_MODEL in the backend's .env; every summary step uses this one model. Last check: ${this.plugin.settings.aiModel || 'not checked yet'}. To change it, edit .env and run the start script again.`,
        ),
      );

    // 超时时间设置
    new Setting(section).setName(tr('请求超时时间', 'Request timeout')).addSlider((slider) =>
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
  }

  private createOutputSection(containerEl: HTMLElement) {
    const { section } = this.sectionCard(containerEl, 'folder', tr('笔记', 'Notes'));

    // 默认语言设置
    new Setting(section).setName(tr('默认语言', 'Default language')).addDropdown((dropdown) =>
      dropdown
        .addOption('zh', '中文')
        .addOption('en', tr('英文', 'English'))
        .addOption('ja', tr('日文', 'Japanese'))
        .setValue(this.plugin.settings.defaultLanguage)
        .onChange(async (value) => {
          this.plugin.settings.defaultLanguage = value as 'zh' | 'en' | 'ja';
          await this.plugin.saveSettings();
        }),
    );

    // 自动保存设置
    new Setting(section).setName(tr('自动保存', 'Save automatically')).addToggle((toggle) =>
      toggle.setValue(this.plugin.settings.autoSave).onChange(async (value) => {
        this.plugin.settings.autoSave = value;
        await this.plugin.saveSettings();
      }),
    );

    // 输出文件夹设置
    new Setting(section)
      .setName(tr('输出文件夹', 'Output folder'))
      .setDesc(
        tr(
          '新建视频笔记在库内的相对路径；不允许 .、.. 或绝对路径。',
          'Folder for new video notes, relative to the vault; ., .. and absolute paths are not allowed.',
        ),
      )
      .addText((text) =>
        text
          .setPlaceholder(tr('例如: Videos/2024', 'For example Videos/2024'))
          .setValue(this.plugin.settings.outputFolder)
          .onChange(async (value) => {
            try {
              const normalized = normalizeVideoSummaryBaseFolder(value.trim());
              this.plugin.settings.outputFolder = normalized;
              await this.plugin.saveSettings();
            } catch {
              text.setValue(this.plugin.settings.outputFolder);
              new Notice(
                tr(
                  '输出文件夹必须是库内的安全相对路径，不能包含 . 或 ..。',
                  'The output folder must be a safe path inside the vault, without . or ..',
                ),
                6000,
              );
            }
          }),
      );

    new Setting(section)
      .setName(tr('文稿引用格式', 'Transcript quote format'))
      .setDesc(
        tr(
          '在阅读器里右键一段文稿“复制引用”“插入到笔记”或把它拖进笔记时使用。可用 {{text}} {{time}} {{link}} {{url}} {{speaker}} {{title}} {{note}}，\\n 表示换行。',
          'Used when you right-click a transcript line in Reader to copy a quote or insert it into a note, or drag it into a note. Available: {{text}} {{time}} {{link}} {{url}} {{speaker}} {{title}} {{note}}; \\n is a line break.',
        ),
      )
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_QUOTE_TEMPLATE)
          .setValue(this.plugin.settings.readerQuoteTemplate)
          .onChange(async (value) => {
            this.plugin.settings.readerQuoteTemplate = value.trim() || DEFAULT_QUOTE_TEMPLATE;
            await this.plugin.saveSettings();
          }),
      );
  }

  private createQuickProcessingSection(containerEl: HTMLElement) {
    const { section } = this.sectionCard(
      containerEl,
      'zap',
      tr('命令面板里的一键处理', 'One-step commands'),
    );

    // 一键总结配置
    const summarySubsection = section.createDiv({ cls: 'vs-subsection' });
    summarySubsection.createDiv({
      text: tr('一键总结配置', 'Quick summary settings'),
      cls: 'vs-subsection-title',
    });

    new Setting(summarySubsection)
      .setName(tr('总结语言', 'Summary language'))
      .addDropdown((dropdown) =>
        dropdown
          .addOption('zh', '中文')
          .addOption('en', tr('英文', 'English'))
          .addOption('ja', tr('日文', 'Japanese'))
          .setValue(this.plugin.settings.quickSummaryOptions.language)
          .onChange(async (value) => {
            this.plugin.settings.quickSummaryOptions.language = value as 'zh' | 'en' | 'ja';
            await this.plugin.saveSettings();
          }),
      );

    new Setting(summarySubsection)
      .setName(tr('总结超时时间', 'Summary timeout'))
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
    const transcriptSubsection = section.createDiv({ cls: 'vs-subsection' });
    transcriptSubsection.createDiv({
      text: tr('一键提取文稿配置', 'Quick transcript settings'),
      cls: 'vs-subsection-title',
    });

    new Setting(transcriptSubsection)
      .setName(tr('文稿语言', 'Transcript language'))
      .addDropdown((dropdown) =>
        dropdown
          .addOption('zh', '中文')
          .addOption('en', tr('英文', 'English'))
          .addOption('ja', tr('日文', 'Japanese'))
          .setValue(this.plugin.settings.quickTranscriptOptions.language)
          .onChange(async (value) => {
            this.plugin.settings.quickTranscriptOptions.language = value as 'zh' | 'en' | 'ja';
            await this.plugin.saveSettings();
          }),
      );

    new Setting(transcriptSubsection)
      .setName(tr('文稿超时时间', 'Transcript timeout'))
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
    const { section } = this.sectionCard(containerEl, 'files', tr('文件与命名', 'Files and names'));

    // 自动重命名开关
    new Setting(section)
      .setName(tr('处理后自动重命名', 'Rename after processing'))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoRenameEnabled).onChange(async (value) => {
          this.plugin.settings.autoRenameEnabled = value;
          await this.plugin.saveSettings();
        }),
      );

    // 重命名冲突策略
    new Setting(section).setName(tr('重命名冲突策略', 'Name clash')).addDropdown((drop) =>
      drop
        .addOption('append-number', tr('追加编号', 'Add a number'))
        .addOption('append-date', tr('追加日期', 'Add the date'))
        .addOption('skip', tr('跳过', 'Skip'))
        .setValue(this.plugin.settings.renameConflictStrategy)
        .onChange(async (v) => {
          this.plugin.settings.renameConflictStrategy =
            v as VideoSummarySettings['renameConflictStrategy'];
          await this.plugin.saveSettings();
        }),
    );

    // 批量处理设置
    new Setting(section).setName(tr('批量处理并发数', 'Batch parallelism')).addSlider((slider) =>
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
      .setName(tr('成功状态值', 'Success status'))
      .setDesc(tr('写进 frontmatter 的 status', 'Written to the status property'))
      .addText((text) =>
        text
          .setPlaceholder(tr('例如 success', 'For example success'))
          .setValue(this.plugin.settings.successStatusValue ?? 'success')
          .onChange(async (value) => {
            const normalized = normalizeSuccessStatusValue(value);
            if (normalized !== value.trim()) {
              new Notice(
                tr(
                  '成功状态不能使用待处理、处理中或失败标记，已恢复为 success',
                  'The success status cannot be a pending, processing or failure value; reset to success',
                ),
              );
            }
            this.plugin.settings.successStatusValue = normalized;
            await this.plugin.saveSettings();
          }),
      );
  }

  private createPayloadKeysSection(containerEl: HTMLElement) {
    const { section } = this.sectionCard(
      containerEl,
      'radio',
      tr('请求字段名', 'Request field names'),
    );
    section.createEl('p', {
      text: tr(
        '只有改过 n8n 工作流的字段名时才需要改。',
        'Change these only if your n8n workflow uses different field names.',
      ),
      cls: 'setting-item-description',
    });

    const keys = this.plugin.settings.payloadKeys;

    const createKeySetting = (name: string, key: keyof typeof keys) => {
      new Setting(section).setName(name).addText((text) =>
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

    createKeySetting(tr('处理模式键', 'Mode key'), 'mode');
    createKeySetting(tr('语言键', 'Language key'), 'language');
    createKeySetting(tr('模型键', 'Model key'), 'ai');
    createKeySetting(tr('仅信息标志键', 'Info-only flag key'), 'info_only');
    createKeySetting(tr('视频链接键', 'Video link key'), 'link');
    createKeySetting(tr('手动文稿键', 'Manual transcript key'), 'provided_transcript');
    createKeySetting(tr('本地文件键', 'Local file key'), 'local_file');
  }

  private createAdvancedSection(containerEl: HTMLElement) {
    const { section } = this.sectionCard(
      containerEl,
      'wrench',
      tr('缓存与调试', 'Cache and debugging'),
    );

    // 调试模式
    new Setting(section).setName(tr('调试模式', 'Debug mode')).addToggle((toggle) =>
      toggle.setValue(this.plugin.settings.enableDebugMode).onChange(async (value) => {
        this.plugin.settings.enableDebugMode = value;
        this.plugin.api.setDebug(!!value);
        await this.plugin.saveSettings();
      }),
    );

    // 处理前后端自检
    new Setting(section)
      .setName(tr('处理前后端自检', 'Check the backend before processing'))
      .setDesc(
        tr(
          '后端不可达时先提示，另一个后端可用时建议切换。',
          'Warns when the backend is unreachable and suggests the other one if it works.',
        ),
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
      .setName(tr('短链自动展开', 'Expand short links'))
      .setDesc(
        tr(
          '把 b23.tv、v.douyin.com、xhslink.com 等短链换成最终链接再发送，减少下载失败。',
          'Sends the final link instead of b23.tv, v.douyin.com, xhslink.com and other short links, so fewer downloads fail.',
        ),
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
      .setName(tr('处理历史上限', 'History limit'))
      .setDesc(
        tr(
          `${this.plugin.settings.historyLimit ?? 300} 条`,
          `${this.plugin.settings.historyLimit ?? 300} entries`,
        ),
      )
      .addSlider((slider) =>
        slider
          .setLimits(100, 1000, 50)
          .setValue(this.plugin.settings.historyLimit ?? 300)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.historyLimit = value;
            await this.plugin.saveSettings();
            historyLimitSetting.setDesc(tr(`${value} 条`, `${value} entries`));
          }),
      );

    // 缓存配置
    const cacheSubsection = section.createDiv({ cls: 'vs-subsection' });
    cacheSubsection.createDiv({ text: tr('缓存配置', 'Cache'), cls: 'vs-subsection-title' });

    // 缓存状态概览
    const cacheStatusSetting = new Setting(cacheSubsection)
      .setName(tr('缓存状态', 'Cache status'))
      .addButton((button) =>
        button
          .setButtonText(tr('📊 查看状态', '📊 Show status'))
          .setClass('cache-status-btn')
          .onClick(async () => {
            try {
              const stats = this.plugin.api.getCacheStats();
              await this.showCachePreviewModal(stats);
            } catch (error) {
              console.error('获取缓存统计失败:', error);
              new Notice(
                tr(
                  `❌ 获取缓存统计失败: ${errorMessage(error)}`,
                  `❌ Could not read cache statistics: ${errorMessage(error)}`,
                ),
                5000,
              );
            }
          }),
      );
    cacheStatusSetting.controlEl.addClass('cache-setting-item');

    // 启用缓存
    const enableCacheSetting = new Setting(cacheSubsection)
      .setName(tr('启用缓存', 'Use the cache'))
      .setDesc(
        tr(
          '缓存已处理的视频结果，避免重复调用API（节省费用）',
          'Keep processed results to avoid calling the API again (saves money)',
        ),
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enableCache ?? true).onChange(async (value) => {
          this.plugin.settings.enableCache = value;
          this.plugin.api.setCacheEnabled(value);
          await this.plugin.saveSettings();
          new Notice(
            value ? tr('✅ 缓存已启用', '✅ Cache on') : tr('❌ 缓存已禁用', '❌ Cache off'),
            2000,
          );
        }),
      );
    enableCacheSetting.controlEl.addClass('cache-setting-item');

    // 缓存过期时间
    const expirySetting = new Setting(cacheSubsection)
      .setName(tr('缓存过期时间', 'Cache expiry'))
      .setDesc(
        tr(
          `${this.plugin.settings.cacheExpiryDays ?? 30} 天`,
          `${this.plugin.settings.cacheExpiryDays ?? 30} days`,
        ),
      )
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
            expirySetting.setDesc(tr(`${value} 天`, `${value} days`));
          }),
      );
    expirySetting.controlEl.addClass('cache-setting-item');
    expirySetting.controlEl.addClass('cache-expiry-slider');

    // 分隔线
    cacheSubsection.createEl('hr', { cls: 'cache-divider' });

    // 缓存管理操作
    cacheSubsection.createDiv({
      text: tr('缓存管理', 'Cache management'),
      cls: 'vs-subsection-title',
    });

    // 快速操作按钮组
    const quickActionsContainer = cacheSubsection.createDiv({ cls: 'cache-quick-actions' });

    // 测试缓存
    const testBtn = quickActionsContainer.createEl('button', {
      text: tr('🧪 添加测试', '🧪 Add test entry'),
      cls: 'cache-quick-btn',
    });
    testBtn.onclick = async () => {
      try {
        await this.addTestCacheData();
      } catch (error) {
        new Notice(
          tr(
            `❌ 添加测试数据失败: ${errorMessage(error)}`,
            `❌ Could not add test data: ${errorMessage(error)}`,
          ),
          5000,
        );
      }
    };

    // 清理过期
    const cleanupBtn = quickActionsContainer.createEl('button', {
      text: tr('清理过期', 'Remove expired'),
      cls: 'cache-quick-btn',
    });
    cleanupBtn.onclick = async () => {
      try {
        this.plugin.api.cleanupCache();
        const stats = this.plugin.api.getCacheStats();
        new Notice(
          tr(
            `🧹 已清理过期缓存，当前缓存 ${stats.size} 项`,
            `🧹 Removed expired entries; ${stats.size} left`,
          ),
          3000,
        );
      } catch (error) {
        console.error('清理过期缓存失败:', error);
        new Notice(
          tr(
            `❌ 清理过期缓存失败: ${errorMessage(error)}`,
            `❌ Could not remove expired entries: ${errorMessage(error)}`,
          ),
          5000,
        );
      }
    };

    // 清空所有
    const clearBtn = quickActionsContainer.createEl('button', {
      text: tr('清空所有', 'Clear all'),
      cls: 'cache-quick-btn cache-danger-btn',
    });
    clearBtn.onclick = async () => {
      // 显示确认对话框
      const confirmed = await new Promise<boolean>((resolve) => {
        const confirmModal = new ConfirmModal(
          this.app,
          tr('确认清空所有缓存', 'Clear all cache?'),
          tr(
            '此操作将删除所有缓存项，无法恢复。确定要继续吗？',
            'This deletes every cached item and cannot be undone. Continue?',
          ),
          resolve,
        );
        confirmModal.open();
      });

      if (confirmed) {
        try {
          this.plugin.api.clearCache();
          new Notice(tr('🗑️ 已清空所有缓存', '🗑️ Cache cleared'), 3000);
        } catch (error) {
          console.error('清空缓存失败:', error);
          new Notice(
            tr(
              `❌ 清空缓存失败: ${errorMessage(error)}`,
              `❌ Could not clear the cache: ${errorMessage(error)}`,
            ),
            5000,
          );
        }
      }
    };

    // 缓存信息提示
    const cacheInfoContainer = cacheSubsection.createDiv({ cls: 'cache-info-container' });
    const cacheInfoTip = cacheInfoContainer.createDiv({ cls: 'cache-info-tip' });
    cacheInfoTip.createEl('strong', { text: tr('💡 缓存提示：', '💡 About the cache:') });
    const cacheInfoList = cacheInfoTip.createEl('ul');
    const cachePathItem = cacheInfoList.createEl('li');
    cachePathItem.appendText(tr('缓存文件存储在：', 'Cache files are stored in:'));
    cachePathItem.createEl('code', {
      text: tr('<插件目录>/data/cache/', '<plugin folder>/data/cache/'),
    });
    cacheInfoList.createEl('li', {
      text: tr('缓存会自动清理过期项', 'Expired entries are removed automatically'),
    });
    cacheInfoList.createEl('li', {
      text: tr(
        '禁用缓存后，所有缓存操作将被忽略',
        'With the cache off, all cache actions are ignored',
      ),
    });
    cacheInfoList.createEl('li', {
      text: tr(
        '建议定期清理过期缓存以节省空间',
        'Remove expired entries now and then to save space',
      ),
    });
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
    // 创建模态框
    const modal = new Modal(this.app);
    modal.modalEl.addClass('ap', 'ap-modal');
    modal.titleEl.setText(tr('📊 缓存预览', '📊 Cache preview'));

    const { contentEl } = modal;

    // 创建刷新函数，用于更新当前模态框内容
    const refreshModalContent = async () => {
      try {
        const newStats = this.plugin.api.getCacheStats();
        contentEl.empty();
        await renderModalContent(contentEl, newStats);
      } catch (error) {
        console.error('❌ 刷新模态框内容失败:', error);
        new Notice(
          tr(`❌ 刷新失败: ${errorMessage(error)}`, `❌ Could not refresh: ${errorMessage(error)}`),
          5000,
        );
      }
    };

    // 渲染模态框内容的函数
    const renderModalContent = async (container: HTMLElement, currentStats: typeof stats) => {
      // 统计信息
      const statsSection = container.createDiv({ cls: 'cache-preview-stats' });
      const addStatCard = (title: string, value: string, valueClass = '') => {
        const card = statsSection.createDiv({ cls: 'stat-card' });
        card.createDiv({ cls: 'stat-title', text: title });
        card.createDiv({
          cls: `stat-value${valueClass ? ` ${valueClass}` : ''}`,
          text: value,
        });
      };
      addStatCard(tr('总缓存项', 'Cached items'), String(currentStats.size));
      addStatCard(tr('最大容量', 'Capacity'), String(currentStats.maxSize));
      addStatCard(
        tr('过期项', 'Expired'),
        String(currentStats.expiredCount),
        currentStats.expiredCount > 0 ? 'expired' : '',
      );
      addStatCard(tr('总大小', 'Total size'), this.formatBytes(currentStats.totalSize));
      // 缓存内容预览
      if (currentStats.size > 0) {
        const previewSection = container.createDiv({ cls: 'cache-preview-content' });
        new Setting(previewSection).setName(tr('缓存内容预览', 'Cache contents')).setHeading();

        // 获取缓存内容
        await this.showCacheContentPreview(previewSection);
      } else {
        const emptySection = container.createDiv({ cls: 'cache-empty-section' });
        const emptyMessage = emptySection.createDiv({ cls: 'cache-empty-message' });
        emptyMessage.createEl('p', { text: tr('📭 暂无缓存内容', '📭 The cache is empty') });
        emptyMessage.createEl('p', {
          cls: 'cache-empty-tip',
          text: tr(
            '提示：处理视频后会自动添加到缓存，或者点击“添加测试”按钮添加测试数据',
            'Processed videos are added automatically, or press "Add test entry" for sample data',
          ),
        });
      }

      // 操作按钮
      const actionsSection = container.createDiv({ cls: 'cache-preview-actions' });

      // 刷新按钮
      actionsSection.createEl('button', {
        text: tr('刷新', 'Refresh'),
        cls: 'cache-action-btn',
      }).onclick = refreshModalContent;

      // 关闭按钮
      actionsSection.createEl('button', {
        text: tr('关闭', 'Close'),
        cls: 'cache-action-btn',
      }).onclick = () => {
        modal.close();
      };
    };

    // 初始渲染
    await renderModalContent(contentEl, stats);

    modal.open();
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
          text: tr('暂无缓存内容', 'The cache is empty'),
          cls: 'cache-empty-message',
        });
        return;
      }

      // 创建缓存项列表
      const itemsList = container.createDiv({ cls: 'cache-items-list' });

      // 显示前20项
      const displayItems = items.slice(0, 20);

      for (const item of displayItems) {
        const itemEl = itemsList.createDiv({ cls: 'cache-item' });

        // 缓存项信息
        const infoEl = itemEl.createDiv({ cls: 'cache-item-info' });

        // URL
        const urlEl = infoEl.createDiv({ cls: 'cache-item-url' });
        urlEl.createEl('strong', { text: 'URL:' });
        urlEl.appendText(' ');
        const displayUrl = this.truncateUrl(item.url);
        const linkableUrl = safeExternalHttpUrl(item.url);
        if (linkableUrl) {
          urlEl.createEl('a', {
            text: displayUrl,
            attr: {
              href: linkableUrl,
              target: '_blank',
              rel: 'noopener noreferrer',
            },
          });
        } else {
          urlEl.createSpan({ text: displayUrl });
        }

        // 元数据
        const metaEl = infoEl.createDiv({ cls: 'cache-item-meta' });
        metaEl.createSpan({
          cls: 'cache-item-mode',
          text: this.getModeLabel(item.mode),
        });
        metaEl.createSpan({
          cls: 'cache-item-language',
          text: this.getLanguageLabel(item.language),
        });
        metaEl.createSpan({
          cls: 'cache-item-time',
          text: this.formatTime(item.timestamp),
        });
        metaEl.createSpan({
          cls: `cache-item-status ${item.isExpired ? 'expired' : 'valid'}`,
          text: item.isExpired ? tr('已过期', 'Expired') : tr('有效', 'Valid'),
        });

        // 删除按钮
        const deleteBtn = itemEl.createEl('button', {
          text: '🗑️',
          cls: 'cache-item-delete-btn',
        });
        deleteBtn.onclick = async () => {
          try {
            await this.plugin.api.removeCacheItem(item.url, item.mode, item.language);
            itemEl.remove();
            new Notice(
              tr(`✅ 已删除缓存项: ${item.url}`, `✅ Removed cache entry: ${item.url}`),
              3000,
            );
          } catch (error) {
            new Notice(
              tr(
                `❌ 删除失败: ${errorMessage(error)}`,
                `❌ Could not delete: ${errorMessage(error)}`,
              ),
              5000,
            );
          }
        };
      }

      // 如果还有更多项，显示提示
      if (items.length > 20) {
        container.createEl('p', {
          text: tr(`还有 ${items.length - 20} 项未显示`, `${items.length - 20} more not shown`),
          cls: 'cache-more-items',
        });
      }
    } catch (error) {
      container.createEl('p', {
        text: tr(
          `获取缓存内容失败: ${errorMessage(error)}`,
          `Could not read the cache: ${errorMessage(error)}`,
        ),
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
      const cacheData = window.localStorage.getItem('video-summary-cache');
      if (cacheData) {
        const entries = asArray(JSON.parse(cacheData));
        const filteredEntries = entries.filter(
          (entry) => !(Array.isArray(entry) && entry[0] === key),
        );
        window.localStorage.setItem('video-summary-cache', JSON.stringify(filteredEntries));
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

      new Notice(tr('✅ 已添加测试缓存项', '✅ Test cache entry added'), 3000);

      // 读取一次统计，确保写入后的缓存索引仍可解析。
      this.plugin.api.getCacheStats();
    } catch (error) {
      console.error('添加测试缓存数据失败:', error);
      new Notice(
        tr(
          `❌ 添加测试缓存数据失败: ${errorMessage(error)}`,
          `❌ Could not add test cache data: ${errorMessage(error)}`,
        ),
        5000,
      );
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
      summary: tr('完整总结', 'Full summary'),
      'transcript-only': tr('仅文稿', 'Transcript only'),
      'info-only': tr('仅视频信息', 'Video info only'),
    };
    return modeLabels[mode] || mode;
  }

  /**
   * 获取语言标签
   */
  private getLanguageLabel(language: string): string {
    const languageLabels: { [key: string]: string } = {
      zh: '中文',
      en: tr('英文', 'English'),
      ja: tr('日文', 'Japanese'),
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
      return tr('今天', 'Today');
    } else if (diffDays === 1) {
      return tr('昨天', 'Yesterday');
    } else if (diffDays < 7) {
      return tr(`${diffDays}天前`, `${diffDays} days ago`);
    } else {
      return date.toLocaleDateString();
    }
  }

  /**
   * 获取 localStorage 大小
   */
  private getLocalStorageSize(): number {
    let totalSize = 0;
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key && key.startsWith('video-summary-cache')) {
        const value = window.localStorage.getItem(key);
        if (value) {
          totalSize += value.length;
        }
      }
    }
    return totalSize;
  }
}

function isSupportedProtocolVideoUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return SUPPORTED_PLATFORMS.some((host) => hostname === host || hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

function isSupportedLocalMediaPath(value: string): boolean {
  return /\.(?:mp4|m4v|mov|mkv|webm|avi|mp3|m4a|wav|flac|aac|ogg|opus)$/i.test(value.trim());
}

function frontmatterScalarValue(content: string, key: string): string {
  const block = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (!block) return '';
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const raw = block.match(new RegExp(`^${escaped}:\\s*(.*?)\\s*$`, 'm'))?.[1] || '';
  return raw.trim().replace(/^['"]|['"]$/g, '');
}
