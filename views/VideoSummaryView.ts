import { ItemView, WorkspaceLeaf, TFile, Notice, MarkdownView, Modal, TFolder } from 'obsidian';
import VideoSummaryPlugin from '../main';
import { NoteProcessor } from '../utils/NoteProcessor';
import { VideoSummaryModal, ConfirmModal } from '../modals';
import { BatchProcessingModal } from '../BatchProcessingModal';
import { ProcessingMode, ProcessingResult, VideoInput, SupportedLanguage } from '../types';
import { VideoUtils } from '../utils/VideoUtils';
import { FileProcessor } from '../utils/FileProcessor';
import { RetryUtils } from '../utils/RetryUtils';

export const VIDEO_SUMMARY_VIEW_TYPE = 'video-summary-view';

// 文件夹选择模态框
class FolderSelectModal extends Modal {
	private folders: string[];
	private onSelect: (path: string) => void;
	private searchInput: HTMLInputElement | null = null;
	private folderContainer: HTMLElement | null = null;

	constructor(app: any, folders: string[], onSelect: (path: string) => void) {
		super(app);
		this.folders = folders;
		this.onSelect = onSelect;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl('h2', { text: '选择输出文件夹' });

		// 搜索输入框
		const searchContainer = contentEl.createEl('div', { cls: 'folder-search-container' });
		this.searchInput = searchContainer.createEl('input', {
			type: 'text',
			cls: 'folder-search-input'
		});
		this.searchInput.setAttribute('placeholder', '输入关键词搜索文件夹...');

		// 文件夹容器
		this.folderContainer = contentEl.createEl('div', { cls: 'folder-select-container' });

		// 添加"当前文件夹"选项
		const currentOption = this.folderContainer.createEl('div', { cls: 'folder-option' });
		currentOption.createEl('span', { text: '当前文件夹 (留空)' });
		currentOption.onclick = () => {
			this.onSelect('');
			this.close();
		};

		// 添加所有文件夹选项
		this.renderFolderOptions(this.folders);

		// 搜索事件
		this.searchInput.addEventListener('input', (e) => {
			const searchValue = (e.target as HTMLInputElement).value.toLowerCase();
			this.filterFolders(searchValue);
		});
	}

	private renderFolderOptions(folders: string[]) {
		if (!this.folderContainer) return;

		// 清除现有选项（保留"当前文件夹"）
		const currentOption = this.folderContainer.querySelector('.folder-option');
		this.folderContainer.empty();
		if (currentOption) {
			this.folderContainer.appendChild(currentOption);
		}

		// 添加文件夹选项
		folders.forEach(folderPath => {
			const option = this.folderContainer!.createEl('div', { cls: 'folder-option' });
			option.createEl('span', { text: folderPath });
			option.onclick = () => {
				this.onSelect(folderPath);
				this.close();
			};
		});
	}

	private filterFolders(searchValue: string) {
		if (!this.folderContainer) return;

		const options = this.folderContainer.querySelectorAll('.folder-option');
		options.forEach((option, index) => {
			if (index === 0) return; // 跳过"当前文件夹"选项

			const span = option.querySelector('span');
			if (span) {
				const text = span.textContent || '';
				if (searchValue === '' || text.toLowerCase().includes(searchValue)) {
					(option as HTMLElement).style.display = 'block';
				} else {
					(option as HTMLElement).style.display = 'none';
				}
			}
		});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}




interface VideoPart {
	title: string;
	url: string;
	index: number;
	isCurrent?: boolean;
	providedTranscript?: string;
	localFileName?: string;
	localFiles?: string[];
	merge?: boolean;
	sourceType?: 'single' | 'multi' | 'json' | 'playlist';
}

export class VideoSummaryView extends ItemView {
	private plugin: VideoSummaryPlugin;
	private noteProcessor: NoteProcessor;
	private videoParts: VideoPart[] = [];
	private processingFiles: Set<string> = new Set(); // 跟踪正在处理的文件
	private cancelProcessing: boolean = false; // 取消处理标志
	private currentProcessingMode: ProcessingMode;
	private ignoreCacheEnabled: boolean = false;




	constructor(leaf: WorkspaceLeaf, plugin: VideoSummaryPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.noteProcessor = new NoteProcessor(plugin.app.vault);
		this.currentProcessingMode = plugin.settings.defaultMode || 'summary';
	}

	private getActiveProcessingMode(): ProcessingMode {
		return this.currentProcessingMode || this.plugin.settings.defaultMode || 'summary';
	}

	private setActiveProcessingMode(mode: ProcessingMode) {
		this.currentProcessingMode = mode;
		this.plugin.settings.defaultMode = mode;
		this.plugin.saveSettings();
	}

	getViewType(): string {
		return VIDEO_SUMMARY_VIEW_TYPE;
	}

	getDisplayText(): string {
		return '视频总结管理';
	}

	getIcon(): string {
		return 'video';
	}

	async onOpen(): Promise<void> {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass('video-summary-view');

		// 合并输入和处理选项区域
		this.renderCombinedInputSection(container);

		// 合并的视频笔记和历史记录
		await this.renderCombinedFileListAndHistory(container);
	}

