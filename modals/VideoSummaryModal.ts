import { App, Editor, MarkdownView, Modal, Notice, Setting } from 'obsidian';
import VideoSummaryPlugin from '../main';
import { ProcessingMode, SupportedLanguage } from '../types';
import { LANGUAGE_OPTIONS, processingModes, ERROR_MESSAGES } from '../constants';
import { NoteProcessor } from '../utils/NoteProcessor';
import { RetryUtils } from '../utils/RetryUtils';

import { errorMessage } from '../utils/errors';
import { tr } from '../utils/i18n';
export class VideoSummaryModal extends Modal {
  private plugin: VideoSummaryPlugin;
  private editor: Editor;
  private view: MarkdownView;
  private noteProcessor: NoteProcessor;

  private mode: ProcessingMode = 'summary';
  private language: SupportedLanguage = 'zh';
  private progressNotice: Notice | null = null;

  // UI输入字段
  private videoUrlInput: HTMLInputElement | null = null;
  private providedTranscriptInput: HTMLTextAreaElement | null = null;
  private localFileInput: HTMLInputElement | null = null;

  constructor(app: App, plugin: VideoSummaryPlugin, editor: Editor, view: MarkdownView) {
    super(app);
    this.plugin = plugin;
    this.editor = editor;
    this.view = view;
    this.noteProcessor = new NoteProcessor(app.vault);
  }

