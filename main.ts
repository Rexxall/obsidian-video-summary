import { App, Editor, MarkdownView, Notice, Plugin, PluginSettingTab, Setting, TFile, WorkspaceLeaf, DropdownComponent } from 'obsidian';
import { VideoSummaryModal } from './modals';
import { BatchProcessingModal } from './BatchProcessingModal';
import { VideoSummarySettings, ProcessingMode, WebhookProfile } from './types';
import { DEFAULT_SETTINGS } from './constants';
import { VideoSummaryAPI } from './api/VideoSummaryAPI';
import { VideoSummaryView, VIDEO_SUMMARY_VIEW_TYPE } from './views/VideoSummaryView';
import { ConfirmModal } from './modals';
import { VideoUtils } from './utils/VideoUtils';
import { FileProcessor } from './utils/FileProcessor';
import { RetryUtils } from './utils/RetryUtils';
import { NoteProcessor } from './utils/NoteProcessor';
import { Modal } from 'obsidian';

export default class VideoSummaryPlugin extends Plugin {
	settings: VideoSummarySettings;
	api: VideoSummaryAPI;
	fileProcessor: FileProcessor;
	noteProcessor: NoteProcessor;

	async onload() {
		console.log('加载视频总结插件');

		// 加载设置
		await this.loadSettings();

		// 初始化API
		this.initializeApiInstance();

		// 初始化文件与笔记处理器
		this.fileProcessor = new FileProcessor(this.app, this);
		this.noteProcessor = new NoteProcessor(this.app.vault);

		// 注册视图类型
		this.registerView(
			VIDEO_SUMMARY_VIEW_TYPE,
			(leaf: WorkspaceLeaf) => new VideoSummaryView(leaf, this)
		);

		// 注册命令
		this.addCommands();

		// 注册右键菜单
		this.registerContextMenu();

		// 注册设置页面
		this.addSettingTab(new VideoSummarySettingTab(this.app, this));

		// 注册文件修改事件监听器
		this.registerEvent(
			this.app.vault.on('modify', (file) => {
				if (file instanceof TFile && file.extension === 'md') {
					// 延迟刷新，避免频繁更新
					setTimeout(() => {
						this.refreshVideoSummaryView();
					}, 500);
				}
			})
		);

		console.log('Video Summary Plugin loaded');
	}

	onunload() {
		console.log('Video Summary Plugin unloaded');
	}