	private renderCombinedInputSection(container: HTMLElement) {
		const combinedSection = container.createEl('div', { cls: 'combined-input-section' });

		// 1. 顶部：单链接/多链接 切换 (模拟 Tab)
		const modeContainer = combinedSection.createEl('div', { cls: 'link-mode-container' });

		const renderRadio = (id: string, value: string, text: string, checked: boolean) => {
			const radio = modeContainer.createEl('input', { type: 'radio', attr: { name: 'link-mode-tab', id, value } });
			radio.checked = checked;
			modeContainer.createEl('label', { text, attr: { for: id } });
			return radio;
		};

		const singleRadio = renderRadio('mode-single', 'single', '🔗 单个链接', true);
		const jsonRadio = renderRadio('mode-json', 'json', '{ } JSON', false);
		const multiRadio = renderRadio('mode-multi', 'multi', '📋 批量链接', false);

		// 2. 核心输入区
		const inputWrapper = combinedSection.createEl('div', { cls: 'input-wrapper' });

		// 单链接输入 + 忽略缓存切换
		const linkInputWrapper = inputWrapper.createEl('div', { cls: 'link-input-wrapper' });
		linkInputWrapper.style.display = 'flex';
		linkInputWrapper.style.alignItems = 'center';

		const linkInput = linkInputWrapper.createEl('input', {
			type: 'text',
			cls: 'link-input',
			attr: { placeholder: '在此粘贴视频链接 (YouTube / Bilibili / TikTok)...' }
		});
		(linkInput as HTMLInputElement).style.flex = '1';

		const inputIgnoreBtn = linkInputWrapper.createEl('button', {
			cls: 'webhook-mini-btn ignore-cache-toggle',
			attr: { title: '忽略缓存（强制重新处理）', 'aria-label': '忽略缓存', type: 'button' }
		});

		const syncIgnoreBtnState = () => {
			inputIgnoreBtn.textContent = this.ignoreCacheEnabled ? '⟳' : '⟳';
			inputIgnoreBtn.classList.toggle('active', this.ignoreCacheEnabled);
			inputIgnoreBtn.style.opacity = this.ignoreCacheEnabled ? '1' : '0.6';
			inputIgnoreBtn.setAttribute('aria-pressed', this.ignoreCacheEnabled ? 'true' : 'false');
		};
		syncIgnoreBtnState();

		inputIgnoreBtn.addEventListener('click', (event) => {
			event.preventDefault();
			event.stopPropagation();
			this.ignoreCacheEnabled = !this.ignoreCacheEnabled;
			syncIgnoreBtnState();
		});

		// Webhook 快捷按钮：管理
		const webhookButtonsWrapper = linkInputWrapper.createEl('div', { cls: 'webhook-mini-buttons' });

		const webhookManageBtn = webhookButtonsWrapper.createEl('button', {
			text: '⚙',
			cls: 'webhook-mini-btn',
			attr: { title: '设置 Webhook' }
		});
		webhookManageBtn.onclick = (event) => {
			event.preventDefault();
			event.stopPropagation();
			const settingApi = (this.plugin.app as any).setting;
			if (settingApi?.open) {
				settingApi.open();
				if (settingApi.openTabById) {
					settingApi.openTabById(this.plugin.manifest.id);
				}
			} else {
				new Notice('请在设置中管理 Webhook');
			}
		};


		// 多链接输入 (默认隐藏)
		const multiLinksContainer = inputWrapper.createEl('div', { cls: 'multi-links-container' });
		multiLinksContainer.style.display = 'none';
		const multiLinksTextarea = multiLinksContainer.createEl('textarea', {
			cls: 'transcript-textarea',
			attr: { rows: 5, placeholder: '每行一个链接...' }
		});

		const jsonInputWrapper = inputWrapper.createEl('div', { cls: 'json-input-container' });
		jsonInputWrapper.style.display = 'none';
		const jsonTextarea = jsonInputWrapper.createEl('textarea', {
			cls: 'manual-json-input',
			attr: { rows: 8, placeholder: '粘贴 webhook 返回的 JSON 内容...' }
		});

		const updateInputVisibility = () => {
			if (singleRadio.checked) {
				linkInputWrapper.style.display = 'flex';
				multiLinksContainer.style.display = 'none';
				jsonInputWrapper.style.display = 'none';
			} else if (multiRadio.checked) {
				linkInputWrapper.style.display = 'none';
				multiLinksContainer.style.display = 'block';
				jsonInputWrapper.style.display = 'none';
			} else if (jsonRadio.checked) {
				linkInputWrapper.style.display = 'none';
				multiLinksContainer.style.display = 'none';
				jsonInputWrapper.style.display = 'block';
			}
			this.updateGenerateButtonText();
		};

		singleRadio.onchange = updateInputVisibility;
		multiRadio.onchange = updateInputVisibility;
		jsonRadio.onchange = updateInputVisibility;
		updateInputVisibility();

		// 3. 设置工具栏 (使用 Grid 布局优化空间) - 现在放入折叠面板
		const settingsDetails = combinedSection.createEl('details', { cls: 'basic-settings-details' });
		settingsDetails.createEl('summary', { text: '配置选项' });
		const settingsToolbar = settingsDetails.createEl('div', { cls: 'settings-toolbar' });

		// 左上：模式选择
		const modeGroup = settingsToolbar.createEl('div', { cls: 'toolbar-item' });
		modeGroup.createEl('span', { text: '模式' });
		const modeSelect = modeGroup.createEl('select');
		modeSelect.createEl('option', { text: '完整总结', value: 'summary' });
		modeSelect.createEl('option', { text: '仅文稿', value: 'transcript-only' });
		modeSelect.createEl('option', { text: '仅信息', value: 'info-only' });
		modeSelect.value = this.getActiveProcessingMode();
		modeSelect.onchange = () => {
			this.setActiveProcessingMode(modeSelect.value as ProcessingMode);
		};

		// 右上：语言选择
		const langGroup = settingsToolbar.createEl('div', { cls: 'toolbar-item' });
		langGroup.createEl('span', { text: '语言' });
		const langSelect = langGroup.createEl('select');
		langSelect.createEl('option', { text: '中文', value: 'zh' });
		langSelect.createEl('option', { text: 'English', value: 'en' });
		langSelect.createEl('option', { text: '日本語', value: 'ja' });
		langSelect.value = this.plugin.settings.defaultLanguage;
		langSelect.onchange = () => {
			this.plugin.settings.defaultLanguage = langSelect.value as 'zh' | 'en' | 'ja';
			this.plugin.saveSettings();
		};

		// 右侧：AI 模型选择
		const aiGroup = settingsToolbar.createEl('div', { cls: 'toolbar-item' });
		aiGroup.createEl('span', { text: 'AI 模型' });
		const aiSelect = aiGroup.createEl('select');
		const customModels = this.plugin.settings.customAiModels || [];
		customModels.forEach(model => {
			aiSelect.createEl('option', { text: model, value: model });
		});
		aiSelect.value = this.plugin.settings.aiModel || 'Gemini';
		aiSelect.onchange = () => {
			this.plugin.settings.aiModel = aiSelect.value;
			this.plugin.api.setAiModel(aiSelect.value);
			this.plugin.saveSettings();
		};

		// 第四个：Webhook 选择
		const webhookGroup = settingsToolbar.createEl('div', { cls: 'toolbar-item webhook-toolbar-group' });

		const webhookLabelWrapper = webhookGroup.createEl('span', { cls: 'webhook-label-wrapper' });
		webhookLabelWrapper.style.display = 'flex';
		webhookLabelWrapper.style.alignItems = 'center';
		webhookLabelWrapper.style.gap = '4px';
		webhookLabelWrapper.createEl('span', { text: 'Webhook' });

		const webhookSelect = webhookGroup.createEl('select');
		const profiles = this.plugin.settings.webhookProfiles || [];
		profiles.forEach(p => {
			webhookSelect.createEl('option', { text: p.name || p.url || '默认', value: p.id });
		});
		webhookSelect.value = this.plugin.settings.activeWebhookId;
		webhookSelect.onchange = async () => {
			await this.plugin.setActiveWebhook(webhookSelect.value, { silent: false });
		};

		// 下方全宽：输出位置 (避免文字截断)
		const folderGroup = settingsToolbar.createEl('div', { cls: 'toolbar-item full-width' });
		folderGroup.createEl('span', { text: '保存位置' });

		// 缩短路径显示逻辑
		const currentPath = this.plugin.settings.outputFolder || '当前文件夹';
		const displayPath = currentPath.length > 40 ? '...' + currentPath.slice(-35) : currentPath;

		const folderBtn = folderGroup.createEl('div', {
			text: displayPath,
			cls: 'clickable-text',
			attr: { title: currentPath } // 鼠标悬停显示全称
		});
		folderBtn.style.cursor = 'pointer';
		folderBtn.onclick = async () => {
			const folders = this.plugin.app.vault.getAllLoadedFiles()
				.filter(file => file instanceof TFolder)
				.map(folder => folder.path)
				.sort();
			const modal = new FolderSelectModal(this.plugin.app, folders, (selectedPath: string) => {
				const newPath = selectedPath || '当前文件夹';
				const newDisplayPath = newPath.length > 40 ? '...' + newPath.slice(-35) : newPath;
				folderBtn.textContent = newDisplayPath;
				folderBtn.setAttribute('title', newPath);
				this.plugin.settings.outputFolder = selectedPath;
				this.plugin.saveSettings();
			});
			modal.open();
		};

		// 4. 高级选项 (现在直接显示)
		const advancedContent = combinedSection.createEl('div', { cls: 'advanced-content expanded' });

		// --- 文稿输入区域 ---
		const transcriptRow = advancedContent.createEl('div', { cls: 'advanced-row' });
		transcriptRow.createEl('label', { text: '手动提供文稿 (可选)', cls: 'advanced-label' });
		const transcriptArea = transcriptRow.createEl('textarea', {
			cls: 'advanced-input', // 使用新的专用类名
			attr: { rows: 4, placeholder: '如果视频没有字幕，可在此处粘贴文稿内容...' }
		});

		// --- 本地文件区域 ---
		const localFileRow = advancedContent.createEl('div', { cls: 'advanced-row' });
		localFileRow.createEl('label', { text: '本地文件路径 (可选)', cls: 'advanced-label' });
		const localFileInput = localFileRow.createEl('input', {
			type: 'text',
			cls: 'advanced-input',
			attr: { placeholder: '例如: /Videos/Meeting_2024.mp4' }
		});

		// --- 批量分P 复选框 (修复了之前的布局问题) ---
		const checkboxRow = advancedContent.createEl('div', { cls: 'advanced-row' });
		// 创建一个横向容器
		const checkboxContainer = checkboxRow.createEl('div', { cls: 'checkbox-row' });

		const multiPCheck = checkboxContainer.createEl('input', {
			type: 'checkbox',
			attr: { id: 'multi-p-checkbox' }
		});

		const multiPLabel = checkboxContainer.createEl('label', {
			text: '批量处理多个分P (B站/YouTube列表)',
			attr: { for: 'multi-p-checkbox' }
		});

		const multiPOptionsWrapper = advancedContent.createEl('div', { cls: 'multi-p-options-wrapper' });
		multiPOptionsWrapper.style.display = 'none';

		const batchMethodContainer = multiPOptionsWrapper.createEl('div', { cls: 'batch-method-container' });
		batchMethodContainer.style.display = 'none';

		const methodLabel = batchMethodContainer.createEl('div', { cls: 'method-label' });
		methodLabel.textContent = '选择处理方式:';

		const methodOptions = batchMethodContainer.createEl('div', { cls: 'method-options' });

		const rangeOption = methodOptions.createEl('div', { cls: 'method-option' });
		const rangeRadio = rangeOption.createEl('input', { type: 'radio' });
		rangeRadio.setAttribute('id', 'range-method');
		rangeRadio.setAttribute('name', 'batch-method');
		rangeRadio.setAttribute('value', 'range');
		rangeRadio.checked = true;
		const rangeLabel = rangeOption.createEl('label', { text: '指定分P范围' });
		rangeLabel.setAttribute('for', 'range-method');

		const currentOption = methodOptions.createEl('div', { cls: 'method-option' });
		const currentRadio = currentOption.createEl('input', { type: 'radio' });
		currentRadio.setAttribute('id', 'current-method');
		currentRadio.setAttribute('name', 'batch-method');
		currentRadio.setAttribute('value', 'current');
		const currentLabel = currentOption.createEl('label', { text: '从当前P往后处理' });
		currentLabel.setAttribute('for', 'current-method');

		const rangeContainer = multiPOptionsWrapper.createEl('div', { cls: 'range-input-container' });
		rangeContainer.style.display = 'none';
		rangeContainer.createEl('span', { text: '分P范围: ', cls: 'range-label' });

		const startInput = rangeContainer.createEl('input', {
			type: 'number',
			cls: 'range-input'
		});
		startInput.setAttribute('placeholder', '开始');
		startInput.setAttribute('min', '1');
		startInput.setAttribute('max', '1000');
		startInput.value = '1';

		rangeContainer.createEl('span', { text: ' 到 ', cls: 'range-separator' });

		const endInput = rangeContainer.createEl('input', {
			type: 'number',
			cls: 'range-input'
		});
		endInput.setAttribute('placeholder', '结束');
		endInput.setAttribute('min', '1');
		endInput.setAttribute('max', '1000');
		endInput.value = '1';

		const currentPContainer = multiPOptionsWrapper.createEl('div', { cls: 'current-p-container' });
		currentPContainer.style.display = 'none';
		currentPContainer.createEl('span', { text: '处理数量: ', cls: 'current-p-label' });

		const currentPInput = currentPContainer.createEl('input', {
			type: 'number',
			cls: 'current-p-input'
		});
		currentPInput.setAttribute('placeholder', '处理数量');
		currentPInput.setAttribute('min', '1');
		currentPInput.setAttribute('max', '100');
		currentPInput.value = '5';

		multiPCheck.onchange = () => {
			const isMultiP = multiPCheck.checked;
			multiPOptionsWrapper.style.display = isMultiP ? 'block' : 'none';
			batchMethodContainer.style.display = isMultiP ? 'block' : 'none';

			if (isMultiP) {
				this.updateBatchMethodDisplay(rangeRadio.checked ? 'range' : 'current');
			} else {
				rangeContainer.style.display = 'none';
				currentPContainer.style.display = 'none';
			}

			this.updateGenerateButtonText();
		};

		rangeRadio.onchange = () => {
			if (rangeRadio.checked) {
				this.updateBatchMethodDisplay('range');
			}
		};

		currentRadio.onchange = () => {
			if (currentRadio.checked) {
				this.updateBatchMethodDisplay('current');
			}
		};

		// 5. 底部操作栏
		const actionRow = combinedSection.createEl('div', { cls: 'action-buttons-row' });

		// 获取上次结果 (次要按钮)
		const lastResultBtn = actionRow.createEl('button', {
			text: '查看上次结果',
			cls: 'btn-small'
		});
		lastResultBtn.onclick = () => this.handleGetLastResult();

		// 主操作按钮 (改为添加到列表)
		const addToQueueBtn = actionRow.createEl('button', {
			text: 'Process & Add to List',
			cls: 'btn-primary-large'
		});
		addToQueueBtn.textContent = '添加到列表';
		addToQueueBtn.onclick = async () => {
			const isSingleLink = singleRadio.checked;
			const isJsonMode = jsonRadio.checked;
			const rawUrl = linkInput.value.trim();
			const singleUrl = isSingleLink && !isJsonMode && !multiPCheck.checked
				? this.cleanVideoUrlKeepP(rawUrl)
				: this.cleanVideoUrl(rawUrl);
			const isMultiP = multiPCheck.checked;

			// 验证输出文件夹设置
			let outputFolder = this.plugin.settings.outputFolder || '';
			if (!outputFolder) {
				const activeFile = this.plugin.app.workspace.getActiveFile();
				if (activeFile) {
					outputFolder = activeFile.parent?.path || '';
				}
			}
			if (outputFolder !== this.plugin.settings.outputFolder) {
				this.plugin.settings.outputFolder = outputFolder;
				await this.plugin.saveSettings();
			}

			const providedTranscript = transcriptArea.value.trim();
			const localFile = localFileInput.value.trim();

			if (isJsonMode) {
				const jsonText = jsonTextarea.value.trim();
				if (!jsonText) {
					new Notice('请输入 webhook JSON 内容');
					return;
				}
				// JSON 模式直接添加到列表
				try {
					const jsonData = JSON.parse(jsonText);
					this.addPartToQueue({
						title: jsonData.title || 'JSON Input',
						url: jsonData.url || '',
						index: this.videoParts.length + 1,
						providedTranscript: jsonText,
						sourceType: 'json'
					});
					new Notice('已添加 JSON 内容到列表');
					jsonTextarea.value = ''; // 清空输入
				} catch (e) {
					new Notice('JSON 格式错误');
				}
				return;
			}

			if (isSingleLink) {
				if (!singleUrl && !localFile && !providedTranscript) {
					new Notice('请输入视频链接、本地文件路径或文稿内容');
					return;
				}
				if (isMultiP) {
					if (!rawUrl) {
						new Notice('多分P模式需要提供视频链接');
						return;
					}

					const rangeRadioEl = (this as any).multiPRadioRange as HTMLInputElement;
					const currentRadioEl = (this as any).multiPRadioCurrent as HTMLInputElement;
					const startInputEl = (this as any).multiPRangeStartInput as HTMLInputElement;
					const endInputEl = (this as any).multiPRangeEndInput as HTMLInputElement;
					const countInputEl = (this as any).multiPCountInput as HTMLInputElement;

					const useRange = rangeRadioEl ? rangeRadioEl.checked : true;

					if (useRange) {
						const startP = parseInt(startInputEl?.value || '1', 10) || 1;
						const endP = parseInt(endInputEl?.value || '1', 10) || startP;
						if (startP < 1 || endP < 1) { new Notice('分P范围必须大于0'); return; }
						if (startP > endP) { new Notice('开始分P不能大于结束分P'); return; }
						if (endP - startP + 1 > 100) { new Notice('一次最多处理100个分P'); return; }

						await this.generatePartsFromRangeToQueue(rawUrl, startP, endP, providedTranscript, localFile);
					} else if (currentRadioEl && currentRadioEl.checked) {
						const count = parseInt(countInputEl?.value || '5', 10) || 5;
						if (count < 1 || count > 100) { new Notice('处理数量必须在1-100之间'); return; }
						const currentP = this.extractCurrentPFromUrl(rawUrl);
						if (!currentP) {
							new Notice('无法从链接中提取当前分P，请使用分P范围方式');
							return;
						}
						await this.generatePartsFromRangeToQueue(rawUrl, currentP, currentP + count - 1, providedTranscript, localFile);
					}
					return;
				}

				// 单链接/单任务添加到列表
				let title = `Video ${this.videoParts.length + 1}`;
				let localFiles: string[] = [];
				let merge = false;

				if (isSingleLink && singleUrl) {
					const videoId = this.extractVideoId(singleUrl);
					if (videoId) {
						title = this.generateVideoTitle(singleUrl, videoId);
					}
				} else if (providedTranscript) {
					const now = new Date();
					const timeStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
					const snippet = providedTranscript.trim().split('\n')[0].substring(0, 12).replace(/[<>:"/\\|?*\s]/g, '_');
					title = snippet ? `文稿_${timeStr}_${snippet}` : `文稿处理_${timeStr}`;
				} else if (localFile) {
					// 检测是否多个文件
					if (localFile.includes(',')) {
						localFiles = localFile.split(',').map(f => f.trim()).filter(f => f.length > 0);
						if (localFiles.length > 0) {
							if (localFiles.length === 1) {
								const fileName = localFiles[0].split('/').pop() || localFiles[0].split('\\').pop() || 'local_file';
								title = '本地文件_' + fileName;
							} else {
								title = `合并处理_${localFiles.length}个文件`;
								merge = true;
							}
						}
					} else {
						const fileName = localFile.split('/').pop() || localFile.split('\\').pop() || 'local_file';
						title = '本地文件_' + fileName;
					}
				}

				this.addPartToQueue({
					title: title,
					url: singleUrl,
					index: this.videoParts.length + 1,
					providedTranscript: providedTranscript,
					localFileName: localFile, // 保持原始字符串供参考
					localFiles: localFiles.length > 0 ? localFiles : undefined,
					merge: merge,
					sourceType: 'single'
				});
				new Notice('已添加到列表');
				linkInput.value = ''; // 清空输入
			} else {
				const multiUrls = multiLinksTextarea.value.trim();
				if (!multiUrls && !localFile && !providedTranscript) {
					new Notice('请输入视频链接、本地文件路径或文稿内容');
					return;
				}

				const urlRegex = /(https?:\/\/[^\s]+)/g;
				const rawUrls = multiUrls.match(urlRegex) || [];

				const urls = Array.from(new Set(
					rawUrls
						.map(url => this.cleanVideoUrl(url.trim()))
						.filter(url => url.length > 0)
				));
				if (urls.length === 0) {
					new Notice('请输入至少一个有效的视频链接');
					return;
				}
				if (urls.length > 50) {
					new Notice('一次最多处理50个视频链接');
					return;
				}

				// 批量链接添加到列表
				urls.forEach((url, i) => {
					// 尝试生成更好的标题
					let title = `Video ${this.videoParts.length + 1}`;
					const videoId = this.extractVideoId(url);
					if (videoId) {
						title = this.generateVideoTitle(url, videoId);
					}

					this.addPartToQueue({
						title: title,
						url: url,
						index: this.videoParts.length + 1,
						providedTranscript: providedTranscript, // 如果是批量链接，通常不会共用一个 transcript，但这里按原有逻辑传递
						localFileName: localFile,
						sourceType: 'multi'
					});
				});
				new Notice(`已添加 ${urls.length} 个链接到列表`);
				multiLinksTextarea.value = ''; // 清空输入
			}
		};



		// 保存引用供其他方法使用
		(this as any).linkInput = linkInput;
		(this as any).multiLinksContainer = multiLinksContainer;
		(this as any).generateBtn = addToQueueBtn;
		(this as any).transcriptArea = transcriptArea;
		(this as any).localFileInput = localFileInput;
		(this as any).multiPCheck = multiPCheck;
		(this as any).multiPOptionsWrapper = multiPOptionsWrapper;
		(this as any).multiPMethodContainer = batchMethodContainer;
		(this as any).multiPRangeContainer = rangeContainer;
		(this as any).multiPCountContainer = currentPContainer;
		(this as any).multiPRangeStartInput = startInput;
		(this as any).multiPRangeEndInput = endInput;
		(this as any).multiPCountInput = currentPInput;
		(this as any).multiPRadioRange = rangeRadio;
		(this as any).multiPRadioCurrent = currentRadio;

		// 分P选择器（默认隐藏）
		this.renderPartsSelector(combinedSection);
	}

	private renderSimplifiedProcessingOptions(container: HTMLElement) {
		const optionsContainer = container.createEl('div', { cls: 'simplified-options-container' });

		// 处理模式选择
		const modeContainer = optionsContainer.createEl('div', { cls: 'option-group' });
		modeContainer.createEl('label', { text: '处理模式: ', cls: 'option-label' });

		const modeSelect = modeContainer.createEl('select', { cls: 'option-select' });
		modeSelect.createEl('option', { text: '完整总结', value: 'summary' });
		modeSelect.createEl('option', { text: '只提取文稿', value: 'transcript-only' });
		modeSelect.createEl('option', { text: '只获取视频信息', value: 'info-only' });
		modeSelect.value = this.getActiveProcessingMode();

		// 语言选择
		const languageContainer = optionsContainer.createEl('div', { cls: 'option-group' });
		languageContainer.createEl('label', { text: '语言: ', cls: 'option-label' });

		const languageSelect = languageContainer.createEl('select', { cls: 'option-select' });
		languageSelect.createEl('option', { text: '中文', value: 'zh' });
		languageSelect.createEl('option', { text: 'English', value: 'en' });
		languageSelect.createEl('option', { text: '日本語', value: 'ja' });
		languageSelect.value = this.plugin.settings.defaultLanguage;

		modeSelect.onchange = () => {
			this.setActiveProcessingMode(modeSelect.value as ProcessingMode);
		};

		languageSelect.onchange = () => {
			this.plugin.settings.defaultLanguage = languageSelect.value as 'zh' | 'en' | 'ja';
			this.plugin.saveSettings();
		};
	}

	// 删除统计信息和批量处理按钮

	private async renderCombinedFileListAndHistory(container: HTMLElement) {
		const combinedSection = container.createEl('div', { cls: 'combined-file-history-section' });

		// 标题和排序按钮在同一行 - 移除标题或使用更小的样式
		const titleRow = combinedSection.createEl('div', { cls: 'title-row' });
		// titleRow.createEl('h3', { text: '视频笔记与处理历史' });

		// 创建右侧控制组容器
		const controlsGroup = titleRow.createEl('div', { cls: 'controls-group' });

		// 搜索框
		const searchInput = controlsGroup.createEl('input', {
			cls: 'list-search-input',
			attr: { placeholder: '搜索文件名...' }
		});

		// 状态筛选
		const statusFilter = controlsGroup.createEl('select', { cls: 'status-filter-select' });
		statusFilter.createEl('option', { text: '全部状态', value: 'all' });
		statusFilter.createEl('option', { text: '待处理', value: 'pending' });
		statusFilter.createEl('option', { text: '处理中', value: 'running' });
		statusFilter.createEl('option', { text: '已处理', value: 'success' });
		statusFilter.createEl('option', { text: '失败', value: 'error' });

		// 使用保存的状态筛选设置，如果没有则使用默认值
		const savedStatusFilter = this.plugin.settings.statusFilterValue || 'all';
		statusFilter.value = savedStatusFilter;

		// 排序按钮
		const sortSelect = controlsGroup.createEl('select', { cls: 'sort-select-inline' });

		// 刷新按钮
		const refreshBtn = controlsGroup.createEl('button', {
			text: '🔄',
			cls: 'action-btn icon-btn history-refresh-btn',
			attr: { title: '刷新列表' }
		});
		refreshBtn.onclick = () => {
			// 重新渲染整个视图
			this.onOpen();
		};
		sortSelect.createEl('option', { text: '文件名A-Z', value: 'name-asc' });
		sortSelect.createEl('option', { text: '文件名Z-A', value: 'name-desc' });
		sortSelect.createEl('option', { text: '创建时间（最新）', value: 'ctime-desc' });
		sortSelect.createEl('option', { text: '创建时间（最早）', value: 'ctime-asc' });
		sortSelect.createEl('option', { text: '修改时间（最新）', value: 'mtime-desc' });
		sortSelect.createEl('option', { text: '修改时间（最早）', value: 'mtime-asc' });
		sortSelect.createEl('option', { text: '状态优先', value: 'status' });

		// 使用保存的排序设置，如果没有则使用默认值
		const savedSortBy = this.plugin.settings.fileListSortBy || 'ctime-desc';
		sortSelect.value = savedSortBy;

		const files = this.plugin.app.vault.getMarkdownFiles();
		const videoFiles: Array<{ file: TFile; status: string; content: string }> = [];

		// 先用 metadataCache 判断，必要时再读正文
		for (const file of files) {
			try {
				const fm = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter;
				if (VideoUtils.isVideoNoteFromFrontmatter(fm)) {
					const status = VideoUtils.getProcessingStatusFromFrontmatter(fm) || 'pending';
					videoFiles.push({ file, status, content: '' });
					continue;
				}
				// 回退到读取正文
				const content = await this.plugin.app.vault.read(file);
				if (VideoUtils.isVideoNote(content)) {
					const status = this.getProcessingStatus(content) || 'pending';
					videoFiles.push({ file, status, content });
				}
			} catch (error) {
				console.error(`读取文件失败: ${file.basename}`, error);
			}
		}

		if (videoFiles.length === 0) {
			combinedSection.createEl('p', { text: '未找到视频笔记', cls: 'no-files' });
			return;
		}

		// 排序 + 过滤功能
		const sortFiles = () => {
			const sortBy = sortSelect.value;
			const keyword = (searchInput.value || '').toLowerCase();
			const statusSelected = statusFilter.value;

			// 保存排序设置
			this.plugin.settings.fileListSortBy = sortBy;
			this.plugin.saveSettings();

			// 保存状态筛选设置
			this.plugin.settings.statusFilterValue = statusSelected;
			this.plugin.saveSettings();

			// 过滤
			let filtered = videoFiles.filter(({ file, status }) => {
				const nameMatch = !keyword || file.basename.toLowerCase().includes(keyword);
				const normalized = VideoUtils.normalizeStatus(status || '');
				const statusMatch = statusSelected === 'all' || normalized === statusSelected || (statusSelected === 'success' && normalized === 'success');
				return nameMatch && statusMatch;
			});

			let sortedFiles = [...filtered];

			switch (sortBy) {
				case 'name-asc':
					sortedFiles.sort((a, b) => a.file.basename.localeCompare(b.file.basename));
					break;
				case 'name-desc':
					sortedFiles.sort((a, b) => b.file.basename.localeCompare(a.file.basename));
					break;
				case 'ctime-desc':
					sortedFiles.sort((a, b) => b.file.stat.ctime - a.file.stat.ctime);
					break;
				case 'ctime-asc':
					sortedFiles.sort((a, b) => a.file.stat.ctime - b.file.stat.ctime);
					break;
				case 'mtime-desc':
					sortedFiles.sort((a, b) => b.file.stat.mtime - a.file.stat.mtime);
					break;
				case 'mtime-asc':
					sortedFiles.sort((a, b) => a.file.stat.mtime - b.file.stat.mtime);
					break;
				case 'status':
					// 按状态排序：待处理 -> 处理中 -> 已处理 -> 错误
					const statusOrder: { [key: string]: number } = { 'pending': 0, 'running': 1, 'success': 2, 'error': 3 };
					sortedFiles.sort((a, b) => {
						const aOrder = statusOrder[a.status] ?? 4;
						const bOrder = statusOrder[b.status] ?? 4;
						if (aOrder !== bOrder) return aOrder - bOrder;
						return a.file.basename.localeCompare(b.file.basename);
					});
					break;
			}

			// 重新渲染文件列表
			this.renderCombinedSortedFileList(combinedSection, sortedFiles);
		};

		// 绑定排序事件
		sortSelect.onchange = sortFiles;
		searchInput.oninput = () => {
			// 即输即搜
			sortFiles();
		};
		statusFilter.onchange = sortFiles;

		// 初始渲染
		sortFiles();
	}

	private renderCombinedSortedFileList(container: HTMLElement, sortedFiles: Array<{ file: TFile; status: string; content: string }>) {
		// 移除现有的文件列表
		const existingLists = container.querySelectorAll('.file-list, .history-list, .combined-list');
		existingLists.forEach(list => list.remove());

		// 按状态分组显示
		const pendingFiles = sortedFiles.filter(f => {
			const status = VideoUtils.normalizeStatus(f.status || '');
			return status === 'pending' || f.status === '';
		});
		const runningFiles = sortedFiles.filter(f => VideoUtils.normalizeStatus(f.status || '') === 'running');
		const errorFiles = sortedFiles.filter(f => VideoUtils.normalizeStatus(f.status || '') === 'error');
		const processedFiles = sortedFiles.filter(f => {
			const status = VideoUtils.normalizeStatus(f.status || '');
			return status === 'success';
		});



		// 创建合并的列表容器
		const combinedList = container.createEl('div', { cls: 'combined-list' });

		// 待处理文件
		if (pendingFiles.length > 0) {
			combinedList.createEl('div', { text: `待处理 (${pendingFiles.length})`, cls: 'section-title-small' });
			this.renderFileGroup(combinedList, pendingFiles, 'pending');
		}

		// 处理中文件
		if (runningFiles.length > 0) {
			combinedList.createEl('div', { text: `处理中 (${runningFiles.length})`, cls: 'section-title-small' });
			this.renderFileGroup(combinedList, runningFiles, 'running');
		}

		// 错误文件
		if (errorFiles.length > 0) {
			combinedList.createEl('div', { text: `处理失败 (${errorFiles.length})`, cls: 'section-title-small' });
			this.renderFileGroup(combinedList, errorFiles, 'error');
		}

		// 已处理文件
		if (processedFiles.length > 0) {
			combinedList.createEl('div', { text: `已处理 (${processedFiles.length})`, cls: 'section-title-small' });
			this.renderFileGroup(combinedList, processedFiles, 'processed');
		}

		// 如果没有文件被分组，显示所有文件
		if (pendingFiles.length === 0 && runningFiles.length === 0 && errorFiles.length === 0 && processedFiles.length === 0) {
			const header = combinedList.createEl('h4', { text: `所有文件 (${sortedFiles.length})`, cls: 'collapsible' });
			const listEl = this.renderFileGroup(combinedList, sortedFiles, 'all');
			header.onclick = () => {
				const collapsed = listEl.style.display === 'none';
				listEl.style.display = collapsed ? 'block' : 'none';
				header.classList.toggle('collapsed', !collapsed);
			};
		}
	}

	private renderLinkInput(container: HTMLElement) {
		const linkSection = container.createEl('div', { cls: 'link-input-section' });
		let jsonRadio: HTMLInputElement;
		let jsonTextarea: HTMLTextAreaElement;

		// 链接输入方式切换（移到最上面）
		const linkModeContainer = linkSection.createEl('div', { cls: 'link-mode-container' });
		const singleLinkRadio = linkModeContainer.createEl('input', { type: 'radio' });
		singleLinkRadio.setAttribute('id', 'single-link-mode');
		singleLinkRadio.setAttribute('name', 'link-mode');
		singleLinkRadio.setAttribute('value', 'single');
		singleLinkRadio.checked = true;
		const singleLinkLabel = linkModeContainer.createEl('label', { text: '单个链接' });
		singleLinkLabel.setAttribute('for', 'single-link-mode');

		const multiLinksRadio = linkModeContainer.createEl('input', { type: 'radio' });
		multiLinksRadio.setAttribute('id', 'multi-links-mode');
		multiLinksRadio.setAttribute('name', 'link-mode');
		multiLinksRadio.setAttribute('value', 'multi');
		const multiLinksLabel = linkModeContainer.createEl('label', { text: '批量链接' });
		multiLinksLabel.setAttribute('for', 'multi-links-mode');

		jsonRadio = linkModeContainer.createEl('input', { type: 'radio' });
		jsonRadio.setAttribute('id', 'json-mode');
		jsonRadio.setAttribute('name', 'link-mode');
		jsonRadio.setAttribute('value', 'json');
		const jsonLabel = linkModeContainer.createEl('label', { text: 'JSON' });
		jsonLabel.setAttribute('for', 'json-mode');

		// 单个链接输入框
		const inputContainer = linkSection.createEl('div', { cls: 'link-input-container' });
		const linkInput = inputContainer.createEl('input', {
			type: 'text',
			cls: 'link-input'
		});
		linkInput.setAttribute('placeholder', '输入视频链接 (YouTube/Bilibili/抖音/TikTok)');

		// 多个链接输入框
		const multiLinksContainer = linkSection.createEl('div', { cls: 'multi-links-container' });

		// 创建标题行容器，仅保留标签描述
		const multiLinksHeader = multiLinksContainer.createEl('div', { cls: 'multi-links-header' });
		multiLinksHeader.createEl('span', { text: '多个链接 (每行一个): ', cls: 'multi-links-label' });

		const multiLinksTextarea = multiLinksContainer.createEl('textarea', {
			cls: 'multi-links-textarea'
		});
		multiLinksTextarea.setAttribute('placeholder', '可以输入多个视频链接，每行一个\n例如：\nhttps://www.bilibili.com/video/BV1xx\nhttps://www.youtube.com/watch?v=xxx');

		// 初始显示状态
		multiLinksContainer.style.display = 'none';

		// JSON 输入
		const jsonContainer = linkSection.createEl('div', { cls: 'json-input-container' });
		jsonContainer.style.display = 'none';
		jsonTextarea = jsonContainer.createEl('textarea', {
			cls: 'manual-json-input',
			attr: { rows: '1', placeholder: '粘贴 webhook 返回的 JSON 内容...' }
		});



		// 链接模式切换事件
		singleLinkRadio.onchange = () => {
			if (singleLinkRadio.checked) {
				linkInput.style.display = 'block';
				multiLinksContainer.style.display = 'none';
				jsonContainer.style.display = 'none';
				generateBtn.style.display = 'block';
			}
			this.updateGenerateButtonText();
		};

		const updateModeVisibility = () => {
			if (singleLinkRadio.checked) {
				linkInput.style.display = 'block';
				multiLinksContainer.style.display = 'none';
				jsonContainer.style.display = 'none';
				generateBtn.style.display = 'block';
			} else if (multiLinksRadio.checked) {
				linkInput.style.display = 'none';
				multiLinksContainer.style.display = 'block';
				jsonContainer.style.display = 'none';
				generateBtn.style.display = 'block';
			} else if (jsonRadio.checked) {
				linkInput.style.display = 'none';
				multiLinksContainer.style.display = 'none';
				jsonContainer.style.display = 'block';
				generateBtn.style.display = 'block';
				generateBtn.textContent = '创建笔记';
			}
			this.updateGenerateButtonText();
		};

		singleLinkRadio.onchange = updateModeVisibility;
		multiLinksRadio.onchange = updateModeVisibility;
		jsonRadio.onchange = updateModeVisibility;
		updateModeVisibility();

		jsonRadio.onchange = () => {
			if (jsonRadio.checked) {
				linkInput.style.display = 'none';
				multiLinksContainer.style.display = 'none';
				jsonContainer.style.display = 'block';
				generateBtn.style.display = 'block';
				generateBtn.textContent = '创建笔记';
			}
		};

		// 多P处理选项
		const multiPContainer = linkSection.createEl('div', { cls: 'multi-p-container' });
		const multiPCheckbox = multiPContainer.createEl('input', {
			type: 'checkbox'
		});
		multiPCheckbox.setAttribute('id', 'multi-p-checkbox');
		const multiPLabel = multiPContainer.createEl('label', {
			text: '批量处理多个分P'
		});
		multiPLabel.setAttribute('for', 'multi-p-checkbox');

		// 批量处理方式选择（默认隐藏）
		const batchMethodContainer = linkSection.createEl('div', { cls: 'batch-method-container' });
		batchMethodContainer.style.display = 'none';

		// 处理方式单选按钮
		const methodLabel = batchMethodContainer.createEl('div', { cls: 'method-label' });
		methodLabel.textContent = '选择处理方式:';

		const methodOptions = batchMethodContainer.createEl('div', { cls: 'method-options' });

		// 分P范围选项
		const rangeOption = methodOptions.createEl('div', { cls: 'method-option' });
		const rangeRadio = rangeOption.createEl('input', { type: 'radio' });
		rangeRadio.setAttribute('id', 'range-method');
		rangeRadio.setAttribute('name', 'batch-method');
		rangeRadio.setAttribute('value', 'range');
		rangeRadio.checked = true;
		const rangeLabel = rangeOption.createEl('label', { text: '指定分P范围' });
		rangeLabel.setAttribute('for', 'range-method');

		// 从当前P往后选项
		const currentOption = methodOptions.createEl('div', { cls: 'method-option' });
		const currentRadio = currentOption.createEl('input', { type: 'radio' });
		currentRadio.setAttribute('id', 'current-method');
		currentRadio.setAttribute('name', 'batch-method');
		currentRadio.setAttribute('value', 'current');
		const currentLabel = currentOption.createEl('label', { text: '从当前P往后处理' });
		currentLabel.setAttribute('for', 'current-method');

		// 分P范围输入（默认显示）
		const rangeContainer = linkSection.createEl('div', { cls: 'range-input-container' });
		rangeContainer.style.display = 'none';
		rangeContainer.createEl('span', { text: '分P范围: ', cls: 'range-label' });

		const startInput = rangeContainer.createEl('input', {
			type: 'number',
			cls: 'range-input'
		});
		startInput.setAttribute('placeholder', '开始');
		startInput.setAttribute('min', '1');
		startInput.setAttribute('max', '1000');
		startInput.value = '1';

		rangeContainer.createEl('span', { text: ' 到 ', cls: 'range-separator' });

		const endInput = rangeContainer.createEl('input', {
			type: 'number',
			cls: 'range-input'
		});
		endInput.setAttribute('placeholder', '结束');
		endInput.setAttribute('min', '1');
		endInput.setAttribute('max', '1000');
		endInput.value = '1';

		// 从当前P往后处理选项
		const currentPContainer = linkSection.createEl('div', { cls: 'current-p-container' });
		currentPContainer.style.display = 'none';
		currentPContainer.createEl('span', { text: '处理数量: ', cls: 'current-p-label' });

		const currentPInput = currentPContainer.createEl('input', {
			type: 'number',
			cls: 'current-p-input'
		});
		currentPInput.setAttribute('placeholder', '处理数量');
		currentPInput.setAttribute('min', '1');
		currentPInput.setAttribute('max', '100');
		currentPInput.value = '5';

		// 额外输入选项
		const extraInputContainer = linkSection.createEl('div', { cls: 'extra-input-container' });
		extraInputContainer.style.display = 'none'; // 默认隐藏

		// 高级选项和输出位置容器
		const optionsOutputContainer = linkSection.createEl('div', { cls: 'options-output-container' });

		// 额外选项切换按钮
		const extraOptionsToggle = optionsOutputContainer.createEl('button', {
			text: '显示高级选项',
			cls: 'action-btn secondary extra-options-toggle'
		});

		// 输出文件夹设置
		const outputContainer = optionsOutputContainer.createEl('div', { cls: 'output-folder-container' });
		outputContainer.createEl('span', { text: '输出位置: ', cls: 'output-label' });

		// 添加文件夹选择按钮
		const folderSelectBtn = outputContainer.createEl('button', {
			text: this.plugin.settings.outputFolder || '当前文件夹',
			cls: 'folder-select-btn'
		});

		// 提供的文稿
		const transcriptContainer = extraInputContainer.createEl('div', { cls: 'transcript-container' });
		transcriptContainer.createEl('span', { text: '提供的文稿: ', cls: 'transcript-label' });

		const transcriptTextarea = transcriptContainer.createEl('textarea', {
			cls: 'transcript-textarea'
		});
		transcriptTextarea.setAttribute('placeholder', '如果有现成的文稿，可以粘贴在这里（可选）');

		// 本地文件
		const localFileContainer = extraInputContainer.createEl('div', { cls: 'local-file-container' });
		localFileContainer.createEl('span', { text: '本地文件: ', cls: 'local-file-label' });

		const localFileInput = localFileContainer.createEl('input', {
			type: 'text',
			cls: 'local-file-input'
		});
		localFileInput.setAttribute('placeholder', '本地视频文件路径（可选）');

		// 额外选项切换事件
		extraOptionsToggle.onclick = () => {
			const isVisible = extraInputContainer.style.display !== 'none';
			if (isVisible) {
				extraInputContainer.style.display = 'none';
				extraOptionsToggle.textContent = '显示高级选项';
				extraOptionsToggle.classList.remove('active');
			} else {
				extraInputContainer.style.display = 'block';
				extraOptionsToggle.textContent = '隐藏高级选项';
				extraOptionsToggle.classList.add('active');
			}
		};
		folderSelectBtn.onclick = async () => {
			// 获取所有文件夹
			const folders = this.plugin.app.vault.getAllLoadedFiles()
				.filter(file => file instanceof TFolder)
				.map(folder => folder.path)
				.sort();

			// 创建文件夹选择对话框
			const modal = new FolderSelectModal(this.plugin.app, folders, (selectedPath: string) => {
				folderSelectBtn.textContent = selectedPath || '当前文件夹';
				this.plugin.settings.outputFolder = selectedPath;
				this.plugin.saveSettings();
			});
			modal.open();
		};

		// 多P勾选框事件处理
		multiPCheckbox.onchange = () => {
			const isMultiP = multiPCheckbox.checked;
			batchMethodContainer.style.display = isMultiP ? 'block' : 'none';

			// 根据当前选中的方式显示对应输入框
			if (isMultiP) {
				this.updateBatchMethodDisplay(rangeRadio.checked ? 'range' : 'current');
			} else {
				rangeContainer.style.display = 'none';
				currentPContainer.style.display = 'none';
			}

			// 更新按钮文字
			this.updateGenerateButtonText();
		};

		// 处理方式选择事件
		rangeRadio.onchange = () => {
			if (rangeRadio.checked) {
				this.updateBatchMethodDisplay('range');
			}
		};

		currentRadio.onchange = () => {
			if (currentRadio.checked) {
				this.updateBatchMethodDisplay('current');
			}
		};

		// 为多个链接按钮添加点击事件
		const handleMultiLinksProcessing = async () => {
			const multiUrls = multiLinksTextarea.value.trim();
			// 获取输出文件夹，如果未设置则使用当前活跃文件所在文件夹
			let outputFolder = this.plugin.settings.outputFolder || '';
			if (!outputFolder) {
				const activeFile = this.plugin.app.workspace.getActiveFile();
				if (activeFile) {
					outputFolder = activeFile.parent?.path || '';
				}
			}
			const providedTranscript = transcriptTextarea.value.trim();
			const localFile = localFileInput.value.trim();

			// 验证输入
			if (!multiUrls && !localFile && !providedTranscript) {
				new Notice('请输入视频链接、本地文件路径或文稿内容');
				return;
			}

			// 保存输出文件夹设置
			if (outputFolder !== this.plugin.settings.outputFolder) {
				this.plugin.settings.outputFolder = outputFolder;
				await this.plugin.saveSettings();
			}

			// 多个链接处理 (自动提取文本中的所有链接)
			const urlRegex = /(https?:\/\/[^\s]+)/g;
			const rawUrls = multiUrls.match(urlRegex) || [];

			// 去重、清理并过滤空链接
			const urls = Array.from(new Set(
				rawUrls
					.map(url => this.cleanVideoUrl(url.trim()))
					.filter(url => url.length > 0)
			));
			if (urls.length === 0) {
				new Notice('请输入至少一个有效的视频链接');
				return;
			}
			if (urls.length > 50) {
				new Notice('一次最多处理50个视频链接');
				return;
			}

			await this.processMultipleVideos(urls, providedTranscript, localFile);
		};

		// 按钮容器
		const buttonContainer = inputContainer.createEl('div', { cls: 'button-container' });

		// 获取上次结果按钮
		const getLastResultBtn = buttonContainer.createEl('button', {
			text: '📋 获取上次结果',
			cls: 'action-btn secondary get-last-result-btn',
			attr: { title: '获取最近一次webhook调用的结果' }
		});
		getLastResultBtn.onclick = async () => {
			await this.handleGetLastResult();
		};

		// 生成按钮（用于单个链接处理）
		const generateBtn = buttonContainer.createEl('button', {
			text: '处理单个视频',
			cls: 'action-btn primary generate-btn'
		});
		generateBtn.onclick = async () => {
			const isSingleLink = singleLinkRadio.checked;
			const isMultiLinksMode = multiLinksRadio.checked;
			const rawSingleUrl = linkInput.value.trim();
			// 单个链接模式：清理URL但保留p参数（如 ?p=34）
			// 批量分P模式：使用根URL（去掉所有参数包括p参数）
			const isMultiP = multiPCheckbox.checked;
			const singleUrl = isMultiP ? this.cleanVideoUrl(rawSingleUrl) : this.cleanVideoUrlKeepP(rawSingleUrl);
			// 获取输出文件夹，如果未设置则使用当前活跃文件所在文件夹
			let outputFolder = this.plugin.settings.outputFolder || '';
			if (!outputFolder) {
				const activeFile = this.plugin.app.workspace.getActiveFile();
				if (activeFile) {
					outputFolder = activeFile.parent?.path || '';
				}
			}
			const providedTranscript = transcriptTextarea.value.trim();
			const localFile = localFileInput.value.trim();

			// 验证输入
			if (isSingleLink && !singleUrl && !localFile && !providedTranscript) {
				new Notice('请输入视频链接、本地文件路径或文稿内容');
				return;
			}
			if (isMultiLinksMode && !multiLinksTextarea.value.trim() && !localFile && !providedTranscript) {
				new Notice('请输入视频链接、本地文件路径或文稿内容');
				return;
			}

			// 保存输出文件夹设置
			if (outputFolder !== this.plugin.settings.outputFolder) {
				this.plugin.settings.outputFolder = outputFolder;
				await this.plugin.saveSettings();
			}

			if (isMultiLinksMode) {
				await handleMultiLinksProcessing();
				return;
			}

			if (isSingleLink) {
				// 单个链接处理
				if (isMultiP) {
					// 批量处理逻辑 - 使用根URL（已清理p参数）
					const method = rangeRadio.checked ? 'range' : 'current';

					if (method === 'range') {
						const startP = parseInt(startInput.value) || 1;
						const endP = parseInt(endInput.value) || 1;

						if (startP < 1 || endP < 1) { new Notice('分P范围必须大于0'); return; }
						if (startP > endP) { new Notice('开始分P不能大于结束分P'); return; }
						if (endP - startP + 1 > 100) { new Notice('一次最多处理100个分P'); return; }

						await this.generatePartsFromRange(singleUrl, startP, endP, providedTranscript, localFile);
					} else {
						const count = parseInt(currentPInput.value) || 5;
						if (count < 1 || count > 100) { new Notice('处理数量必须在1-100之间'); return; }

						// 从当前P往后处理（这里需要从URL中提取当前P）
						const currentP = this.extractCurrentPFromUrl(rawSingleUrl);
						if (currentP) {
							await this.generatePartsFromRange(singleUrl, currentP, currentP + count - 1, providedTranscript, localFile);
						} else {
							new Notice('无法从链接中提取当前分P，请使用分P范围方式');
						}
					}
				} else {
					// 单个处理逻辑 - 使用清理后的URL（保留p参数，去掉其他参数）
					await this.processSingleVideo(singleUrl, providedTranscript, localFile);
				}
			}
		};

		this.renderPartsSelector(linkSection);
	}

	private updateBatchMethodDisplay(method: 'range' | 'current') {
		const rangeContainer = (this as any).multiPRangeContainer as HTMLElement;
		const currentPContainer = (this as any).multiPCountContainer as HTMLElement;
		if (!rangeContainer || !currentPContainer) return;

		if (method === 'range') {
			rangeContainer.style.display = 'flex';
			currentPContainer.style.display = 'none';
		} else {
			rangeContainer.style.display = 'none';
			currentPContainer.style.display = 'flex';
		}
	}

	private extractCurrentPFromUrl(url: string): number | null {
		const pMatch = url.match(/[?&](?:p|index)=(\d+)/);
		if (pMatch) {
			return parseInt(pMatch[1]);
		}
		return null;
	}



	private renderPartsSelector(container: HTMLElement) {
		// 1. 容器
		const partsSection = container.createEl('div', { cls: 'parts-section' });
		partsSection.style.display = 'none'; // 默认隐藏

		// 2. 顶部工具栏 (标题 + 全选/反选)
		const headerBar = partsSection.createEl('div', { cls: 'parts-header-bar' });

		// 左侧信息
		const infoDiv = headerBar.createEl('span', {
			cls: 'parts-info-text',
			text: '检测到分P视频' // 初始文字
		});

		// 右侧控制按钮
		const controlsDiv = headerBar.createEl('div', { cls: 'parts-controls' });

		const selectAllBtn = controlsDiv.createEl('button', { text: '全选', cls: 'btn-text-only' });
		selectAllBtn.onclick = () => this.selectAllParts();

		const selectNoneBtn = controlsDiv.createEl('button', { text: '清空', cls: 'btn-text-only' });
		selectNoneBtn.onclick = () => this.selectNoneParts();

		// 3. 列表区域
		const partsList = partsSection.createEl('div', { cls: 'parts-list' });

		// 4. 底部大按钮
		const footer = partsSection.createEl('div', { cls: 'parts-footer' });
		const batchProcessBtn = footer.createEl('button', {
			text: '批量处理选中分P',
			cls: 'batch-process-btn' // 使用新定义的样式类
		});
		batchProcessBtn.onclick = () => this.batchProcessSelectedParts();

		// 挂载引用，供后续逻辑使用
		(partsSection as any).partsList = partsList;
		(partsSection as any).batchProcessBtn = batchProcessBtn;
		(partsSection as any).infoDiv = infoDiv; // 新增引用，方便更新文字

		// 保存到类实例中，方便其他方法调用 show/hide
		(this as any).partsSectionEl = partsSection;
	}



	// 新增方法: 添加单个部分到队列
	private addPartToQueue(part: VideoPart) {
		this.videoParts.push(part);
		this.updatePartsListDisplay();
	}

	// 新增方法: 批量生成分P到队列
	private async generatePartsFromRangeToQueue(url: string, startP: number, endP: number, providedTranscript: string, localFile: string) {
		try {
			const videoId = this.extractVideoId(url);
			if (!videoId) {
				new Notice('无法识别视频链接格式');
				return;
			}

			for (let i = startP; i <= endP; i++) {
				const pUrl = this.generatePartUrl(url, videoId, i);
				this.addPartToQueue({
					title: `第${i}P`,
					url: pUrl,
					index: i,
					isCurrent: false,
					providedTranscript: providedTranscript,
					localFileName: localFile,
					sourceType: 'playlist'
				});
			}
			new Notice(`已添加 ${endP - startP + 1} 个分P到列表`);
		} catch (error) {
			new Notice(`生成失败: ${error.message}`);
		}
	}

	private updatePartsListDisplay() {
		const partsSection = this.containerEl.querySelector('.parts-section') as HTMLElement;
		if (partsSection && this.videoParts.length > 0) {
			partsSection.style.display = 'block';
			this.renderPartsList();
		} else if (partsSection) {
			partsSection.style.display = 'none'; // 队列为空时隐藏
		}
	}

	// 保留旧方法以兼容性（如果还有其他调用），或者可以废弃
	private async generatePartsFromRange(url: string, startP: number, endP: number, providedTranscript: string, localFile: string) {
		return this.generatePartsFromRangeToQueue(url, startP, endP, providedTranscript, localFile);
	}

	private extractVideoId(url: string): string | null {
		const cleanUrl = this.cleanVideoUrl(url);

		// B站视频ID提取
		const bilibiliMatch = cleanUrl.match(/\/video\/(BV[a-zA-Z0-9]+)/);
		if (bilibiliMatch) {
			return bilibiliMatch[1];
		}

		// YouTube视频ID提取
		const youtubeMatch = cleanUrl.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]+)/);
		if (youtubeMatch) {
			return youtubeMatch[1];
		}