  onOpen() {
    this.modalEl.addClass('ap', 'ap-modal');
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: tr('📺 视频总结处理', '📺 Video Summary') });

    // 处理模式选择
    new Setting(contentEl)
      .setName(tr('处理模式', 'Mode'))
      .setDesc(tr('选择处理方式', 'How to process it'))
      .addDropdown((dropdown) => {
        processingModes().forEach((mode) => {
          dropdown.addOption(mode.value, mode.label);
        });
        dropdown.setValue(this.mode);
        dropdown.onChange((value) => {
          this.mode = value as ProcessingMode;
        });
      });

    // 语言选择（仅在完整总结模式下显示）
    const languageSetting = new Setting(contentEl)
      .setName(tr('输出语言', 'Output language'))
      .setDesc(tr('生成总结的语言', 'Language of the summary'))
      .addDropdown((dropdown) => {
        LANGUAGE_OPTIONS.forEach((lang) => {
          dropdown.addOption(lang.value, lang.label);
        });
        dropdown.setValue(this.language);
        dropdown.onChange((value) => {
          this.language = value as SupportedLanguage;
        });
      });

    // 根据模式显示/隐藏语言选择
    const updateLanguageVisibility = () => {
      languageSetting.settingEl.toggle(this.mode === 'summary');
    };
    updateLanguageVisibility();

    // 监听模式变化
    contentEl.addEventListener('change', (e) => {
      if ((e.target as HTMLSelectElement).name === 'mode') {
        updateLanguageVisibility();
      }
    });

    // 视频链接输入
    const videoUrlSetting = new Setting(contentEl)
      .setName(tr('视频链接', 'Video link'))
      .setDesc(
        tr(
          '输入视频链接（YouTube、哔哩哔哩、抖音、抖音国际版）',
          'A video link (YouTube, Bilibili, Douyin, TikTok)',
        ),
      );

    this.videoUrlInput = videoUrlSetting.controlEl.createEl('input');
    this.videoUrlInput.type = 'text';
    this.videoUrlInput.placeholder = tr(
      '视频链接，例如 YouTube 或哔哩哔哩',
      'Video link, for example YouTube or Bilibili',
    );

    // 提供的文稿输入
    const transcriptSetting = new Setting(contentEl)
      .setName(tr('提供的文稿', 'Transcript you provide'))
      .setDesc(tr('输入文稿内容（可选）', 'Transcript text (optional)'));

    this.providedTranscriptInput = transcriptSetting.controlEl.createEl('textarea');
    this.providedTranscriptInput.placeholder = tr(
      '在这里输入文稿内容...',
      'Type the transcript here...',
    );
    this.providedTranscriptInput.rows = 4;

    // 本地文件输入
    const localFileSetting = new Setting(contentEl)
      .setName(tr('本地文件', 'Local file'))
      .setDesc(
        tr(
          '自带的 n8n（docker 版）只接受 uploads 根目录里的文件名。',
          'The bundled n8n (Docker) accepts only file names directly inside its uploads folder.',
        ),
      );

    this.localFileInput = localFileSetting.controlEl.createEl('input');
    this.localFileInput.type = 'text';
    this.localFileInput.placeholder = 'lecture-01.mp4';

    // 显示当前文件信息
    const file = this.view.file;
    if (file) {
      const infoEl = contentEl.createDiv({ cls: 'video-summary-info' });
      infoEl.createEl('h3', { text: tr('当前文件信息', 'Current file') });
      infoEl.createEl('p', { text: tr(`文件名: ${file.basename}`, `File name: ${file.basename}`) });

      // 检查是否有视频内容
      void this.app.vault.read(file).then((content) => {
        const hasVideo = this.noteProcessor.hasVideoContent(content);
        const status = this.noteProcessor.getProcessingStatus(content);

        infoEl.createEl('p', {
          text: tr(
            `视频内容: ${hasVideo ? '✅ 已检测到' : '❌ 未检测到'}`,
            `Video content: ${hasVideo ? '✅ found' : '❌ not found'}`,
          ),
        });

        if (status) {
          infoEl.createEl('p', {
            text: tr(`处理状态: ${status}`, `Status: ${status}`),
          });
        }
      });
    }

    // 操作按钮
    const buttonContainer = contentEl.createDiv({ cls: 'video-summary-buttons' });

    // 开始处理按钮
    const processButton = buttonContainer.createEl('button', {
      text: tr('开始处理', 'Start'),
      cls: 'mod-cta',
    });
    processButton.addEventListener('click', () => {
      void this.processVideo();
    });

    // 取消按钮
    const cancelButton = buttonContainer.createEl('button', {
      text: tr('取消', 'Cancel'),
      cls: 'mod-warning',
    });
    cancelButton.addEventListener('click', () => {
      this.close();
    });

    // 添加样式
    contentEl.addClass('vs-modal', 'video-summary-modal');
  }

  async processVideo() {
    const file = this.view.file;
    if (!file) {
      new Notice(ERROR_MESSAGES.NO_FILE);
      return;
    }

    try {
      // 读取文件内容
      const content = await this.app.vault.read(file);

      // 构建视频输入（从文件内容）
      const videoInput = this.noteProcessor.buildVideoInput(content);

      // 从UI输入中获取内容并合并
      if (this.videoUrlInput && this.videoUrlInput.value.trim()) {
        videoInput.url = this.videoUrlInput.value.trim();
      }

      if (this.providedTranscriptInput && this.providedTranscriptInput.value.trim()) {
        videoInput.transcript = this.providedTranscriptInput.value.trim();
      }

      if (this.localFileInput && this.localFileInput.value.trim()) {
        videoInput.localFile = this.localFileInput.value.trim();
      }

      // 检查是否有任意一种输入（视频链接、提供的文稿或本地文件）
      if (!videoInput.url && !videoInput.transcript && !videoInput.localFile) {
        new Notice(ERROR_MESSAGES.NO_INPUT);
        return;
      }
      if (!(await this.plugin.ensureBackendReady())) return;

      // 设置处理状态
      await this.noteProcessor.setProcessingStatus(file, 'running');
      await this.plugin.jobService.updateCourseProgressForFile(file, 'processing', 10);

      // 显示进度通知
      const langText =
        this.language === 'zh'
          ? tr('中文', 'Chinese')
          : this.language === 'en'
            ? tr('英文', 'English')
            : tr('日文', 'Japanese');
      const noticeText = (() => {
        switch (this.mode) {
          case 'summary':
            return tr(
              `正在以${langText}生成总结，请稍候...`,
              `Summarising in ${langText}, please wait...`,
            );
          case 'transcript-only':
            return tr('正在提取文稿，请稍候...', 'Extracting the transcript, please wait...');
          default:
            return tr('正在获取视频信息，请稍候...', 'Getting video info, please wait...');
        }
      })();

      this.progressNotice = new Notice(noticeText, 0);

      // 使用重试机制处理
      const result = await RetryUtils.withSmartRetry(
        async () => {
          return await this.plugin.api.processVideo(
            file.basename,
            videoInput,
            this.mode,
            this.language,
            this.plugin.settings.enableCache !== false, // 根据设置决定是否使用缓存
          );
        },
        1, // 重试1次
        2000, // 2秒延迟
        (attempt, error) => {
          if (this.progressNotice) {
            this.progressNotice.setMessage(
              tr(
                `🔄 处理失败，第${attempt}次重试: ${errorMessage(error)}`,
                `🔄 Failed, retry ${attempt}: ${errorMessage(error)}`,
              ),
            );
          }
        },
      );

      const artifactContext = {
        title: file.basename,
        notePath: file.path,
        input: videoInput,
        platform: result.video_platform,
      };
      await this.plugin.jobService.persistExternalResult(artifactContext, result);

      // 更新笔记（按设置控制自动重命名）
      await this.noteProcessor.updateNote(file, result, this.mode, {
        autoRename: this.plugin.settings.autoRenameEnabled,
        conflictStrategy: this.plugin.settings.renameConflictStrategy,
      });
      await this.plugin.jobService.relinkExternalResult(artifactContext, result, file);
      // 设置成功状态（使用可配置值）
      await this.noteProcessor.setProcessingStatus(
        file,
        this.plugin.settings.successStatusValue ?? 'success',
      );
      await this.plugin.jobService.updateCourseProgressForFile(
        file,
        'complete',
        100,
        result.artifact?.artifact_id,
      );

      // 关闭进度通知
      if (this.progressNotice) {
        this.progressNotice.hide();
      }

      // 显示成功通知
      const successText = (() => {
        switch (this.mode) {
          case 'summary':
            return tr(`✅ 视频已${langText}总结！`, `✅ Summarised in ${langText}!`);
          case 'transcript-only':
            return tr('✅ 文稿提取完成！', '✅ Transcript extracted!');
          default:
            return tr('✅ 视频信息已获取！', '✅ Video info received!');
        }
      })();
      new Notice(successText, 5000);

      // 记录历史
      this.recordHistory(file.basename, 'success');

      // 关闭模态框
      this.close();
    } catch (error) {
      console.error('处理视频失败（包括重试）:', error);

      // 关闭进度通知
      if (this.progressNotice) {
        this.progressNotice.hide();
      }

      // 设置错误状态
      if (file) {
        await this.noteProcessor.setProcessingError(file, error);
        await this.plugin.jobService.updateCourseProgressForFile(file, 'error', 0);
      }

      // 显示错误通知
      new Notice(
        tr(
          `❌ 处理失败（已重试）: ${errorMessage(error)}`,
          `❌ Failed (after retries): ${errorMessage(error)}`,
        ),
        0,
      );

      // 记录历史
      this.recordHistory(file?.basename || 'unknown', 'error');
    }
  }

  private recordHistory(fileName: string, result: 'success' | 'error') {
    if (!this.plugin.settings.history) {
      this.plugin.settings.history = [];
    }

    this.plugin.settings.history.push({
      file: fileName,
      time: new Date().toLocaleString(),
      result,
      mode: this.mode,
      language: this.language,
    });

    // 限制历史记录数量
    if (this.plugin.settings.history.length > 200) {
      this.plugin.settings.history.shift();
    }

    void this.plugin.saveSettings();
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();

    // 关闭进度通知
    if (this.progressNotice) {
      this.progressNotice.hide();
    }
  }
}