	private addCommands() {
		// 主要命令：快速总结当前笔记
		this.addCommand({
			id: 'video-summary-quick',
			name: '📺 快速总结当前笔记',
			editorCallback: (editor: Editor, view: MarkdownView) => {
				this.quickProcessCurrentNote(editor, view, 'summary');
			}
		});

		// 新增命令：将全文作为文稿总结
		this.addCommand({
			id: 'video-summary-full-text',
			name: '📺 将当前笔记全文作为文稿总结',
			editorCallback: (editor: Editor, view: MarkdownView) => {
				this.processFullTextAsTranscript(editor, view);
			}
		});

		// 快速提取文稿
		this.addCommand({
			id: 'video-transcript-quick',
			name: '📝 快速提取文稿',
			editorCallback: (editor: Editor, view: MarkdownView) => {
				this.quickProcessCurrentNote(editor, view, 'transcript-only');
			}
		});

		// 只更新视频信息
		this.addCommand({
			id: 'video-info-update',
			name: 'ℹ️ 更新视频信息（不改正文）',
			editorCallback: (editor: Editor, view: MarkdownView) => {
				this.updateVideoInfoOnly(editor, view, false);
			}
		});

		// 更新视频信息并重命名
		this.addCommand({
			id: 'video-info-update-rename',
			name: 'ℹ️ 更新视频信息并重命名',
			editorCallback: (editor: Editor, view: MarkdownView) => {
				this.updateVideoInfoOnly(editor, view, true);
			}
		});

		// 打开视频总结管理视图
		this.addCommand({
			id: 'video-summary-view',
			name: '📋 视频总结管理',
			callback: () => {
				this.activateView();
			}
		});

		// 批量处理命令
		this.addCommand({
			id: 'video-summary-batch',
			name: '🔄 批量处理视频',
			callback: () => {
				new BatchProcessingModal(this.app, this).open();
			}
		});

		// 重新处理当前笔记
		this.addCommand({
			id: 'video-summary-reprocess',
			name: '🔄 重新处理当前笔记',
			editorCallback: (editor: Editor, view: MarkdownView) => {
				this.reprocessCurrentNote(editor, view);
			}
		});

		// 处理所有待处理视频
		this.addCommand({
			id: 'video-summary-process-all-pending',
			name: '⚡ 处理所有待处理视频',
			callback: () => {
				this.processAllPendingVideos();
			}
		});

		// 测试n8n连接
		this.addCommand({
			id: 'video-summary-test-connection',
			name: '🔗 测试n8n连接',
			callback: () => {
				this.testN8nConnection();
			}
		});

		// 标记为非视频笔记
		this.addCommand({
			id: 'video-summary-mark-excluded',
			name: '⛔️ 标记为非视频笔记',
			editorCallback: (editor: Editor, view: MarkdownView) => {
				this.markAsExcluded(editor, view);
			}
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
			})
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
			new Notice(`处理当前笔记失败: ${error.message}`);
		}
	}

	private async processCurrentNoteWithMode(editor: Editor, view: MarkdownView, mode: ProcessingMode) {
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
			new Notice(`处理当前笔记失败: ${error.message}`);
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

			await this.noteProcessor.setProcessingStatus(file, 'running');

			const statusNotice = new Notice('正在获取视频信息...', 0);

			try {
				const result = await this.api.processVideo(
					file.basename,
					videoInput,
					'info-only',
					this.settings.defaultLanguage,
					this.settings.enableCache !== false
				);

				await this.noteProcessor.updateNote(file, result, 'info-only', {
					autoRename: forceRename,
					conflictStrategy: this.settings.renameConflictStrategy
				});

				await this.noteProcessor.setProcessingStatus(file, this.settings.successStatusValue ?? 'success');
				this.addToHistory(file.basename, 'success', 'info-only');

				statusNotice.setMessage('✅ 视频信息已更新');
				setTimeout(() => statusNotice.hide(), 2000);
			} catch (error) {
				await this.noteProcessor.setProcessingStatus(file, 'error');
				this.addToHistory(file.basename, 'error', 'info-only');
				statusNotice.setMessage(`❌ 更新失败: ${error.message}`);
				setTimeout(() => statusNotice.hide(), 3000);
			}
		} catch (error) {
			new Notice(`更新视频信息失败: ${error.message}`);
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
			new Notice(`重新处理失败: ${error.message}`);
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

			// 获取预设配置
			const requestLanguage =
				mode === 'summary'
					? this.settings.quickSummaryOptions.language
					: mode === 'transcript-only'
						? this.settings.quickTranscriptOptions.language
						: this.settings.defaultLanguage;

			// 显示处理状态
			let statusNotice = new Notice(`正在处理: ${this.getModeDisplayText(mode)}`, 0);

			// 检查是否为多文件合并场景 (localFileName 包含逗号)
			let isMerge = false;
			let localFiles: string[] = [];

			if (localFileName && localFileName.includes(',')) {
				localFiles = localFileName.split(',').map(f => f.trim()).filter(f => f);
				if (localFiles.length > 1) {
					isMerge = true;
				}
			}

			try {
				let result: any;

				// ===== 多文件合并逻辑 =====
				if (isMerge) {
					const langText = requestLanguage === 'zh' ? '中文' : requestLanguage === 'en' ? '英文' : '日文';
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
							false // 不使用缓存
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
						url: url
					};

					// 调用主处理流程（重试逻辑）
					result = await RetryUtils.withSmartRetry(
						async () => {
							return await this.api.processVideo(
								file.basename,
								mergedInput,
								mode,
								requestLanguage,
								this.settings.enableCache !== false
							);
						},
						1, 2000,
						(attempt, error) => { statusNotice.setMessage(`重试中: ${error.message}`); }
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
								this.settings.enableCache !== false // 根据设置决定是否使用缓存
							);
						},
						1, // 重试1次
						2000, // 2秒延迟
						(attempt, error) => {
							statusNotice.setMessage(`重试中 (${attempt}/2): ${error.message}`);
						}
					);
				}

				// ===== 处理结果 =====

				// 更新笔记内容（按设置控制自动重命名）
				await this.noteProcessor.updateNote(file, result, mode, { autoRename: this.settings.autoRenameEnabled, conflictStrategy: this.settings.renameConflictStrategy });

				// 更新状态（使用可配置的成功状态值）
				await this.noteProcessor.setProcessingStatus(file, this.settings.successStatusValue ?? 'success');

				// 添加到历史记录
				this.addToHistory(file.basename, 'success', mode);

				statusNotice.setMessage(`✅ 处理完成`);
				setTimeout(() => statusNotice.hide(), 2000);

			} catch (error) {
				// 更新状态为错误
				await this.noteProcessor.setProcessingStatus(file, 'error');

				// 添加到历史记录
				this.addToHistory(file.basename, 'error', mode);

				statusNotice.setMessage(`❌ 处理失败: ${error.message}`);
				setTimeout(() => statusNotice.hide(), 3000);
			}
		} catch (error) {
			new Notice(`处理失败: ${error.message}`);
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
			const requestLanguage = this.settings.quickSummaryOptions?.language || this.settings.defaultLanguage;
			const mode = 'summary';

			// 设置处理中状态
			await this.noteProcessor.setProcessingStatus(file, 'running');
			let statusNotice = new Notice(`正在将全文发送处理...`, 0);

			try {
				const input: any = {
					transcript: fullText
				};

				// 使用重试机制调用API处理全文文本
				const result = await RetryUtils.withSmartRetry(
					async () => {
						return await this.api.processVideo(
							file.basename,
							input,
							mode,
							requestLanguage,
							this.settings.enableCache !== false
						);
					},
					1, // 重试1次
					2000, // 2秒延迟
					(attempt, error) => {
						statusNotice.setMessage(`重试中 (${attempt}/2): ${error.message}`);
					}
				);

				// 更新笔记内容，强制开启 autoRename 以便此模式下总是应用由 n8n 生成的好的标题
				await this.noteProcessor.updateNote(file, result, mode, { autoRename: true, conflictStrategy: this.settings.renameConflictStrategy });
				await this.noteProcessor.setProcessingStatus(file, this.settings.successStatusValue ?? 'success');
				this.addToHistory(file.basename, 'success', mode);

				statusNotice.setMessage(`✅ 全文处理完成`);
				setTimeout(() => statusNotice.hide(), 2000);
			} catch (error) {
				await this.noteProcessor.setProcessingStatus(file, 'error');
				this.addToHistory(file.basename, 'error', mode);
				statusNotice.setMessage(`❌ 处理失败: ${error.message}`);
				setTimeout(() => statusNotice.hide(), 5000);
			}
		} catch (error) {
			new Notice(`处理启动失败: ${error.message}`);
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
				`是否要批量处理这些视频？\n\n文件列表：\n${pendingFiles.slice(0, 10).map(f => `• ${f.basename}`).join('\n')}${pendingFiles.length > 10 ? `\n... 还有 ${pendingFiles.length - 10} 个文件` : ''}`
			);

			if (!confirmed) {
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

					// 处理文件
					await this.processFileWithMode(file, this.settings.defaultMode);
					successCount++;

					// 添加成功记录到历史
					this.addToHistory(file.basename, 'success', this.settings.defaultMode as string);

				} catch (error) {
					errorCount++;
					console.error(`处理文件失败: ${file.basename}`, error);

					// 添加失败记录到历史
					this.addToHistory(file.basename, 'error', this.settings.defaultMode as string);
				}

				// 添加延迟避免API限制
				if (i < pendingFiles.length - 1) {
					await new Promise(resolve => setTimeout(resolve, 1000));
				}
			}

			// 保存历史记录
			await this.saveSettings();

			// 显示最终结果
			progressNotice.setMessage(`完成！成功: ${successCount}, 失败: ${errorCount}`);
			setTimeout(() => progressNotice.hide(), 3000);

		} catch (error) {
			new Notice(`批量处理失败: ${error.message}`);
		}
	}

	private async showConfirmDialog(title: string, message: string): Promise<boolean> {
		return new Promise((resolve) => {
			const modal = new ConfirmModal(this.app, title, message, resolve);
			modal.open();
		});
	}

	private addToHistory(fileName: string, result: 'success' | 'error', mode: string) {
		if (!this.settings.history) {
			this.settings.history = [];
		}

		// 添加新记录
		this.settings.history.push({
			file: fileName,
			result: result,
			mode: mode as any,
			time: new Date().toLocaleString('zh-CN')
		});

	}

	private async clearProcessingHistory() {
		try {
			this.settings.history = [];
			await this.saveSettings();
			new Notice('处理历史已清理');
		} catch (error) {
			new Notice(`清理历史失败: ${error.message}`);
		}
	}

	private async testN8nConnection() {
		try {
			const result = await this.api.testConnection();

			if (result.success) {
				new Notice('✅ 连接成功');
			} else {
				new Notice(`❌ 连接失败: ${result.error}`);
			}
		} catch (error) {
			new Notice(`连接失败: ${error.message}`);
		}
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

		if (!Array.isArray(this.settings.webhookProfiles) || this.settings.webhookProfiles.length === 0) {
			this.settings.webhookProfiles = [
				{
					id: 'default-webhook',
					name: '默认 Webhook',
					url: this.settings.n8nWebhookUrl || DEFAULT_SETTINGS.n8nWebhookUrl
				}
			];
			shouldSave = true;
		}

		if (!this.settings.activeWebhookId) {
			this.settings.activeWebhookId = this.settings.webhookProfiles[0].id;
			shouldSave = true;
		}

		const activeProfile = this.settings.webhookProfiles.find(p => p.id === this.settings.activeWebhookId) || this.settings.webhookProfiles[0];
		if (this.settings.n8nWebhookUrl !== activeProfile.url) {
			this.settings.n8nWebhookUrl = activeProfile.url;
			shouldSave = true;
		}

		if (shouldSave) {
			await this.saveSettings();
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	private initializeApiInstance(url?: string) {
		const targetUrl = url ?? this.settings?.n8nWebhookUrl ?? DEFAULT_SETTINGS.n8nWebhookUrl;
		this.api = new VideoSummaryAPI(targetUrl, this.app.vault, '.obsidian/plugins/video-summary-plugin/data', this.settings.payloadKeys);
		this.api.setWebhookHistory(this.settings.webhookHistory || []);
		this.api.setAiModel(this.settings.aiModel);
		this.api.onWebhookHistoryChange(async (history) => {
			this.settings.webhookHistory = history;
			await this.saveSettings();
		});
		this.api.setDebug(this.settings.enableDebugMode);

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

	async setActiveWebhook(profileId: string, options: { silent?: boolean } = {}): Promise<WebhookProfile | null> {
		const profile = this.settings.webhookProfiles.find(p => p.id === profileId);
		if (!profile) {
			new Notice('未找到对应的 Webhook 配置');
			return null;
		}

		this.settings.activeWebhookId = profileId;
		this.settings.n8nWebhookUrl = profile.url;
		this.initializeApiInstance(profile.url);
		await this.saveSettings();

		if (!options.silent) {
			new Notice(`已切换到 ${profile.name || profile.url}`);
		}

		return profile;
	}

	getActiveWebhookProfile(): WebhookProfile | undefined {
		return this.settings.webhookProfiles.find(p => p.id === this.settings.activeWebhookId);
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

	private async processFileWithMode(file: TFile, mode: ProcessingMode) {
		try {
			const content = await this.app.vault.read(file);

			// 提取所有可能的输入数据
			const url = this.extractVideoUrl(content);
			const providedTranscript = this.extractProvidedTranscript(content);
			const localFileName = this.extractLocalFileName(content);

			// 检查是否有任何输入数据
			if (!url && !providedTranscript && !localFileName) {
				throw new Error('笔记中没有找到视频链接、文稿内容或本地文件名');
			}

			// 更新状态为处理中
			await this.noteProcessor.setProcessingStatus(file, 'running');

			// 构建输入数据
			const input: any = {};
			if (url) input.url = url;
			if (providedTranscript) input.transcript = providedTranscript;
			if (localFileName) input.localFile = localFileName;

			// 调用API处理
			const result = await this.api.processVideo(
				file.basename,
				input,
				mode,
				this.settings.defaultLanguage,
				this.settings.enableCache !== false // 根据设置决定是否使用缓存
			);

			// 更新文件内容（按设置控制自动重命名）
			await this.noteProcessor.updateNote(file, result, mode, { autoRename: this.settings.autoRenameEnabled, conflictStrategy: this.settings.renameConflictStrategy });

			// 更新状态为成功（使用可配置值）并记录历史
			await this.noteProcessor.setProcessingStatus(file, this.settings.successStatusValue ?? 'success');
			this.addToHistory(file.basename, 'success', mode);

			new Notice(`✅ ${this.getModeDisplayText(mode)}完成`);
		} catch (error) {
			// 更新状态为错误
			await this.noteProcessor.setProcessingStatus(file, 'error');

			// 添加到历史记录
			this.addToHistory(file.basename, 'error', mode);

			new Notice(`❌ 处理失败: ${error.message}`);
		}
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

	private refreshVideoSummaryView(): void {
		// 查找所有视频总结视图并刷新
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view.getViewType() === 'video-summary-view') {
				const view = leaf.view as any;
				if (view.refreshView) {
					view.refreshView();
				}
			}
		});
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

		// 主标题
		containerEl.createEl('h2', { text: '📺 视频总结插件设置' });

		// 渲染标签页切换按钮
		this.renderTabs(containerEl);

		const tabContent = containerEl.createDiv({ cls: 'tab-content-container' });

		// 根据当前选中的标签渲染内容
		switch (this.activeTab) {
			case 'general':
				this.createBasicSection(tabContent);
				break;
			case 'workflow':
				this.createApiSection(tabContent);
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

	private renderTabs(containerEl: HTMLElement) {
		const tabsContainer = containerEl.createDiv({ cls: 'settings-tabs-bar' });
		
		const tabs: { id: typeof this.activeTab, label: string, icon: string }[] = [
			{ id: 'general', label: '通用', icon: 'settings' },
			{ id: 'workflow', label: '工作流', icon: 'link' },
			{ id: 'core', label: '核心功能', icon: 'zap' },
			{ id: 'advanced', label: '高级', icon: 'wrench' }
		];

		tabs.forEach(tab => {
			const tabBtn = tabsContainer.createDiv({ 
				cls: `settings-tab-btn ${this.activeTab === tab.id ? 'is-active' : ''}` 
			});
			// 可以选择添加图标，根据 Obsidian 的 setIcon API
			// setIcon(tabBtn, tab.icon); 
			tabBtn.createSpan({ text: tab.label });
			
			tabBtn.onclick = () => {
				this.activeTab = tab.id;
				this.display();
			};
		});
	}

	private createApiSection(containerEl: HTMLElement) {
		const section = containerEl.createEl('div', { cls: 'setting-section' });
		section.createEl('h3', { text: '🔗 API 配置' });

		const webhookSetting = new Setting(section)
			.setName('默认 n8n Webhook')
			.setDesc('为不同工作流保存多个 Webhook，并选择当前使用的默认项。');

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
			this.plugin.settings.webhookProfiles.forEach(profile => {
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

		webhookSetting.addButton(button => button
			.setButtonText('测试连接')
			.onClick(async () => {
				const res = await this.plugin.api.testConnection();
				if (res.success) {
					new Notice(`✅ 连接成功（${res.durationMs}ms）`, 3000);
				} else {
					const details = [res.status ? `HTTP ${res.status}` : '', res.error || ''].filter(Boolean).join(' - ');
					new Notice(`❌ 连接失败: ${details}${res.bodySnippet ? `\n片段: ${res.bodySnippet}` : ''}`, 6000);
				}
			}));

		const profilesContainer = section.createEl('div', { cls: 'webhook-profiles-container' });

		const renderProfiles = () => {
			profilesContainer.empty();

			if (this.plugin.settings.webhookProfiles.length === 0) {
				profilesContainer.createEl('p', { text: '尚未配置任何 Webhook。', cls: 'setting-item-description' });
				return;
			}

			this.plugin.settings.webhookProfiles.forEach(profile => {
				const row = profilesContainer.createDiv({ cls: 'webhook-profile-row' });

				const nameInput = row.createEl('input', {
					type: 'text',
					value: profile.name || '',
					cls: 'webhook-name-input',
					attr: { placeholder: 'Webhook 名称' }
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
					attr: { placeholder: 'https://your-n8n/webhook/...' }
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
					cls: 'action-btn secondary webhook-default-btn'
				});
				defaultBtn.onclick = async () => {
					await this.plugin.setActiveWebhook(profile.id);
					refreshDropdownOptions();
					renderProfiles();
				};

				const deleteBtn = actions.createEl('button', {
					text: '删除',
					cls: 'btn-text-only webhook-delete-btn'
				});
				deleteBtn.onclick = async () => {
					if (this.plugin.settings.webhookProfiles.length <= 1) {
						new Notice('至少需要保留一个 Webhook');
						return;
					}

					this.plugin.settings.webhookProfiles = this.plugin.settings.webhookProfiles.filter(p => p.id !== profile.id);

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

		new Setting(section)
			.addButton(button => button
				.setButtonText('添加 Webhook')
				.setCta()
				.onClick(async () => {
					const newProfile: WebhookProfile = {
						id: `webhook-${Date.now()}`,
						name: `Webhook ${this.plugin.settings.webhookProfiles.length + 1}`,
						url: ''
					};
					this.plugin.settings.webhookProfiles.push(newProfile);
					await this.plugin.saveSettings();
					refreshDropdownOptions();
					renderProfiles();
				}));
	}

	private createBasicSection(containerEl: HTMLElement) {
		const section = containerEl.createEl('div', { cls: 'setting-section' });
		section.createEl('h3', { text: '⚙️ 基础配置' });

		// 默认语言设置
		new Setting(section)
			.setName('默认语言')
			.setDesc('生成总结的默认语言')
			.addDropdown(dropdown => dropdown
				.addOption('zh', '中文')
				.addOption('en', '英文')
				.addOption('ja', '日文')
				.setValue(this.plugin.settings.defaultLanguage)
				.onChange(async (value) => {
					this.plugin.settings.defaultLanguage = value as 'zh' | 'en' | 'ja';
					await this.plugin.saveSettings();
				}));

		const aiSection = section.createEl('div', { cls: 'setting-section' });
		aiSection.createEl('h4', { text: '自定义 AI 模型', cls: 'setting-item-name' });
		aiSection.createEl('p', { text: '添加你要在 n8n 中使用的模型名称（需与 n8n Switch 节点的值完全一致）。', cls: 'setting-item-description' });

		const aiModelsContainer = aiSection.createEl('div', { cls: 'webhook-profiles-container' });

		let aiDropdown: DropdownComponent | null = null;

		const refreshAiDropdownOptions = () => {
			if (!aiDropdown) return;
			aiDropdown.selectEl.empty();
			this.plugin.settings.customAiModels.forEach(model => {
				const option = document.createElement('option');
				option.value = model;
				option.textContent = model;
				aiDropdown!.selectEl.appendChild(option);
			});
			if (this.plugin.settings.aiModel) {
				try {
					aiDropdown.setValue(this.plugin.settings.aiModel);
				} catch { } // ignore
			}
		};

		const renderAiModels = () => {
			aiModelsContainer.empty();

			if (this.plugin.settings.customAiModels.length === 0) {
				aiModelsContainer.createEl('p', { text: '尚未配置任何自定义 AI 模型。', cls: 'setting-item-description' });
				return;
			}

			this.plugin.settings.customAiModels.forEach((model, index) => {
				const row = aiModelsContainer.createDiv({ cls: 'webhook-profile-row' });

				const nameInput = row.createEl('input', {
					type: 'text',
					value: model,
					cls: 'webhook-name-input',
					attr: { placeholder: '模型名称 (如 Gemini Pro)' }
				});

				nameInput.oninput = async () => {
					this.plugin.settings.customAiModels[index] = nameInput.value;
					await this.plugin.saveSettings();
					refreshAiDropdownOptions();
				};

				const actions = row.createDiv({ cls: 'webhook-profile-actions' });

				const deleteBtn = actions.createEl('button', {
					text: '删除',
					cls: 'btn-text-only webhook-delete-btn'
				});
				deleteBtn.onclick = async () => {
					if (this.plugin.settings.customAiModels.length <= 1) {
						new Notice('至少需要保留一个 AI 模型');
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

		new Setting(aiSection)
			.addButton(button => button
				.setButtonText('添加新模型')
				.onClick(async () => {
					this.plugin.settings.customAiModels.push('新模型');
					await this.plugin.saveSettings();
					refreshAiDropdownOptions();
					renderAiModels();
				}));

		// 默认 AI 模型设置
		new Setting(section)
			.setName('默认 AI 模型')
			.setDesc('在 n8n 中使用的默认 AI 模型')
			.addDropdown(dropdown => {
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
			.addSlider(slider => slider
				.setLimits(1, 30, 1)
				.setValue(this.plugin.settings.timeoutMinutes)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.timeoutMinutes = value;
					this.plugin.reinitializeApi();
					await this.plugin.saveSettings();
				}));

		// 自动保存设置
		new Setting(section)
			.setName('自动保存')
			.setDesc('处理完成后自动保存文件')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoSave)
				.onChange(async (value) => {
					this.plugin.settings.autoSave = value;
					await this.plugin.saveSettings();
				}));

		// 输出文件夹设置
		new Setting(section)
			.setName('输出文件夹')
			.setDesc('新建视频笔记的默认保存位置（留空则使用当前文件所在文件夹）')
			.addText(text => text
				.setPlaceholder('例如: Videos/2024')
				.setValue(this.plugin.settings.outputFolder)
				.onChange(async (value) => {
					this.plugin.settings.outputFolder = value;
					await this.plugin.saveSettings();
				}));
	}

	private createQuickProcessingSection(containerEl: HTMLElement) {
		const section = containerEl.createEl('div', { cls: 'setting-section' });
		section.createEl('h3', { text: '⚡ 一键处理配置' });

		// 一键总结配置
		const summarySubsection = section.createEl('div', { cls: 'setting-subsection' });
		summarySubsection.createEl('h4', { text: '一键总结配置' });

		new Setting(summarySubsection)
			.setName('总结语言')
			.setDesc('一键总结时使用的语言')
			.addDropdown(dropdown => dropdown
				.addOption('zh', '中文')
				.addOption('en', '英文')
				.addOption('ja', '日文')
				.setValue(this.plugin.settings.quickSummaryOptions.language)
				.onChange(async (value) => {
					this.plugin.settings.quickSummaryOptions.language = value as 'zh' | 'en' | 'ja';
					await this.plugin.saveSettings();
				}));

		new Setting(summarySubsection)
			.setName('总结超时时间')
			.setDesc('一键总结的超时时间（分钟）')
			.addSlider(slider => slider
				.setLimits(1, 30, 1)
				.setValue(this.plugin.settings.quickSummaryOptions.timeoutMinutes)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.quickSummaryOptions.timeoutMinutes = value;
					await this.plugin.saveSettings();
				}));

		// 一键提取文稿配置
		const transcriptSubsection = section.createEl('div', { cls: 'setting-subsection' });
		transcriptSubsection.createEl('h4', { text: '一键提取文稿配置' });

		new Setting(transcriptSubsection)
			.setName('文稿语言')
			.setDesc('一键提取文稿时使用的语言')
			.addDropdown(dropdown => dropdown
				.addOption('zh', '中文')
				.addOption('en', '英文')
				.addOption('ja', '日文')
				.setValue(this.plugin.settings.quickTranscriptOptions.language)
				.onChange(async (value) => {
					this.plugin.settings.quickTranscriptOptions.language = value as 'zh' | 'en' | 'ja';
					await this.plugin.saveSettings();
				}));

		new Setting(transcriptSubsection)
			.setName('文稿超时时间')
			.setDesc('一键提取文稿的超时时间（分钟）')
			.addSlider(slider => slider
				.setLimits(1, 30, 1)
				.setValue(this.plugin.settings.quickTranscriptOptions.timeoutMinutes)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.quickTranscriptOptions.timeoutMinutes = value;
					await this.plugin.saveSettings();
				}));
	}

	private createFileProcessingSection(containerEl: HTMLElement) {
		const section = containerEl.createEl('div', { cls: 'setting-section' });
		section.createEl('h3', { text: '📁 文件处理配置' });

		// 自动重命名开关
		new Setting(section)
			.setName('处理后自动重命名')
			.setDesc('根据视频标题/正文标题自动重命名笔记，避免重复名将追加编号')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoRenameEnabled)
				.onChange(async (value) => {
					this.plugin.settings.autoRenameEnabled = value;
					await this.plugin.saveSettings();
				}));

		// 重命名冲突策略
		new Setting(section)
			.setName('重命名冲突策略')
			.setDesc('当目标文件名已存在时的处理方式')
			.addDropdown(drop => drop
				.addOption('append-number', '追加编号')
				.addOption('append-date', '追加日期')
				.addOption('skip', '跳过')
				.setValue(this.plugin.settings.renameConflictStrategy)
				.onChange(async (v) => {
					this.plugin.settings.renameConflictStrategy = v as any;
					await this.plugin.saveSettings();
				}));

		// 批量处理设置
		new Setting(section)
			.setName('批量处理并发数')
			.setDesc('同时处理的最大文件数量')
			.addSlider(slider => slider
				.setLimits(1, 10, 1)
				.setValue(this.plugin.settings.batchConcurrency)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.batchConcurrency = value;
					await this.plugin.saveSettings();
				}));

		// 成功状态值
		new Setting(section)
			.setName('成功状态值')
			.setDesc('处理成功后写入 frontmatter 的 status 文本，例如 success/已处理/✅ 等')
			.addText(text => text
				.setPlaceholder('success')
				.setValue(this.plugin.settings.successStatusValue ?? 'success')
				.onChange(async (value) => {
					this.plugin.settings.successStatusValue = value ?? 'success';
					await this.plugin.saveSettings();
				}));
	}

	private createPayloadKeysSection(containerEl: HTMLElement) {
		const section = containerEl.createEl('div', { cls: 'setting-section' });
		section.createEl('h3', { text: '📡 Webhook Payload 键配置' });
		section.createEl('p', { 
			text: '自定义发送到 n8n webhook 的 JSON 对象中的键名。这允许您适应不同的 n8n 工作流配置。', 
			cls: 'setting-item-description' 
		});

		const keys = this.plugin.settings.payloadKeys;

		const createKeySetting = (name: string, desc: string, key: keyof typeof keys) => {
			new Setting(section)
				.setName(name)
				.setDesc(desc)
				.addText(text => text
					.setPlaceholder(DEFAULT_SETTINGS.payloadKeys[key])
					.setValue(keys[key])
					.onChange(async (value) => {
						keys[key] = value.trim() || DEFAULT_SETTINGS.payloadKeys[key];
						this.plugin.api.setPayloadKeys(keys);
						await this.plugin.saveSettings();
					}));
		};

		createKeySetting('处理模式键', '发送处理模式（summary/transcript-only 等）的键名', 'mode');
		createKeySetting('语言键', '发送语言代码（zh/en/ja）的键名', 'language');
		createKeySetting('AI 模型键', '发送 AI 模型名称的键名', 'ai');
		createKeySetting('仅信息标志键', '当模式为 info-only 时发送 true 的键名', 'info_only');
		createKeySetting('视频链接键', '发送视频 URL 的键名', 'link');
		createKeySetting('手动文稿键', '发送手动提供的文稿内容的键名', 'provided_transcript');
		createKeySetting('本地文件键', '发送本地文件路径的键名', 'local_file');
	}

	private createAdvancedSection(containerEl: HTMLElement) {
		const section = containerEl.createEl('div', { cls: 'setting-section' });
		section.createEl('h3', { text: '🔧 高级配置' });

		// 调试模式
		new Setting(section)
			.setName('调试模式')
			.setDesc('输出更多调试日志（控制台）')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableDebugMode)
				.onChange(async (value) => {
					this.plugin.settings.enableDebugMode = value;
					this.plugin.api.setDebug(!!value);
					await this.plugin.saveSettings();
				}));

		// 缓存配置
		const cacheSubsection = section.createEl('div', { cls: 'cache-subsection' });
		cacheSubsection.createEl('h4', { text: '🗄️ 缓存配置' });

		// 缓存状态概览
		const cacheStatusSetting = new Setting(cacheSubsection)
			.setName('缓存状态')
			.setDesc('点击查看当前缓存状态和统计信息')
			.addButton(button => button
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
				}));
		cacheStatusSetting.controlEl.addClass('cache-setting-item');

		// 启用缓存
		const enableCacheSetting = new Setting(cacheSubsection)
			.setName('✅ 启用缓存')
			.setDesc('缓存已处理的视频结果，避免重复调用API（节省费用）')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableCache ?? true)
				.onChange(async (value) => {
					this.plugin.settings.enableCache = value;
					this.plugin.api.setCacheEnabled(value);
					await this.plugin.saveSettings();
					new Notice(value ? '✅ 缓存已启用' : '❌ 缓存已禁用', 2000);
				}));
		enableCacheSetting.controlEl.addClass('cache-setting-item');

		// 缓存过期时间
		const expirySetting = new Setting(cacheSubsection)
			.setName('⏰ 缓存过期时间')
			.setDesc(`缓存结果的有效期（当前：${this.plugin.settings.cacheExpiryDays ?? 30} 天）`)
			.addSlider(slider => slider
				.setLimits(1, 365, 1)
				.setValue(this.plugin.settings.cacheExpiryDays ?? 30)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.cacheExpiryDays = value;
					this.plugin.api.setCacheConfig(1000, value);
					await this.plugin.saveSettings();
					// 更新描述
					expirySetting.setDesc(`缓存结果的有效期（当前：${value} 天）`);
				}));
		expirySetting.controlEl.addClass('cache-setting-item');
		expirySetting.controlEl.addClass('cache-expiry-slider');

		// 分隔线
		cacheSubsection.createEl('hr', { cls: 'cache-divider' });

		// 缓存管理操作
		cacheSubsection.createEl('h5', { text: '🛠️ 缓存管理' });

		// 快速操作按钮组
		const quickActionsContainer = cacheSubsection.createEl('div', { cls: 'cache-quick-actions' });

		// 测试缓存
		const testBtn = quickActionsContainer.createEl('button', {
			text: '🧪 添加测试',
			cls: 'cache-quick-btn'
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
			cls: 'cache-quick-btn'
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
			cls: 'cache-quick-btn cache-danger-btn'
		});
		clearBtn.onclick = async () => {
			// 显示确认对话框
			const confirmed = await new Promise<boolean>((resolve) => {
				const confirmModal = new ConfirmModal(
					this.app,
					'确认清空所有缓存',
					'此操作将删除所有缓存项，无法恢复。确定要继续吗？',
					resolve
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
	private async showCachePreviewModal(stats: { size: number; maxSize: number; expiredCount: number; totalSize: number }) {
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
				cls: 'cache-action-btn'
			}).onclick = refreshModalContent;

			// 关闭按钮
			actionsSection.createEl('button', {
				text: '❌ 关闭',
				cls: 'cache-action-btn'
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
					cls: 'cache-empty-message'
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
					cls: 'cache-item-delete-btn'
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
					cls: 'cache-more-items'
				});
			}
		} catch (error) {
			container.createEl('p', {
				text: `获取缓存内容失败: ${error.message}`,
				cls: 'cache-error-message'
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
				processed_at: new Date().toISOString()
			};

			await this.plugin.api.setCacheItem(
				'https://example.com/video-test.mp4',
				'summary',
				'zh',
				testResult
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
			'summary': '完整总结',
			'transcript-only': '仅文稿',
			'info-only': '仅视频信息'
		};
		return modeLabels[mode] || mode;
	}

	/**
	 * 获取语言标签
	 */
	private getLanguageLabel(language: string): string {
		const languageLabels: { [key: string]: string } = {
			'zh': '中文',
			'en': '英文',
			'ja': '日文'
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