		// 抖音视频ID提取
		const douyinMatch = cleanUrl.match(/\/video\/(\d+)/);
		if (douyinMatch) {
			return douyinMatch[1];
		}

		// TikTok视频ID提取
		const tiktokMatch = cleanUrl.match(/\/video\/(\d+)/);
		if (tiktokMatch) {
			return tiktokMatch[1];
		}

		return null;
	}

	private generatePartUrl(originalUrl: string, videoId: string, partIndex: number): string {
		// B站视频
		if (originalUrl.includes('bilibili.com')) {
			return partIndex === 1 ?
				`https://www.bilibili.com/video/${videoId}` :
				`https://www.bilibili.com/video/${videoId}?p=${partIndex}`;
		}

		// YouTube视频
		if (originalUrl.includes('youtube.com') || originalUrl.includes('youtu.be')) {
			try {
				const cleanBase = this.cleanVideoUrl(originalUrl);
				const urlObj = new URL(cleanBase);
				urlObj.searchParams.set('index', String(partIndex));
				return urlObj.toString();
			} catch {
				// fallback: 简单追加
				const baseUrl = this.cleanVideoUrl(originalUrl);
				return `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}index=${partIndex}`;
			}
		}

		// 其他平台保持原样
		return originalUrl;
	}

	private renderPartsList() {
		// 获取我们在 renderPartsSelector 里创建的引用
		const partsSection = (this as any).partsSectionEl || this.containerEl.querySelector('.parts-section') as HTMLElement;
		if (!partsSection) return;

		const partsList = partsSection.querySelector('.parts-list') as HTMLElement;
		const infoDiv = partsSection.querySelector('.parts-info-text') as HTMLElement; // 获取标题元素

		if (!partsList) return;
		partsList.empty();

		// 更新标题文字
		if (infoDiv) {
			infoDiv.textContent = `共找到 ${this.videoParts.length} 个分P`;
		}

		this.videoParts.forEach((part) => {
			const partItem = partsList.createEl('div', { cls: 'part-item' });

			// 复选框
			const checkbox = partItem.createEl('input', {
				type: 'checkbox',
				attr: { id: `part-${part.index}` }
			});

			const isCurrent = (part as any).isCurrent;
			checkbox.checked = isCurrent || this.videoParts.length === 1;

			// 标题标签
			const label = partItem.createEl('label', {
				text: `${part.index}. ${part.title}`,
				attr: { for: `part-${part.index}` }
			});
			if (isCurrent) label.style.fontWeight = 'bold';

			// 链接图标组
			const linkContainer = partItem.createEl('div', { cls: 'item-actions' });

			// 复制按钮
			const copyBtn = linkContainer.createEl('button', {
				cls: 'clickable-icon',
				attr: { 'aria-label': '复制链接', title: part.url }
			});
			copyBtn.innerHTML = '🔗';
			copyBtn.onclick = () => this.copyToClipboard(part.url, part.index);

			// 删除按钮
			const deleteBtn = linkContainer.createEl('button', {
				cls: 'clickable-icon delete-icon',
				attr: { 'aria-label': '从列表移除', title: '移除' }
			});
			deleteBtn.innerHTML = '🗑️';
			deleteBtn.style.color = 'var(--text-error)';
			deleteBtn.onclick = () => {
				this.videoParts = this.videoParts.filter(p => p !== part);
				this.renderPartsList();
				if (this.videoParts.length === 0) {
					const partsSection = (this as any).partsSectionEl;
					if (partsSection) partsSection.style.display = 'none';
				}
			};

			// 保存引用
			(part as any).checkbox = checkbox;
		});
	}

