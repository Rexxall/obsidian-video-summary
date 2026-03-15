import { App, Editor, MarkdownView, Modal, Notice, Setting } from 'obsidian';
import VideoSummaryPlugin from '../main';
import { ProcessingMode, SupportedLanguage, VideoInput } from '../types';
import { LANGUAGE_OPTIONS, PROCESSING_MODES, ERROR_MESSAGES } from '../constants';
import { NoteProcessor } from '../utils/NoteProcessor';
import { RetryUtils } from '../utils/RetryUtils';

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
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl('h2', { text: '📺 视频总结处理' });

		// 处理模式选择
		new Setting(contentEl)
			.setName('处理模式')
			.setDesc('选择处理方式')
			.addDropdown(dropdown => {
				PROCESSING_MODES.forEach(mode => {
					dropdown.addOption(mode.value, mode.label);
				});
				dropdown.setValue(this.mode);
				dropdown.onChange(value => {
					this.mode = value as ProcessingMode;
				});
			});

		// 语言选择（仅在完整总结模式下显示）
		const languageSetting = new Setting(contentEl)
			.setName('输出语言')
			.setDesc('生成总结的语言')
			.addDropdown(dropdown => {
				LANGUAGE_OPTIONS.forEach(lang => {
					dropdown.addOption(lang.value, lang.label);
				});
				dropdown.setValue(this.language);
				dropdown.onChange(value => {
					this.language = value as SupportedLanguage;
				});
			});

		// 根据模式显示/隐藏语言选择
		const updateLanguageVisibility = () => {
			if (this.mode === 'summary') {
				languageSetting.settingEl.style.display = 'block';
			} else {
				languageSetting.settingEl.style.display = 'none';
			}
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
			.setName('视频链接')
			.setDesc('输入视频链接 (YouTube/Bilibili/抖音/TikTok)');
		
		this.videoUrlInput = videoUrlSetting.controlEl.createEl('input');
		this.videoUrlInput.type = 'text';
		this.videoUrlInput.placeholder = 'https://...';

		// 提供的文稿输入
		const transcriptSetting = new Setting(contentEl)
			.setName('提供的文稿')
			.setDesc('输入文稿内容（可选）');
		
		this.providedTranscriptInput = transcriptSetting.controlEl.createEl('textarea');
		this.providedTranscriptInput.placeholder = '在这里输入文稿内容...';
		this.providedTranscriptInput.rows = 4;

		// 本地文件输入
		const localFileSetting = new Setting(contentEl)
			.setName('本地文件')
			.setDesc('输入本地视频文件路径（可选）');
		
		this.localFileInput = localFileSetting.controlEl.createEl('input');
		this.localFileInput.type = 'text';
		this.localFileInput.placeholder = '/path/to/video.mp4';

		// 显示当前文件信息
		const file = this.view.file;
		if (file) {
			const infoEl = contentEl.createEl('div', { cls: 'video-summary-info' });
			infoEl.createEl('h3', { text: '当前文件信息' });
			infoEl.createEl('p', { text: `文件名: ${file.basename}` });
			
			// 检查是否有视频内容
			this.app.vault.read(file).then(content => {
				const hasVideo = this.noteProcessor.hasVideoContent(content);
				const status = this.noteProcessor.getProcessingStatus(content);
				
				infoEl.createEl('p', { 
					text: `视频内容: ${hasVideo ? '✅ 已检测到' : '❌ 未检测到'}` 
				});
				
				if (status) {
					infoEl.createEl('p', { 
						text: `处理状态: ${status}` 
					});
				}
			});
		}

		// 操作按钮
		const buttonContainer = contentEl.createEl('div', { cls: 'video-summary-buttons' });

		// 开始处理按钮
		const processButton = buttonContainer.createEl('button', {
			text: '开始处理',
			cls: 'mod-cta'
		});
		processButton.addEventListener('click', () => {
			this.processVideo();
		});

		// 取消按钮
		const cancelButton = buttonContainer.createEl('button', {
			text: '取消',
			cls: 'mod-warning'
		});
		cancelButton.addEventListener('click', () => {
			this.close();
		});

		// 添加样式
		contentEl.addClass('video-summary-modal');
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
				console.log('UI输入 - 视频链接:', videoInput.url);
			}
			
			if (this.providedTranscriptInput && this.providedTranscriptInput.value.trim()) {
				videoInput.transcript = this.providedTranscriptInput.value.trim();
				console.log('UI输入 - 提供文稿:', videoInput.transcript.substring(0, 50) + '...');
			}
			
			if (this.localFileInput && this.localFileInput.value.trim()) {
				videoInput.localFile = this.localFileInput.value.trim();
				console.log('UI输入 - 本地文件:', videoInput.localFile);
			}
			
			console.log('最终VideoInput:', videoInput);
			
			// 检查是否有任意一种输入（视频链接、提供的文稿或本地文件）
			if (!videoInput.url && !videoInput.transcript && !videoInput.localFile) {
				console.log('没有找到任何输入');
				new Notice(ERROR_MESSAGES.NO_INPUT);
				return;
			}

			// 设置处理状态
			await this.noteProcessor.setProcessingStatus(file, 'running');

			// 显示进度通知
			const langText = this.language === 'zh' ? '中文' : this.language === 'en' ? '英文' : '日文';
			const noticeText = (() => {
				switch (this.mode) {
					case 'summary':
						return `正在以${langText}生成总结，请稍候...`;
					case 'transcript-only':
						return '正在提取文稿，请稍候...';
					default:
						return '正在获取视频信息，请稍候...';
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
						this.plugin.settings.enableCache !== false // 根据设置决定是否使用缓存
					);
				},
				1, // 重试1次
				2000, // 2秒延迟
				(attempt, error) => {
					if (this.progressNotice) {
						this.progressNotice.setMessage(`🔄 处理失败，第${attempt}次重试: ${error.message}`);
					}
				}
			);

            // 更新笔记（按设置控制自动重命名）
            await this.noteProcessor.updateNote(file, result, this.mode, { autoRename: this.plugin.settings.autoRenameEnabled, conflictStrategy: this.plugin.settings.renameConflictStrategy });
            // 设置成功状态（使用可配置值）
            await this.noteProcessor.setProcessingStatus(file, this.plugin.settings.successStatusValue ?? 'success');

			// 关闭进度通知
			if (this.progressNotice) {
				this.progressNotice.hide();
			}

			// 显示成功通知
			const successText = (() => {
				switch (this.mode) {
					case 'summary':
						return `✅ 视频已${langText}总结！`;
					case 'transcript-only':
						return '✅ 文稿提取完成！';
					default:
						return '✅ 视频信息已获取！';
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
				await this.noteProcessor.setProcessingStatus(file, 'error');
			}

			// 显示错误通知
			new Notice(`❌ 处理失败（已重试）: ${error.message}`, 0);
			
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
			language: this.language
		});

		// 限制历史记录数量
		if (this.plugin.settings.history.length > 200) {
			this.plugin.settings.history.shift();
		}

		this.plugin.saveSettings();
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