	private selectAllParts() {
		this.videoParts.forEach(part => {
			if ((part as any).checkbox) {
				(part as any).checkbox.checked = true;
			}
		});
	}

	private selectNoneParts() {
		this.videoParts.forEach(part => {
			if ((part as any).checkbox) {
				(part as any).checkbox.checked = false;
			}
		});
	}

	private async batchProcessSelectedParts() {
		const selectedParts = this.videoParts.filter(part =>
			(part as any).checkbox && (part as any).checkbox.checked
		);

		if (selectedParts.length === 0) {
			new Notice('请选择要处理的分P');
			return;
		}

		// 获取批量处理按钮并禁用
		const batchBtn = this.containerEl.querySelector('.batch-process-btn') as HTMLButtonElement;
		if (batchBtn) {
			batchBtn.disabled = true;
			batchBtn.textContent = '处理中...';
			batchBtn.classList.add('processing');
		}

		try {
			new Notice(`开始处理 ${selectedParts.length} 个分P...`);

			const createdFiles: TFile[] = [];

			// 为每个选中的分P创建笔记
			for (const part of selectedParts) {
				const file = await this.createNoteForPart(part);
				if (file) {
					createdFiles.push(file);
				}
			}

			// 批量发送到n8n处理
			if (createdFiles.length > 0) {
				// 从分P列表中移除已创建的文件对应的分P
				for (const file of createdFiles) {
					// 查找对应的 VideoPart并移除
					// 这里假设文件名包含标题，但因为有重命名和时间戳，匹配可能不精确
					// 更好的方法是使用上面过滤出的 selectedParts
				}

				// 简单做法：移除所有选中的并成功创建的分P
				// 这里我们假设 createNoteForPart 返回 null 表示失败，返回 file 表示成功
				// 我们需要知道哪些 part 成功了

				// 更好的逻辑：
				// 在循环中处理
			}

			// 刷新视图显示新文件
			await this.refreshView();

			if (createdFiles.length > 0) {
				// 移除成功处理的 items
				this.videoParts = this.videoParts.filter(p => {
					const isSelected = (p as any).checkbox && (p as any).checkbox.checked;
					return !isSelected;
				});

				// 刷新分P列表
				this.renderPartsList();

				// 隐藏分P区域如果为空
				if (this.videoParts.length === 0) {
					const partsSection = (this as any).partsSectionEl;
					if (partsSection) partsSection.style.display = 'none';
				}

				new Notice(`成功创建 ${createdFiles.length} 个笔记，开始发送到n8n处理...`);
				await this.batchProcessFiles(createdFiles);
			}

			// 处理完成后再次刷新界面
			await this.refreshView();
		} catch (error) {
			new Notice(`批量处理失败: ${error.message}`);
		} finally {
			// 恢复按钮状态
			if (batchBtn) {
				batchBtn.disabled = false;
				batchBtn.textContent = '批量处理选中分P';
				batchBtn.classList.remove('processing');
			}
		}
	}

	private async createNoteForPart(part: VideoPart): Promise<TFile | null> {
		try {
			// 确定目标文件夹
			let targetFolder = '';

			// 优先使用用户设置的输出文件夹
			if (this.plugin.settings.outputFolder) {
				targetFolder = this.plugin.settings.outputFolder;
			} else {
				// 使用当前活跃文件的文件夹
				const activeFile = this.plugin.app.workspace.getActiveFile();
				if (activeFile) {
					// Fix for folder path
					const activePath = activeFile.path;
					const lastSlashIndex = activePath.lastIndexOf('/');
					if (lastSlashIndex > 0) {
						targetFolder = activePath.substring(0, lastSlashIndex);
					}
				}
			}

			// 生成文件名 (使用 clean title, 处理非法字符)
			const cleanTitle = part.title.replace(/[<>:"/\\|?*]/g, '_');
			let fileName = `${cleanTitle}.md`;

			// 检查文件是否存在，如果存在则添加数字后缀
			let targetPath = targetFolder ? `${targetFolder}/${fileName}` : fileName;
			let counter = 1;
			while (await this.plugin.app.vault.adapter.exists(targetPath)) {
				fileName = `${cleanTitle} (${counter}).md`;
				targetPath = targetFolder ? `${targetFolder}/${fileName}` : fileName;
				counter++;
			}

			const filePath = targetPath;

			// 生成YAML内容
			const now = new Date();
			const year = now.getFullYear();
			const month = String(now.getMonth() + 1).padStart(2, '0');
			const day = String(now.getDate()).padStart(2, '0');
			const hours = String(now.getHours()).padStart(2, '0');
			const minutes = String(now.getMinutes()).padStart(2, '0');
			const seconds = String(now.getSeconds()).padStart(2, '0');
			const dateString = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;

			// 构建YAML内容
			let yamlContent = `---
link: ${part.url}
status: pending
video_title: ${part.title}
date: ${dateString}`;

			// 添加提供的文稿（如果有）
			if (part.providedTranscript) {
				yamlContent += `\nprovided_transcript: |
  ${part.providedTranscript.replace(/\n/g, '\n  ')}`;
			}

			// 添加本地文件路径（如果有）
			if (part.localFiles && part.localFiles.length > 0) {
				// 如果是多个文件，写入逗号分隔的字符串
				yamlContent += `\nlocal_file: ${part.localFiles.join(', ')}`;
			} else if (part.localFileName) {
				yamlContent += `\nlocal_file: ${part.localFileName}`;
			}

			yamlContent += `\n---`;

			// 生成笔记内容
			const content = `${yamlContent}

# ${part.title}

## 基本信息
- **视频链接**: ${part.url}
- **创建时间**: ${now.toLocaleString('zh-CN')}
- **处理状态**: 待处理

## 视频内容
<!-- 视频总结将在这里生成 -->

## 笔记
<!-- 个人笔记将在这里生成 -->

## 文稿
<!-- 视频文稿将在这里生成 -->
`;

			// 创建文件
			const file = await this.plugin.app.vault.create(filePath, content);
			return file;
		} catch (error) {
			new Notice(`创建笔记失败: ${error.message}`);
			return null;
		}
	}

	private async batchProcessFiles(files: TFile[]) {
		if (files.length === 0) return;

		// 重置取消标志
		this.resetCancelFlag();

		// 将所有文件添加到处理中集合
		for (const file of files) {
			this.processingFiles.add(file.path);
		}

		const batchBtn = this.containerEl.querySelector('.batch-process-btn') as HTMLButtonElement;
		if (batchBtn) {
			batchBtn.disabled = true;
			batchBtn.textContent = '处理中...';
			batchBtn.classList.add('processing');
		}

		// 创建持续显示的状态通知
		const statusNotice = new Notice(`正在处理 ${files.length} 个文件...`, 0);
		const activeMode = this.getActiveProcessingMode();
		const activeLanguage = this.plugin.settings.defaultLanguage;

		try {
			const useCache = !this.ignoreCacheEnabled;
			// 用于记录处理失败的文件，后续统一重试
			const failedFiles: { file: TFile; request: any; index: number }[] = [];

			// 准备批量处理请求
			const requests: Array<{
				noteName: string;
				input: any;
				mode: ProcessingMode;
				language: 'zh' | 'en' | 'ja';
			}> = [];
			for (const file of files) {
				const metadata = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter || {};

				// 确保 link 是字符串
				let link = '';
				if ((metadata as any).link && Array.isArray((metadata as any).link) && (metadata as any).link.length > 0) {
					link = (metadata as any).link[0];
				} else if ((metadata as any).link && Array.isArray((metadata as any).link) && (metadata as any).link.length === 0) {
					link = "";
				} else if (typeof (metadata as any).link === 'string') {
					link = (metadata as any).link;
				}

				// 构建输入对象
				const input: any = {
					url: link
				};

				// 添加提供的文稿和本地文件信息
				if ((metadata as any).provided_transcript) {
					input.transcript = (metadata as any).provided_transcript;
				}
				if ((metadata as any).local_file) {
					input.localFile = (metadata as any).local_file;
				}

				requests.push({
					noteName: file.basename,
					input: input,
					mode: activeMode,
					language: activeLanguage
				});
			}

			// 设置所有文件为处理中状态
			for (const file of files) {
				await this.noteProcessor.setProcessingStatus(file, 'running');
			}

			// 调用批量处理API（使用实时回调）
			const results = await this.plugin.api.batchProcess(
				requests,
				this.plugin.settings.batchConcurrency,
				async (result) => {
					// 实时处理每个文件的结果
					const file = files[result.index];
					if (!file) return;

					try {
						if (result.success && result.result) {
							// 立即更新笔记内容
							await this.noteProcessor.updateNote(file, result.result, activeMode, {
								autoRename: this.plugin.settings.autoRenameEnabled,
								conflictStrategy: this.plugin.settings.renameConflictStrategy
							});

							// 设置成功状态
							await this.noteProcessor.setProcessingStatus(file, this.plugin.settings.successStatusValue ?? 'success');

							// 从处理中文件集合中移除
							this.processingFiles.delete(file.path);

							// 添加到历史记录
							this.addToHistory(file.basename, 'success', activeMode);

							// 更新状态通知
							statusNotice.setMessage(`✅ 已处理 ${result.index + 1}/${files.length}: ${file.basename}`);
						} else {
							// 处理失败，记录到重试列表
							failedFiles.push({
								file,
								request: requests[result.index],
								index: result.index
							});

							// 更新状态通知
							statusNotice.setMessage(`❌ 处理失败 ${result.index + 1}/${files.length}: ${file.basename} - ${result.error}`);
						}
					} catch (error) {
						// 处理单个文件更新失败，记录到重试列表
						failedFiles.push({
							file,
							request: requests[result.index],
							index: result.index
						});

						// 更新状态通知
						statusNotice.setMessage(`❌ 更新失败 ${result.index + 1}/${files.length}: ${file.basename} - ${error.message}`);
					}
				},
				useCache
			);

			// 检查是否被取消
			if (this.shouldCancelProcessing()) {
				statusNotice.setMessage('❌ 处理已被取消');
				statusNotice.hide();
				return;
			}

			// 注意：不需要遍历 results 数组再更新一次笔记，
			// 因为在 batchProcess 传入的 onProgress 回调中，
			// 所有的更新文件逻辑（updateNote）、成功和失败的错误记录（push 到 failedFiles）
			// 均已经执行完毕，如果这里再遍历会导致已成功的文件重复更新报错并引发异常重试。


			// failedFiles will be logged or handled manually by the user. 
			// We removed the automatic retry loop here because it caused 
			// the plugin to send 2 extra requests (3 total) when the server 
			// timed out (e.g. 504), causing n8n to process the same video 3 times.

			// 保存设置以更新历史记录
			await this.plugin.saveSettings();

			// 显示最终结果
			const successCount = results.filter(r => r.success).length;
			const errorCount = results.length - successCount;

			if (errorCount === 0) {
				statusNotice.setMessage(`✅ 批量处理完成！成功处理 ${successCount} 个文件`);
			} else {
				statusNotice.setMessage(`⚠️ 批量处理完成！成功 ${successCount} 个，失败 ${errorCount} 个`);
			}

			// 3秒后关闭通知
			setTimeout(() => {
				statusNotice.hide();
			}, 3000);

		} catch (error) {
			// 处理批量处理失败
			statusNotice.setMessage(`❌ 批量处理失败: ${error.message}`);

			// 将所有文件状态设为错误
			for (const file of files) {
				await this.noteProcessor.setProcessingStatus(file, 'error');
				this.addToHistory(file.basename, 'error', activeMode);
			}

			await this.plugin.saveSettings();

			// 5秒后关闭错误通知
			setTimeout(() => {
				statusNotice.hide();
			}, 5000);
		} finally {
			// 清理处理中文件集合
			for (const file of files) {
				this.processingFiles.delete(file.path);
			}

			// 恢复按钮状态
			if (batchBtn) {
				batchBtn.disabled = false;
				batchBtn.textContent = '批量处理选中分P';
				batchBtn.classList.remove('processing');
			}

			// 刷新界面以显示最新状态
			await this.refreshView();
		}
	}

	private addToHistory(fileName: string, result: 'success' | 'error', mode: ProcessingMode) {
		const historyRecord = {
			file: fileName,
			time: new Date().toLocaleString('zh-CN'),
			result: result,
			mode: mode
		};

		// 添加到历史记录
		this.plugin.settings.history.push(historyRecord);
	}

	private async processSingleVideo(url: string, providedTranscript: string, localFile: string) {
		try {
			let title = '';
			let videoId = '';

			// 如果有视频链接，尝试提取视频ID
			if (url && url.trim()) {
				const extractedVideoId = this.extractVideoId(url);
				if (!extractedVideoId) {
					new Notice('无法识别视频链接格式');
					return;
				}
				videoId = extractedVideoId;
				title = this.generateVideoTitle(url, videoId);
			} else if (providedTranscript && providedTranscript.trim()) {
				// 如果只有文稿，生成文稿处理的标题
				const now = new Date();
				const timeStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
				const snippet = providedTranscript.trim().split('\n')[0].substring(0, 12).replace(/[<>:"/\\|?*\s]/g, '_');
				title = snippet ? `文稿_${timeStr}_${snippet}` : `文稿处理_${timeStr}`;
			} else if (localFile && localFile.trim()) {
				// 如果只有本地文件，生成本地文件处理的标题
				const fileName = localFile.split('/').pop() || localFile.split('\\').pop() || 'local_file';
				title = '本地文件_' + fileName;
			} else {
				new Notice('请提供视频链接、文稿内容或本地文件路径');
				return;
			}

			// 创建单个视频的VideoPart
			this.videoParts = [{
				title: title,
				url: url || '',
				index: 1,
				isCurrent: false,
				providedTranscript: providedTranscript,
				localFileName: localFile
			}];

			// 显示分P列表（单个视频）
			const partsSection = this.containerEl.querySelector('.parts-section') as HTMLElement;
			if (partsSection) {
				partsSection.style.display = 'block';
			}

			this.renderPartsList();
			new Notice(`已准备处理: ${title}`);
		} catch (error) {
			new Notice(`处理失败: ${error.message}`);
		}
	}

	private async processMultipleVideos(urls: string[], providedTranscript: string, localFile: string) {
		try {
			new Notice(`正在处理 ${urls.length} 个视频链接...`);

			// 为每个链接创建VideoPart
			this.videoParts = [];
			for (let i = 0; i < urls.length; i++) {
				const url = urls[i];
				const videoId = this.extractVideoId(url);
				if (!videoId) {
					new Notice(`无法识别第 ${i + 1} 个链接格式: ${url}`);
					continue;
				}

				const title = this.generateVideoTitle(url, videoId);
				this.videoParts.push({
					title: title,
					url: url,
					index: i + 1,
					isCurrent: false,
					providedTranscript: providedTranscript,
					localFileName: localFile
				});
			}

			if (this.videoParts.length === 0) {
				new Notice('没有有效的视频链接');
				return;
			}

			// 显示分P列表（多个视频）
			const partsSection = this.containerEl.querySelector('.parts-section') as HTMLElement;
			if (partsSection) {
				partsSection.style.display = 'block';
			}

			this.renderPartsList();
			new Notice(`已准备处理 ${this.videoParts.length} 个视频`);
		} catch (error) {
			new Notice(`处理失败: ${error.message}`);
		}
	}

	private generateVideoTitle(url: string, videoId: string): string {
		// 根据平台生成标题
		if (url.includes('bilibili.com')) {
			return `B站视频_${videoId}`;
		} else if (url.includes('youtube.com') || url.includes('youtu.be')) {
			return `YouTube视频_${videoId}`;
		} else if (url.includes('douyin.com')) {
			return `抖音视频_${videoId}`;
		} else if (url.includes('tiktok.com')) {
			return `TikTok视频_${videoId}`;
		} else {
			return `视频_${videoId}`;
		}
	}

	// 删除统计信息和批量处理按钮相关方法

	private async renderFileList(container: HTMLElement) {
		const listEl = container.createEl('div', { cls: 'file-list-section' });

		// 标题和排序按钮在同一行 - 使用更紧凑的标题
		const titleRow = listEl.createEl('div', { cls: 'title-row' });
		// titleRow.createEl('h3', { text: '视频笔记' });

		// 排序按钮
		const sortSelect = titleRow.createEl('select', { cls: 'sort-select-inline' });
		sortSelect.createEl('option', { text: '文件名A-Z', value: 'name-asc' });
		sortSelect.createEl('option', { text: '文件名Z-A', value: 'name-desc' });
		sortSelect.createEl('option', { text: '创建时间（最新）', value: 'ctime-desc' });
		sortSelect.createEl('option', { text: '创建时间（最早）', value: 'ctime-asc' });
		sortSelect.createEl('option', { text: '修改时间（最新）', value: 'mtime-desc' });
		sortSelect.createEl('option', { text: '修改时间（最早）', value: 'mtime-asc' });
		sortSelect.createEl('option', { text: '状态优先', value: 'status' });

		// 默认选择创建时间（最新）
		sortSelect.value = 'ctime-desc';

		const files = this.plugin.app.vault.getMarkdownFiles();
		const videoFiles: Array<{ file: TFile; status: string; content: string }> = [];

		for (const file of files) {
			try {
				const content = await this.plugin.app.vault.read(file);
				const hasVideo = this.noteProcessor.hasVideoContent(content);
				if (hasVideo) {
					const status = this.noteProcessor.getProcessingStatus(content);
					videoFiles.push({
						file,
						status: status || 'pending',
						content
					});
				}
			} catch (error) {
				console.error(`读取文件失败: ${file.basename}`, error);
			}
		}

		if (videoFiles.length === 0) {
			listEl.createEl('p', { text: '未找到视频笔记', cls: 'no-files' });
			return;
		}

		// 排序功能
		const sortFiles = () => {
			const sortBy = sortSelect.value;
			let sortedFiles = [...videoFiles];

			switch (sortBy) {
				case 'name-asc':
					sortedFiles.sort((a, b) => a.file.basename.localeCompare(b.file.basename));
					break;
				case 'name-desc':
					sortedFiles.sort((a, b) => b.file.basename.localeCompare(a.file.basename));
					break;
				case 'ctime-desc':
					sortedFiles.sort((a, b) => b.file.stat.ctime - a.file.stat.ctime);
					break;
				case 'ctime-asc':
					sortedFiles.sort((a, b) => a.file.stat.ctime - b.file.stat.ctime);
					break;
				case 'mtime-desc':
					sortedFiles.sort((a, b) => b.file.stat.mtime - a.file.stat.mtime);
					break;
				case 'mtime-asc':
					sortedFiles.sort((a, b) => a.file.stat.mtime - b.file.stat.mtime);
					break;
				case 'status':
					// 按状态排序：待处理 -> 处理中 -> 已处理 -> 错误
					const statusOrder: { [key: string]: number } = { 'pending': 0, 'running': 1, 'success': 2, 'error': 3 };
					sortedFiles.sort((a, b) => {
						const aOrder = statusOrder[a.status] ?? 4;
						const bOrder = statusOrder[b.status] ?? 4;
						if (aOrder !== bOrder) return aOrder - bOrder;
						return a.file.basename.localeCompare(b.file.basename);
					});
					break;
			}

			// 重新渲染文件列表
			this.renderSortedFileList(listEl, sortedFiles);
		};

		// 绑定排序事件
		sortSelect.onchange = sortFiles;

		// 初始渲染
		sortFiles();
	}

	private renderSortedFileList(container: HTMLElement, sortedFiles: Array<{ file: TFile; status: string; content: string }>) {
		// 移除现有的文件列表
		const existingLists = container.querySelectorAll('.file-list');
		existingLists.forEach(list => list.remove());

		// 按状态分组显示
		const pendingFiles = sortedFiles.filter(f => {
			const status = f.status || '';
			// 待处理：只有 pending 或者没有 status
			return !status || status === 'pending';
		});
		const runningFiles = sortedFiles.filter(f => f.status === 'running');
		const errorFiles = sortedFiles.filter(f => f.status === 'error');
		const processedFiles = sortedFiles.filter(f => {
			const status = f.status || '';
			// 已处理：除了 pending、running、error 和空状态之外的所有状态
			return status && status !== 'pending' && status !== 'running' && status !== 'error';
		});

		// 待处理文件
		if (pendingFiles.length > 0) {
			container.createEl('div', { text: `待处理 (${pendingFiles.length})`, cls: 'section-title-small' });
			this.renderFileGroup(container, pendingFiles, 'pending');
		}

		// 处理中文件
		if (runningFiles.length > 0) {
			container.createEl('div', { text: `处理中 (${runningFiles.length})`, cls: 'section-title-small' });
			this.renderFileGroup(container, runningFiles, 'running');
		}

		// 错误文件
		if (errorFiles.length > 0) {
			container.createEl('div', { text: `处理失败 (${errorFiles.length})`, cls: 'section-title-small' });
			this.renderFileGroup(container, errorFiles, 'error');
		}

		// 已处理文件
		if (processedFiles.length > 0) {
			container.createEl('div', { text: `已处理 (${processedFiles.length})`, cls: 'section-title-small' });
			this.renderFileGroup(container, processedFiles, 'processed');
		}
	}

	private renderFileGroup(container: HTMLElement, files: Array<{ file: TFile; status: string; content: string }>, groupType: string): HTMLElement {
		const fileList = container.createEl('div', { cls: 'file-list-container' });

		files.forEach(({ file, status, content }) => {
			const itemEl = fileList.createEl('div', { cls: 'file-list-item' });

			// 左侧：文件名和状态
			const infoMain = itemEl.createEl('div', { cls: 'file-info-main' });

			// 状态小药丸 (Pill)
			let statusClass = 'pending';
			let statusText = '待处理';
			const normalizedStatus = VideoUtils.normalizeStatus(status || '');
			if (normalizedStatus === 'success') {
				statusClass = 'success';
				statusText = '已完成';
			} else if (normalizedStatus === 'error') {
				statusClass = 'error';
				statusText = '失败';
			} else if (normalizedStatus === 'running') {
				statusClass = 'pending';
				statusText = '处理中...';
			}

			infoMain.createEl('span', { text: statusText, cls: `status-pill ${statusClass}` });

			// 文件名
			const nameSpan = infoMain.createEl('span', { text: file.basename, cls: 'file-title' });
			// 点击文件名打开
			nameSpan.style.cursor = 'pointer';
			nameSpan.onclick = () => this.plugin.app.workspace.getLeaf().openFile(file);

			// 右侧：动作图标 (悬停显示更好)
			const actionsEl = itemEl.createEl('div', { cls: 'item-actions' });

			if (normalizedStatus !== 'running') {
				if (groupType === 'pending' || groupType === 'error') {
					const processBtn = actionsEl.createEl('button', {
						cls: 'clickable-icon',
						attr: { 'aria-label': '处理' }
					});
					processBtn.innerHTML = '▶️';
					processBtn.onclick = () => this.handleProcessAction(file);
				} else if (groupType === 'processed') {
					const reprocessBtn = actionsEl.createEl('button', {
						cls: 'clickable-icon',
						attr: { 'aria-label': '重新处理' }
					});
					reprocessBtn.innerHTML = '🔄';
					reprocessBtn.onclick = () => this.handleProcessAction(file);
				}
			} else {
				const cancelBtn = actionsEl.createEl('button', {
					cls: 'clickable-icon',
					attr: { 'aria-label': '取消' }
				});
				cancelBtn.innerHTML = '❌';
				cancelBtn.onclick = async () => {
					try { this.plugin.api.cancelByNoteName(file.basename); } catch { }
					this.cancelProcessing = true;
					await this.cancelFileProcessing(file);
				};
			}

			// 快捷删除按钮
			const deleteBtn = actionsEl.createEl('button', {
				cls: 'clickable-icon',
				attr: { 'aria-label': '删除笔记' }
			});
			deleteBtn.innerHTML = '🗑️';
			deleteBtn.onclick = () => this.quickDeleteFile(file);
		});
		return fileList;
	}

	private renderHistory(container: HTMLElement) {
		const historyEl = container.createEl('div', { cls: 'history-section' });

		// 标题和排序按钮在同一行 - 使用更紧凑的标题
		const titleRow = historyEl.createEl('div', { cls: 'title-row' });
		// titleRow.createEl('h3', { text: '处理历史' });

		// 刷新按钮 - 总是显示
		const refreshBtn = titleRow.createEl('button', {
			text: '🔄',
			cls: 'action-btn icon-btn history-refresh-btn',
			attr: { title: '刷新历史记录' }
		});
		refreshBtn.onclick = () => {
			// 重新渲染历史记录
			this.renderHistory(container);
		};

		// 删除历史记录按钮
		const deleteHistoryBtn = titleRow.createEl('button', {
			text: '🗑️ 删除历史',
			cls: 'action-btn history-delete-btn',
			attr: { title: '删除所有历史记录' }
		});
		deleteHistoryBtn.onclick = async () => {
			if (confirm('确定要删除所有历史记录吗？')) {
				this.plugin.settings.history = [];
				await this.plugin.saveSettings();
				new Notice('历史记录已删除');
				this.renderHistory(container);
			}
		};

		// 清空缓存按钮
		const clearCacheBtn = titleRow.createEl('button', {
			text: '🗄️ 清空缓存',
			cls: 'action-btn history-clear-cache-btn',
			attr: { title: '清空所有缓存' }
		});
		clearCacheBtn.onclick = async () => {
			if (confirm('确定要清空所有缓存吗？这将删除所有已缓存的视频处理结果。')) {
				try {
					await this.plugin.api.clearCache();
					new Notice('缓存已清空');
				} catch (error) {
					new Notice(`清空缓存失败: ${error.message}`);
				}
			}
		};

		if (!this.plugin.settings.history || this.plugin.settings.history.length === 0) {
			historyEl.createEl('p', { text: '暂无处理历史', cls: 'no-history' });
			return;
		}

		// 排序按钮
		const sortSelect = titleRow.createEl('select', { cls: 'sort-select-inline' });
		sortSelect.createEl('option', { text: '创建时间（最新）', value: 'time-desc' });
		sortSelect.createEl('option', { text: '创建时间（最早）', value: 'time-asc' });
		sortSelect.createEl('option', { text: '文件名A-Z', value: 'name-asc' });
		sortSelect.createEl('option', { text: '文件名Z-A', value: 'name-desc' });
		sortSelect.createEl('option', { text: '成功优先', value: 'success-first' });
		sortSelect.createEl('option', { text: '失败优先', value: 'error-first' });

		// 使用保存的排序设置，如果没有则使用默认值
		const savedHistorySortBy = this.plugin.settings.historySortBy || 'time-desc';
		sortSelect.value = savedHistorySortBy;

		// 排序功能
		const sortHistory = () => {
			const sortBy = sortSelect.value;
			let sortedHistory = [...this.plugin.settings.history];

			switch (sortBy) {
				case 'time-desc':
					sortedHistory.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
					break;
				case 'time-asc':
					sortedHistory.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
					break;
				case 'name-asc':
					sortedHistory.sort((a, b) => a.file.localeCompare(b.file));
					break;
				case 'name-desc':
					sortedHistory.sort((a, b) => b.file.localeCompare(a.file));
					break;
				case 'success-first':
					sortedHistory.sort((a, b) => {
						if (a.result === 'success' && b.result !== 'success') return -1;
						if (a.result !== 'success' && b.result === 'success') return 1;
						return new Date(b.time).getTime() - new Date(a.time).getTime();
					});
					break;
				case 'error-first':
					sortedHistory.sort((a, b) => {
						if (a.result === 'error' && b.result !== 'error') return -1;
						if (a.result !== 'error' && b.result === 'error') return 1;
						return new Date(b.time).getTime() - new Date(a.time).getTime();
					});
					break;
			}

			// 保存排序设置
			this.plugin.settings.historySortBy = sortBy;
			this.plugin.saveSettings();

			// 重新渲染历史记录
			this.renderHistoryList(historyEl, sortedHistory);
		};

		// 绑定排序事件
		sortSelect.onchange = sortHistory;

		// 初始渲染
		sortHistory();
	}

	private renderHistoryList(container: HTMLElement, history: any[]) {
		// 移除现有的历史记录列表
		const existingList = container.querySelector('.history-list');
		if (existingList) {
			existingList.remove();
		}

		// 创建新的历史记录列表
		const historyList = container.createEl('div', { cls: 'history-list' });

		history.forEach(record => {
			const historyItem = historyList.createEl('div', { cls: 'history-item' });

			historyItem.createEl('span', {
				text: record.result === 'success' ? '✅' : '❌',
				cls: 'history-status'
			});

			// 文件名（可点击跳转）
			const fileNameEl = historyItem.createEl('span', {
				text: record.file,
				cls: 'history-file clickable'
			});

			// 添加点击跳转功能
			fileNameEl.onclick = async () => {
				try {
					// 尝试多种方式查找文件
					let file: TFile | null = null;

					// 方法1：直接通过文件名查找
					file = this.plugin.app.vault.getAbstractFileByPath(`${record.file}.md`) as TFile;

					// 方法2：如果方法1失败，搜索所有markdown文件
					if (!file) {
						const allFiles = this.plugin.app.vault.getMarkdownFiles();
						file = allFiles.find(f => f.basename === record.file) || null;
					}

					// 方法3：如果方法2失败，尝试模糊匹配
					if (!file) {
						const allFiles = this.plugin.app.vault.getMarkdownFiles();
						file = allFiles.find(f => f.basename.includes(record.file) || record.file.includes(f.basename)) || null;
					}

					if (file && file instanceof TFile) {
						// 打开文件
						const leaf = this.plugin.app.workspace.getLeaf();
						await leaf.openFile(file);
						new Notice(`已打开文件: ${file.basename}`);
					} else {
						// 显示更详细的错误信息
						const allFiles = this.plugin.app.vault.getMarkdownFiles();
						const similarFiles = allFiles.filter(f =>
							f.basename.toLowerCase().includes(record.file.toLowerCase()) ||
							record.file.toLowerCase().includes(f.basename.toLowerCase())
						).slice(0, 5);

						if (similarFiles.length > 0) {
							const similarNames = similarFiles.map(f => f.basename).join(', ');
							new Notice(`文件不存在: ${record.file}\n相似文件: ${similarNames}`);
						} else {
							new Notice(`文件不存在: ${record.file}`);
						}
					}
				} catch (error) {
					new Notice(`打开文件失败: ${error.message}`);
				}
			};

			// 显示模式和语言信息
			const infoEl = historyItem.createEl('span', {
				cls: 'history-info'
			});
			const modeText = record.mode === 'summary' ? '总结' : record.mode === 'transcript-only' ? '文稿' : '信息';
			const langText = record.language === 'zh' ? '中文' : record.language === 'en' ? '英文' : record.language === 'ja' ? '日文' : '中文';
			infoEl.textContent = `${modeText} (${langText})`;

			historyItem.createEl('span', {
				text: record.time,
				cls: 'history-time'
			});

			// 操作按钮容器
			const actionsEl = historyItem.createEl('div', { cls: 'history-actions' });

			// 删除单条历史记录按钮（同步删除缓存）
			const deleteBtn = actionsEl.createEl('button', {
				text: '🗑️',
				cls: 'btn-small history-delete-item-btn',
				attr: { title: '删除此条历史记录和缓存' }
			});
			deleteBtn.onclick = async () => {
				if (confirm(`确定要删除历史记录 "${record.file}" 及其缓存吗？`)) {
					try {
						// 查找文件以获取视频链接
						let file: TFile | null = null;
						file = this.plugin.app.vault.getAbstractFileByPath(`${record.file}.md`) as TFile;

						if (!file) {
							const allFiles = this.plugin.app.vault.getMarkdownFiles();
							file = allFiles.find(f => f.basename === record.file) || null;
						}

						// 如果找到文件，尝试删除对应的缓存
						if (file) {
							try {
								const content = await this.plugin.app.vault.read(file);
								const url = this.noteProcessor.extractVideoUrl(content);
								if (url && record.mode && record.language) {
									// 删除缓存
									await this.plugin.api.removeCacheItem(
										url,
										record.mode as any,
										record.language as any
									);
								}
							} catch (error) {
								console.error('删除缓存失败:', error);
							}
						}

						// 删除历史记录
						const index = this.plugin.settings.history.findIndex(
							h => h.file === record.file && h.time === record.time
						);
						if (index !== -1) {
							this.plugin.settings.history.splice(index, 1);
							await this.plugin.saveSettings();
							new Notice('历史记录和缓存已删除');
							this.renderHistory(container);
						}
					} catch (error) {
						new Notice(`删除失败: ${error.message}`);
					}
				}
			};
		});
	}

	private async processFile(file: TFile) {
		await this.plugin.fileProcessor.processFile(file);
		// 刷新界面以显示最新状态
		await this.refreshView();
	}

	private async handleProcessAction(file: TFile) {
		if (this.ignoreCacheEnabled) {
			await this.forceRefreshFile(file);
			return;
		}
		await this.processFile(file);
	}

	/**
	 * 强制刷新文件（不使用缓存）
	 */
	private async forceRefreshFile(file: TFile) {
		try {
			const content = await this.plugin.app.vault.read(file);

			// 构建视频输入
			const videoInput = this.noteProcessor.buildVideoInput(content);

			if (!videoInput.url && !videoInput.transcript && !videoInput.localFile) {
				new Notice('文件中没有找到视频链接、文稿或本地文件');
				return;
			}

			// 设置处理状态
			await this.noteProcessor.setProcessingStatus(file, 'running');

			// 显示进度通知
			const notice = new Notice('🔄 正在强制刷新（不使用缓存）...', 0);

			try {
				const mode = this.getActiveProcessingMode();
				const language = this.plugin.settings.defaultLanguage;
				// 强制刷新：useCache = false
				const result = await this.plugin.api.processVideo(
					file.basename,
					videoInput,
					mode,
					language,
					false // 不使用缓存，强制刷新
				);

				// 更新笔记
				await this.noteProcessor.updateNote(
					file,
					result,
					mode,
					{
						autoRename: this.plugin.settings.autoRenameEnabled,
						conflictStrategy: this.plugin.settings.renameConflictStrategy
					}
				);

				// 设置成功状态
				await this.noteProcessor.setProcessingStatus(file, this.plugin.settings.successStatusValue ?? 'success');

				notice.hide();
				new Notice('✅ 强制刷新完成', 3000);

				// 刷新视图
				await this.refreshView();
			} catch (error) {
				notice.hide();
				await this.noteProcessor.setProcessingStatus(file, 'error');
				new Notice(`❌ 强制刷新失败: ${error.message}`, 5000);
			}
		} catch (error) {
			new Notice(`强制刷新失败: ${error.message}`);
		}
	}

	private async quickDeleteFile(file: TFile) {
		try {
			const confirmed = await this.confirmDelete(file);
			if (!confirmed) return;
			await this.plugin.app.vault.trash(file, true);
			new Notice(`🗑️ 已删除 ${file.basename}`);
			await this.refreshView();
		} catch (error) {
			new Notice(`删除失败: ${error.message}`);
		}
	}

	private async confirmDelete(file: TFile): Promise<boolean> {
		return await new Promise((resolve) => {
			new ConfirmModal(
				this.plugin.app,
				'删除笔记',
				`确定要删除 "${file.basename}" 吗？此操作不可撤销。`,
				resolve
			).open();
		});
	}

	/**
	 * 处理获取上次webhook结果
	 */
	private async processJsonInput(jsonText: string) {
		try {
			const parsed = JSON.parse(jsonText);
			const normalizedResult = this.plugin.api.normalizeWebhookPayload(parsed);
			const input = this.extractVideoInputFromPayload(parsed);
			await this.createNoteFromWebhookResult({
				result: normalizedResult,
				input,
				mode: 'summary',
				language: this.plugin.settings.defaultLanguage,
				timestamp: Date.now(),
			});
			new Notice('✅ 已根据 JSON 创建笔记');
		} catch (error) {
			new Notice(`解析失败: ${error.message}`);
		}
	}

	private async handleGetLastResult() {
		try {
			const history = this.plugin.api.getWebhookHistory();

			if (!history || history.length === 0) {
				new Notice('暂时没有可复用的 webhook 结果');
				return;
			}

			const modal = new Modal(this.plugin.app);
			modal.titleEl.textContent = 'Webhook 历史结果（最近50条）';

			const list = modal.contentEl.createEl('div', { cls: 'webhook-history-list' });
			list.style.maxHeight = '420px';
			list.style.overflowY = 'auto';

			history.forEach((entry, index) => {
				const item = list.createEl('div', { cls: 'webhook-history-item' });
				item.createEl('div', {
					text: `${index + 1}. ${new Date(entry.timestamp).toLocaleString('zh-CN')} · ${entry.mode === 'summary' ? '总结' : entry.mode === 'transcript-only' ? '文稿' : '信息'
						} (${entry.language})`,
					cls: 'history-meta',
				});
				if (entry.input.url) {
					item.createEl('div', {
						text: entry.input.url,
						cls: 'history-link',
					});
				}
				if (entry.result.video_title || entry.result.video_author) {
					item.createEl('div', {
						text: `${entry.result.video_title ?? ''}${entry.result.video_author ? ` · ${entry.result.video_author}` : ''}`,
						cls: 'history-title',
					});
				}

				const actions = item.createEl('div', { cls: 'history-actions' });

				const applyBtn = actions.createEl('button', { text: '应用到当前文件', cls: 'mod-cta' });
				applyBtn.onclick = async () => {
					await this.applyResultToCurrentFile(entry);
				};

				const insertBtn = actions.createEl('button', { text: '插入到当前笔记', cls: 'mod-secondary' });
				insertBtn.onclick = async () => {
					await this.insertResultIntoCurrentFile(entry);
				};

				const newNoteBtn = actions.createEl('button', { text: '新建笔记', cls: 'mod-secondary' });
				newNoteBtn.onclick = async () => {
					await this.createNoteFromWebhookResult(entry);
				};

				const copyBtn = actions.createEl('button', { text: '复制JSON', cls: 'mod-secondary' });
				copyBtn.onclick = async () => {
					try {
						await navigator.clipboard.writeText(JSON.stringify(entry.result, null, 2));
						new Notice('✅ 结果已复制到剪贴板');
					} catch (error) {
						new Notice(`复制失败: ${error.message}`);
					}
				};
			});

			const footer = modal.contentEl.createEl('div', { cls: 'webhook-history-footer' });
			footer.textContent = '提示：历史结果保留最新20条，后续调用会自动替换最早的记录。';

			modal.open();
		} catch (error) {
			new Notice(`获取上次结果失败: ${error.message}`);
		}
	}

	private async applyResultToCurrentFile(entry: {
		result: ProcessingResult;
		mode: ProcessingMode;
	}) {
		const activeFile = this.plugin.app.workspace.getActiveFile();
		if (!activeFile) {
			new Notice('请先打开一个文件');
			return;
		}

		try {
			await this.noteProcessor.updateNote(activeFile, entry.result, entry.mode, {
				autoRename: this.plugin.settings.autoRenameEnabled,
				conflictStrategy: this.plugin.settings.renameConflictStrategy,
			});
			await this.noteProcessor.setProcessingStatus(activeFile, this.plugin.settings.successStatusValue ?? 'success');
			new Notice('✅ 已应用到当前文件');
			await this.refreshView();
		} catch (error) {
			new Notice(`应用失败: ${error.message}`);
		}
	}

	private async insertResultIntoCurrentFile(entry: { result: ProcessingResult }) {
		const activeFile = this.plugin.app.workspace.getActiveFile();
		if (!activeFile) {
			new Notice('请先打开一个文件');
			return;
		}

		try {
			const content = await this.plugin.app.vault.read(activeFile);
			const insertion = this.buildInsertionContent(entry.result);
			const newContent = `${content.trim()}\n\n${insertion}`;
			await this.plugin.app.vault.modify(activeFile, newContent);
			new Notice('✅ 信息已插入当前笔记');
		} catch (error) {
			new Notice(`插入失败: ${error.message}`);
		}
	}

	private buildInsertionContent(result: ProcessingResult) {
		const lines: string[] = [];
		lines.push('---');
		lines.push('## Webhook 结果');
		if (result.video_title) lines.push(`- **标题**: ${result.video_title}`);
		if (result.video_author) lines.push(`- **作者**: ${result.video_author}`);
		if (result.video_duration) lines.push(`- **时长**: ${result.video_duration}`);
		if (result.summary) {
			lines.push('');
			lines.push('### 总结');
			lines.push(result.summary);
		}
		if (result.note) {
			lines.push('');
			lines.push('### 大纲');
			lines.push(result.note);
		}
		if (result.video_transcript) {
			lines.push('');
			lines.push('### 文稿');
			lines.push(result.video_transcript);
		}
		lines.push('---');
		return lines.join('\n');
	}

	private async createNoteFromWebhookResult(entry: {
		result: ProcessingResult;
		input: VideoInput;
		mode: ProcessingMode;
		language: SupportedLanguage;
		timestamp: number;
	}) {
		try {
			const folder = this.plugin.settings.outputFolder || this.plugin.app.workspace.getActiveFile()?.parent?.path || '';
			const baseTitle =
				entry.result.video_title ||
				(entry.input.url ? this.generateVideoTitle(entry.input.url, this.extractVideoId(entry.input.url) || 'video') : 'Webhook结果');
			const fileName = `${this.sanitizeFileName(baseTitle)}_${entry.timestamp}.md`;
			const filePath = folder ? `${folder}/${fileName}` : fileName;

			const fm: string[] = ['---'];
			fm.push(`status: ${this.plugin.settings.successStatusValue ?? 'success'}`);
			if (entry.input.url) fm.push(`link: ${this.yamlEscape(entry.input.url)}`);
			if (entry.result.video_title) fm.push(`video_title: ${this.yamlEscape(entry.result.video_title)}`);
			if (entry.result.video_author) fm.push(`video_author: ${this.yamlEscape(entry.result.video_author)}`);
			if (entry.result.video_duration) fm.push(`video_duration: ${this.yamlEscape(entry.result.video_duration)}`);
			fm.push(`date: ${new Date(entry.timestamp).toISOString()}`);
			if (entry.result.summary) {
				fm.push('summary: |');
				fm.push(`  ${entry.result.summary.replace(/\n/g, '\n  ')}`);
			}
			if (entry.result.video_transcript) {
				fm.push('video_transcript: |');
				fm.push(`  ${entry.result.video_transcript.replace(/\n/g, '\n  ')}`);
			}
			fm.push('---\n');

			const noteContent = entry.result.note?.trim() ?? '';
			const content = `${fm.join('\n')}${noteContent}`;

			await this.plugin.app.vault.create(filePath, content);
			new Notice(`✅ 已创建笔记: ${fileName}`);
		} catch (error) {
			new Notice(`创建笔记失败: ${error.message}`);
		}
	}

	private sanitizeFileName(name: string) {
		return name.replace(/[<>:"/\\|?*]/g, '_').trim() || 'webhook_result';
	}

	private yamlEscape(value: string) {
		const trimmed = value.trim();
		if (!trimmed) return '""';
		const needsQuotes = /[:\[\]{}#,&*!?|<>=@`]/.test(trimmed);
		const escaped = trimmed.replace(/"/g, '\\"');
		return needsQuotes ? `"${escaped}"` : escaped;
	}

	private extractVideoInputFromPayload(raw: any): VideoInput {
		const sources: any[] = [];
		const collectSources = (obj: any) => {
			if (!obj || typeof obj !== 'object') return;
			sources.push(obj);
			if (obj.metadata && typeof obj.metadata === 'object') sources.push(obj.metadata);
			if (obj.input && typeof obj.input === 'object') sources.push(obj.input);
		};
		if (Array.isArray(raw)) {
			raw.forEach(collectSources);
		} else {
			collectSources(raw);
		}

		const pick = (keys: string[]) => {
			for (const source of sources) {
				for (const key of keys) {
					const value = source[key];
					if (typeof value === 'string' && value.trim()) {
						return value.trim();
					}
				}
			}
			return undefined;
		};

		const input: VideoInput = {};
		const link = pick(['link', 'url']);
		if (link) input.url = link;
		const transcript = pick(['provided_transcript', 'transcript']);
		if (transcript) input.transcript = transcript;
		const localFile = pick(['local_file', 'localFile']);
		if (localFile) input.localFile = localFile;
		return input;
	}

	/**
	 * 强制刷新历史记录（重新处理但不使用缓存）
	 */
	private async forceRefreshRecord(record: any) {
		try {
			// 查找文件
			let file: TFile | null = null;
			file = this.plugin.app.vault.getAbstractFileByPath(`${record.file}.md`) as TFile;

			if (!file) {
				const allFiles = this.plugin.app.vault.getMarkdownFiles();
				file = allFiles.find(f => f.basename === record.file) || null;
			}

			if (!file) {
				const allFiles = this.plugin.app.vault.getMarkdownFiles();
				file = allFiles.find(f => f.basename.includes(record.file) || record.file.includes(f.basename)) || null;
			}

			if (!file) {
				new Notice(`找不到文件: ${record.file}`);
				return;
			}

			// 读取文件内容
			const content = await this.plugin.app.vault.read(file);

			// 构建视频输入
			const videoInput = this.noteProcessor.buildVideoInput(content);

			if (!videoInput.url && !videoInput.transcript && !videoInput.localFile) {
				new Notice('文件中没有找到视频链接、文稿或本地文件');
				return;
			}

			// 设置处理状态
			await this.noteProcessor.setProcessingStatus(file, 'running');

			// 显示进度通知
			const langText = record.language === 'zh' ? '中文' : record.language === 'en' ? '英文' : record.language === 'ja' ? '日文' : '中文';
			const modeText = record.mode === 'summary' ? '总结' : record.mode === 'transcript-only' ? '文稿' : '信息';
			const notice = new Notice(`🔄 正在强制刷新（不使用缓存）: ${modeText} (${langText})...`, 0);

			try {
				// 强制刷新：useCache = false
				const result = await this.plugin.api.processVideo(
					file.basename,
					videoInput,
					record.mode || 'summary',
					record.language || 'zh',
					false // 不使用缓存，强制刷新
				);

				// 更新笔记
				await this.noteProcessor.updateNote(
					file,
					result,
					record.mode || 'summary',
					{
						autoRename: this.plugin.settings.autoRenameEnabled,
						conflictStrategy: this.plugin.settings.renameConflictStrategy
					}
				);

				// 设置成功状态
				await this.noteProcessor.setProcessingStatus(file, this.plugin.settings.successStatusValue ?? 'success');

				// 更新历史记录
				const index = this.plugin.settings.history.findIndex(
					h => h.file === record.file && h.time === record.time
				);
				if (index !== -1) {
					this.plugin.settings.history[index] = {
						...this.plugin.settings.history[index],
						time: new Date().toLocaleString(),
						result: 'success'
					};
					await this.plugin.saveSettings();
				}

				notice.hide();
				new Notice('✅ 强制刷新完成', 3000);

				// 刷新视图
				await this.refreshView();
			} catch (error) {
				notice.hide();
				await this.noteProcessor.setProcessingStatus(file, 'error');
				new Notice(`❌ 强制刷新失败: ${error.message}`, 5000);
			}
		} catch (error) {
			new Notice(`强制刷新失败: ${error.message}`);
		}
	}

	/**
	 * 取消指定文件的处理
	 */
	private async cancelFileProcessing(file: TFile): Promise<void> {
		try {
			// 从处理中文件集合中移除
			this.processingFiles.delete(file.path);

			// 将文件状态重置为待处理
			await this.noteProcessor.setProcessingStatus(file, 'pending');

			// 刷新视图
			await this.refreshView();

			new Notice(`已取消处理: ${file.basename}`);
		} catch (error) {
			console.error('取消处理失败:', error);
			new Notice(`取消处理失败: ${error.message}`);
		}
	}

	/**
	 * 检查是否应该取消处理
	 */
	private shouldCancelProcessing(): boolean {
		return this.cancelProcessing;
	}

	/**
	 * 重置取消标志
	 */
	private resetCancelFlag(): void {
		this.cancelProcessing = false;
	}

	private async refreshView() {
		try {
			const container = this.containerEl.children[1] as HTMLElement;
			if (!container) return;

			container.empty();
			container.addClass('video-summary-view');

			// 重新渲染所有内容 - 移除主标题或使用更紧凑的样式
			// container.createEl('h2', { text: '视频总结管理' });
			this.renderCombinedInputSection(container); // 重新渲染合并的输入和处理选项
			await this.renderCombinedFileListAndHistory(container); // 重新渲染合并的文件列表和历史记录
		} catch (error) {
			console.error('刷新视图失败:', error);
		}
	}

	private getStatusText(status: string): string {
		return VideoUtils.getStatusText(status);
	}

	private getStatusClass(status: string): string {
		return VideoUtils.getStatusClass(status);
	}

	private async copyToClipboard(text: string, partIndex: number) {
		try {
			await navigator.clipboard.writeText(text);
			new Notice(`第${partIndex}P链接已复制到剪贴板`);
		} catch (error) {
			// 如果clipboard API不可用，使用传统方法
			const textArea = document.createElement('textarea');
			textArea.value = text;
			document.body.appendChild(textArea);
			textArea.select();
			document.execCommand('copy');
			document.body.removeChild(textArea);
			new Notice(`第${partIndex}P链接已复制到剪贴板`);
		}
	}

	private updateGenerateButtonText() {
		const generateBtn = this.containerEl.querySelector('.generate-btn') as HTMLButtonElement;
		if (!generateBtn) return;

		const singleMode = this.containerEl.querySelector('#single-link-mode') as HTMLInputElement;
		const multiMode = this.containerEl.querySelector('#multi-links-mode') as HTMLInputElement;
		const jsonMode = this.containerEl.querySelector('#json-mode') as HTMLInputElement;
		const multiPCheckbox = this.containerEl.querySelector('#multi-p-checkbox') as HTMLInputElement;

		if (jsonMode?.checked) {
			generateBtn.textContent = '创建笔记';
			generateBtn.style.display = 'block';
			return;
		}

		if (singleMode?.checked) {
			if (multiPCheckbox?.checked) {
				generateBtn.textContent = '生成分P链接';
			} else {
				generateBtn.textContent = '开始处理';
			}
			generateBtn.style.display = 'block';
			return;
		}

		if (multiMode?.checked) {
			generateBtn.textContent = '开始处理';
			generateBtn.style.display = 'block';
			return;
		}

		generateBtn.style.display = 'block';
	}

	/**
	 * 清理视频链接，去除多余参数
	 */
	private cleanVideoUrl(url: string): string {
		return VideoUtils.cleanVideoUrl(url);
	}

	/**
	 * 清理视频链接，但保留p参数（用于单个链接模式）
	 */
	private cleanVideoUrlKeepP(url: string): string {
		return VideoUtils.cleanVideoUrlKeepP(url);
	}

	/**
	 * 检查是否有视频元数据
	 */
	private hasVideoMetadata(content: string): boolean {
		return VideoUtils.hasVideoMetadata(content);
	}

	/**
	 * 获取处理状态
	 */
	private getProcessingStatus(content: string): string | null {
		return VideoUtils.getProcessingStatus(content);
	}



} 