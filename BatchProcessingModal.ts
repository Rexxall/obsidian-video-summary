import { App, Modal, Notice, Setting, TFile } from 'obsidian';
import VideoSummaryPlugin from './main';
import { ProcessingMode, SupportedLanguage, BatchProgress, PlaylistInfo, PlaylistItem } from './types';
import { LANGUAGE_OPTIONS, PROCESSING_MODES } from './constants';
import { NoteProcessor } from './utils/NoteProcessor';
import { VideoUtils } from './utils/VideoUtils';
import { PlaylistProcessor } from './utils/PlaylistProcessor';

export class BatchProcessingModal extends Modal {
	private plugin: VideoSummaryPlugin;
	private noteProcessor: NoteProcessor;

	private mode: ProcessingMode = 'summary';
	private language: SupportedLanguage = 'zh';
	private selectedFiles: TFile[] = [];
	private allVideoFiles: TFile[] = [];
	private playlistItems: PlaylistItem[] = [];
	private processingMode: 'files' | 'playlist' = 'files';
	private playlistUrl: string = '';
	private progress: BatchProgress = {
		total: 0,
		completed: 0,
		failed: 0,
		current: '',
		status: 'idle'
	};

	private progressEl: HTMLElement | null = null;
	private fileListEl: HTMLElement | null = null;
	private filterEl: HTMLElement | null = null;
	private playlistEl: HTMLElement | null = null;

	// 筛选条件
	private statusFilter: string = 'all'; // all, pending, error, processed
	private folderFilter: string = 'all';
	private dateFilter: string = 'all'; // all, today, week, month
	private searchFilter: string = '';
	// 信息字段筛选：all - 不区分；no-info - 缺少基础视频信息；has-info - 已有基础视频信息
	private infoFilter: 'all' | 'no-info' | 'has-info' = 'all';

	constructor(app: App, plugin: VideoSummaryPlugin) {
		super(app);
		this.plugin = plugin;
		this.noteProcessor = new NoteProcessor(app.vault);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl('h2', { text: '📺 批量视频总结处理' });

		// 处理模式选择
		const modeSelectionEl = contentEl.createEl('div', { cls: 'batch-mode-selection' });
		modeSelectionEl.createEl('h3', { text: '选择处理模式' });

		// 文件处理模式
		const fileModeButton = modeSelectionEl.createEl('button', {
			text: '📁 处理本地笔记文件',
			cls: this.processingMode === 'files' ? 'mod-cta' : 'mod-secondary'
		});
		fileModeButton.addEventListener('click', () => {
			this.processingMode = 'files';
			this.updateModeDisplay();
		});

		// 播放列表处理模式
		const playlistModeButton = modeSelectionEl.createEl('button', {
			text: '📺 处理播放列表/收藏夹',
			cls: this.processingMode === 'playlist' ? 'mod-cta' : 'mod-secondary'
		});
		playlistModeButton.addEventListener('click', () => {
			this.processingMode = 'playlist';
			this.updateModeDisplay();
		});

		// 处理模式选择
		new Setting(contentEl)
			.setName('处理模式')
			.setDesc('选择批量处理方式')
			.addDropdown(dropdown => {
				PROCESSING_MODES.forEach(mode => {
					dropdown.addOption(mode.value, mode.label);
				});
				dropdown.setValue(this.mode);
				dropdown.onChange(value => {
					this.mode = value as ProcessingMode;
					this.updateLanguageVisibility();
				});
			});

		// 语言选择
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

		// 并发数设置
		new Setting(contentEl)
			.setName('并发处理数')
			.setDesc('同时处理的最大文件数量')
			.addSlider(slider => slider
				.setLimits(1, 10, 1)
				.setValue(this.plugin.settings.batchConcurrency)
				.setDynamicTooltip()
				.onChange(value => {
					this.plugin.settings.batchConcurrency = value;
					this.plugin.saveSettings();
				}));

		// 文件选择区域
		const fileSelectionEl = contentEl.createEl('div', { cls: 'batch-file-selection' });
		fileSelectionEl.createEl('h3', { text: '选择要处理的文件' });

		// 扫描按钮
		const scanButton = fileSelectionEl.createEl('button', {
			text: '扫描视频笔记',
			cls: 'mod-cta'
		});
		scanButton.addEventListener('click', () => {
			this.scanVideoFiles();
		});

		// 筛选条件区域
		this.filterEl = fileSelectionEl.createEl('div', { cls: 'batch-filter-section' });
		this.filterEl.style.display = 'none';

		// 搜索框
		const searchContainer = this.filterEl.createEl('div', { cls: 'filter-row' });
		searchContainer.createEl('label', { text: '搜索文件名:', cls: 'filter-label' });
		const searchInput = searchContainer.createEl('input', {
			type: 'text',
			cls: 'filter-input'
		});
		searchInput.setAttribute('placeholder', '输入文件名关键词...');
		searchInput.addEventListener('input', async (e) => {
			this.searchFilter = (e.target as HTMLInputElement).value.toLowerCase();
			await this.applyFilters();
		});

		// 状态筛选
		const statusContainer = this.filterEl.createEl('div', { cls: 'filter-row' });
		statusContainer.createEl('label', { text: '处理状态:', cls: 'filter-label' });
		const statusSelect = statusContainer.createEl('select', { cls: 'filter-select' });
		statusSelect.createEl('option', { text: '全部状态', value: 'all' });
		statusSelect.createEl('option', { text: '待处理', value: 'pending' });
		statusSelect.createEl('option', { text: '处理失败', value: 'error' });
		statusSelect.createEl('option', { text: '已处理', value: 'processed' });
		statusSelect.value = this.statusFilter;
		statusSelect.addEventListener('change', async (e) => {
			this.statusFilter = (e.target as HTMLSelectElement).value;
			await this.applyFilters();
		});

		// 文件夹筛选
		const folderContainer = this.filterEl.createEl('div', { cls: 'filter-row' });
		folderContainer.createEl('label', { text: '文件夹:', cls: 'filter-label' });

		// 创建可搜索的下拉框容器
		const folderSelectContainer = folderContainer.createEl('div', { cls: 'searchable-select-container' });

		// 输入框
		const folderInput = folderSelectContainer.createEl('input', {
			type: 'text',
			cls: 'filter-input searchable-select-input',
			attr: { placeholder: '输入关键词筛选文件夹...' }
		});

		// 下拉框
		const folderSelect = folderSelectContainer.createEl('select', {
			cls: 'filter-select searchable-select-dropdown',
			attr: { size: '6' }
		});
		folderSelect.style.display = 'none';

		// 添加默认选项
		folderSelect.createEl('option', { text: '全部文件夹', value: 'all' });

		// 输入框事件
		folderInput.addEventListener('input', (e) => {
			const searchValue = (e.target as HTMLInputElement).value.toLowerCase();

			// 显示/隐藏下拉框
			if (searchValue.length > 0) {
				folderSelect.style.display = 'block';
				this.filterFolderOptions(folderSelect, searchValue);
			} else {
				folderSelect.style.display = 'none';
				this.resetFolderOptions(folderSelect);
			}
		});

		// 下拉框选择事件
		folderSelect.addEventListener('change', async (e) => {
			const selectedValue = (e.target as HTMLSelectElement).value;
			this.folderFilter = selectedValue;
			folderInput.value = selectedValue === 'all' ? '' : selectedValue;
			folderSelect.style.display = 'none';
			await this.applyFilters();
		});

		// 点击输入框时显示所有选项
		folderInput.addEventListener('click', () => {
			folderSelect.style.display = 'block';
			this.resetFolderOptions(folderSelect);
			// 确保所有选项都可见
			for (let i = 0; i < folderSelect.options.length; i++) {
				folderSelect.options[i].style.display = 'block';
			}
		});

		// 点击外部时隐藏下拉框
		document.addEventListener('click', (e) => {
			if (!folderSelectContainer.contains(e.target as Node)) {
				folderSelect.style.display = 'none';
			}
		});

		// 日期筛选
		const dateContainer = this.filterEl.createEl('div', { cls: 'filter-row' });
		dateContainer.createEl('label', { text: '修改时间:', cls: 'filter-label' });
		const dateSelect = dateContainer.createEl('select', { cls: 'filter-select' });
		dateSelect.createEl('option', { text: '全部时间', value: 'all' });
		dateSelect.createEl('option', { text: '今天', value: 'today' });
		dateSelect.createEl('option', { text: '本周', value: 'week' });
		dateSelect.createEl('option', { text: '本月', value: 'month' });
		dateSelect.value = this.dateFilter;
		dateSelect.addEventListener('change', async (e) => {
			this.dateFilter = (e.target as HTMLSelectElement).value;
			await this.applyFilters();
		});

		// 信息字段筛选（是否已有基础视频信息）
		const infoContainer = this.filterEl.createEl('div', { cls: 'filter-row' });
		infoContainer.createEl('label', { text: '视频信息:', cls: 'filter-label' });
		const infoSelect = infoContainer.createEl('select', { cls: 'filter-select' });
		infoSelect.createEl('option', { text: '全部', value: 'all' });
		infoSelect.createEl('option', { text: '缺少视频信息（适合批量补 info）', value: 'no-info' });
		infoSelect.createEl('option', { text: '已有视频信息', value: 'has-info' });
		infoSelect.value = this.infoFilter;
		infoSelect.addEventListener('change', async (e) => {
			this.infoFilter = (e.target as HTMLSelectElement).value as 'all' | 'no-info' | 'has-info';
			await this.applyFilters();
		});

		// 快速选择按钮
		const quickSelectContainer = this.filterEl.createEl('div', { cls: 'quick-select-buttons' });

		const selectAllBtn = quickSelectContainer.createEl('button', {
			text: '全选',
			cls: 'quick-select-btn'
		});
		selectAllBtn.addEventListener('click', async () => await this.selectAllVisible());

		const selectNoneBtn = quickSelectContainer.createEl('button', {
			text: '取消全选',
			cls: 'quick-select-btn'
		});
		selectNoneBtn.addEventListener('click', async () => await this.selectNone());

		const selectPendingBtn = quickSelectContainer.createEl('button', {
			text: '选择待处理',
			cls: 'quick-select-btn'
		});
		selectPendingBtn.addEventListener('click', async () => await this.selectByStatus('pending'));

		const selectErrorBtn = quickSelectContainer.createEl('button', {
			text: '选择失败',
			cls: 'quick-select-btn'
		});
		selectErrorBtn.addEventListener('click', async () => await this.selectByStatus('error'));

		// 文件列表
		this.fileListEl = fileSelectionEl.createEl('div', { cls: 'batch-file-list' });

		// 播放列表处理区域
		const playlistSelectionEl = contentEl.createEl('div', { cls: 'batch-playlist-selection' });
		playlistSelectionEl.createEl('h3', { text: '播放列表/收藏夹处理' });

		// 播放列表URL输入
		new Setting(playlistSelectionEl)
			.setName('播放列表链接')
			.setDesc('输入B站播放列表或收藏夹链接')
			.addText(text => text
				.setPlaceholder('https://space.bilibili.com/xxx/favlist?fid=xxx')
				.setValue(this.playlistUrl)
				.onChange(value => {
					this.playlistUrl = value;
				}));

		// 解析播放列表按钮
		const parseButton = playlistSelectionEl.createEl('button', {
			text: '解析播放列表',
			cls: 'mod-cta'
		});
		parseButton.addEventListener('click', () => {
			this.parsePlaylist();
		});

		// 播放列表内容显示
		this.playlistEl = playlistSelectionEl.createEl('div', { cls: 'batch-playlist-list' });

		// 进度显示区域
		this.progressEl = contentEl.createEl('div', { cls: 'batch-progress' });
		this.progressEl.style.display = 'none';

		// 操作按钮
		const buttonContainer = contentEl.createEl('div', { cls: 'batch-buttons' });

		// 开始批量处理按钮
		const startButton = buttonContainer.createEl('button', {
			text: '开始批量处理',
			cls: 'mod-cta'
		});
		startButton.addEventListener('click', () => {
			this.startBatchProcessing();
		});

		// 取消按钮
		const cancelButton = buttonContainer.createEl('button', {
			text: '取消',
			cls: 'mod-warning'
		});
		cancelButton.addEventListener('click', () => {
			this.close();
		});

		// 初始化语言选择可见性
		this.updateLanguageVisibility();

		// 初始化模式显示
		this.updateModeDisplay();

		// 添加样式
		contentEl.addClass('batch-processing-modal');
	}

	private updateLanguageVisibility() {
		const languageSetting = this.contentEl.querySelector('.setting-item:nth-child(2)') as HTMLElement;
		if (languageSetting) {
			if (this.mode === 'summary') {
				languageSetting.style.display = 'block';
			} else {
				languageSetting.style.display = 'none';
			}
		}
	}

	private updateModeDisplay() {
		// 更新按钮样式
		const fileModeButton = this.contentEl.querySelector('.batch-mode-selection button:first-child') as HTMLButtonElement;
		const playlistModeButton = this.contentEl.querySelector('.batch-mode-selection button:last-child') as HTMLButtonElement;

		if (fileModeButton && playlistModeButton) {
			fileModeButton.className = this.processingMode === 'files' ? 'mod-cta' : 'mod-secondary';
			playlistModeButton.className = this.processingMode === 'playlist' ? 'mod-cta' : 'mod-secondary';
		}

		// 显示/隐藏相应的区域
		const fileSelectionEl = this.contentEl.querySelector('.batch-file-selection') as HTMLElement;
		const playlistSelectionEl = this.contentEl.querySelector('.batch-playlist-selection') as HTMLElement;

		if (fileSelectionEl && playlistSelectionEl) {
			fileSelectionEl.style.display = this.processingMode === 'files' ? 'block' : 'none';
			playlistSelectionEl.style.display = this.processingMode === 'playlist' ? 'block' : 'none';
		}
	}

	private async parsePlaylist() {
		if (!this.playlistUrl.trim()) {
			new Notice('请输入播放列表链接');
			return;
		}

		if (!PlaylistProcessor.isPlaylistUrl(this.playlistUrl)) {
			new Notice('请输入有效的B站播放列表或收藏夹链接');
			return;
		}

		if (!this.playlistEl) return;

		this.playlistEl.empty();
		this.playlistEl.createEl('p', {
			text: '正在解析播放列表...',
			cls: 'mod-muted'
		});

		try {
			const playlistInfo = await PlaylistProcessor.extractBvIds(this.playlistUrl);
			this.playlistItems = playlistInfo.items;

			this.playlistEl.empty();
			this.playlistEl.createEl('h4', { text: `播放列表: ${playlistInfo.title}` });
			this.playlistEl.createEl('p', { text: `共 ${playlistInfo.itemCount} 个视频` });

			// 显示视频列表
			for (const item of this.playlistItems) {
				const itemEl = this.playlistEl.createEl('div', { cls: 'playlist-item' });

				// 复选框
				const checkbox = itemEl.createEl('input', {
					type: 'checkbox',
					attr: { id: `playlist-${item.bvid}` }
				});
				checkbox.checked = true;

				// 视频信息
				const infoEl = itemEl.createEl('div', { cls: 'playlist-item-info' });
				infoEl.createEl('div', {
					text: item.title,
					cls: 'playlist-item-title'
				});
				infoEl.createEl('div', {
					text: `UP主: ${item.author}`,
					cls: 'playlist-item-author'
				});
				if (item.duration) {
					infoEl.createEl('div', {
						text: `时长: ${item.duration}`,
						cls: 'playlist-item-duration'
					});
				}
				infoEl.createEl('div', {
					text: `BV号: ${item.bvid}`,
					cls: 'playlist-item-bvid'
				});
			}

			new Notice(`✅ 成功解析播放列表，共 ${playlistInfo.itemCount} 个视频`);

		} catch (error) {
			console.error('解析播放列表失败:', error);
			this.playlistEl.empty();
			this.playlistEl.createEl('p', {
				text: `❌ 解析失败: ${error.message}`,
				cls: 'mod-warning'
			});
			new Notice(`❌ 解析播放列表失败: ${error.message}`);
		}
	}

	private async scanVideoFiles() {
		if (!this.fileListEl || !this.filterEl) return;

		this.fileListEl.empty();
		this.selectedFiles = [];
		this.allVideoFiles = [];

		const files = this.app.vault.getMarkdownFiles();
		const videoFiles: TFile[] = [];

		// 优先基于 frontmatter 过滤，必要时读取正文
		for (const file of files) {
			try {
				const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
				if (VideoUtils.isVideoNoteFromFrontmatter(fm)) {
					videoFiles.push(file);
					continue;
				}
				const content = await this.app.vault.read(file);
				if (this.noteProcessor.hasVideoContent(content)) {
					videoFiles.push(file);
				}
			} catch (error) {
				console.error(`读取文件失败: ${file.basename}`, error);
			}
		}

		if (videoFiles.length === 0) {
			this.fileListEl.createEl('p', {
				text: '未找到包含视频内容的笔记',
				cls: 'mod-muted'
			});
			return;
		}

		this.allVideoFiles = videoFiles;

		// 显示筛选区域
		this.filterEl.style.display = 'block';

		// 更新文件夹选项
		this.updateFolderOptions();

		// 显示文件列表
		this.renderFileList();
	}


	private filterFolderOptions(select: HTMLSelectElement, searchValue: string) {
		// 隐藏所有选项
		for (let i = 0; i < select.options.length; i++) {
			const option = select.options[i];
			if (option.value === 'all') {
				option.style.display = 'block'; // 始终显示"全部文件夹"
			} else {
				option.style.display = option.text.toLowerCase().includes(searchValue) ? 'block' : 'none';
			}
		}
	}

	private resetFolderOptions(select: HTMLSelectElement) {
		// 显示所有选项
		for (let i = 0; i < select.options.length; i++) {
			select.options[i].style.display = 'block';
		}
		// 重置选择
		select.selectedIndex = 0;
	}

	private updateFolderOptions() {
		if (!this.filterEl) return;

		const folderSelect = this.filterEl.querySelector('.searchable-select-dropdown') as HTMLSelectElement;
		if (!folderSelect) return;

		// 清除现有选项（保留"全部文件夹"）
		while (folderSelect.children.length > 1) {
			folderSelect.removeChild(folderSelect.lastChild!);
		}

		// 获取所有文件夹
		const folders = new Set<string>();
		this.allVideoFiles.forEach(file => {
			const folder = file.parent?.path || '';
			if (folder) folders.add(folder);
		});

		// 添加文件夹选项
		Array.from(folders).sort().forEach(folder => {
			folderSelect.createEl('option', { text: folder, value: folder });
		});

		// 调试信息
		console.log(`找到 ${folders.size} 个文件夹选项:`, Array.from(folders).sort());
	}

	private async renderFileList() {
		if (!this.fileListEl) return;

		this.fileListEl.empty();

		// 应用筛选
		const filteredFiles = await this.getFilteredFiles();

		this.fileListEl.createEl('h4', { text: `显示 ${filteredFiles.length} 个文件（共 ${this.allVideoFiles.length} 个）:` });

		for (const file of filteredFiles) {
			const fileItem = this.fileListEl.createEl('div', { cls: 'batch-file-item' });

			// 复选框
			const checkbox = fileItem.createEl('input', {
				type: 'checkbox',
				attr: { id: `file-${file.path}` }
			});
			checkbox.checked = this.selectedFiles.some(f => f.path === file.path);
			checkbox.addEventListener('change', () => {
				if (checkbox.checked) {
					if (!this.selectedFiles.some(f => f.path === file.path)) {
						this.selectedFiles.push(file);
					}
				} else {
					this.selectedFiles = this.selectedFiles.filter(f => f.path !== file.path);
				}
			});

			// 文件标签
			const label = fileItem.createEl('label', {
				text: file.basename,
				attr: { for: `file-${file.path}` }
			});

			// 状态指示
			this.app.vault.read(file).then(content => {
				const status = this.noteProcessor.getProcessingStatus(content);
				if (status) {
					const statusEl = fileItem.createEl('span', {
						text: `(${status})`,
						cls: 'file-status'
					});
				}
			});
		}
	}

	private async getFilteredFiles(): Promise<TFile[]> {
		const filteredFiles: TFile[] = [];

		for (const file of this.allVideoFiles) {
			// 搜索筛选
			if (this.searchFilter && !file.basename.toLowerCase().includes(this.searchFilter)) {
				continue;
			}

			// 文件夹筛选
			if (this.folderFilter !== 'all') {
				const fileFolder = file.parent?.path || '';
				if (fileFolder !== this.folderFilter) {
					continue;
				}
			}

			// 日期筛选
			if (this.dateFilter !== 'all') {
				const fileTime = file.stat.mtime;
				const now = Date.now();
				const dayMs = 24 * 60 * 60 * 1000;

				switch (this.dateFilter) {
					case 'today':
						if (now - fileTime > dayMs) continue;
						break;
					case 'week':
						if (now - fileTime > 7 * dayMs) continue;
						break;
					case 'month':
						if (now - fileTime > 30 * dayMs) continue;
						break;
				}
			}

			// 状态筛选
			if (this.statusFilter !== 'all') {
				try {
					const content = await this.app.vault.read(file);
					const status = this.noteProcessor.getProcessingStatus(content);

					switch (this.statusFilter) {
						case 'pending':
							// 待处理：只有 pending 或者没有 status
							if (status && status !== 'pending') continue;
							break;
						case 'error':
							// 处理失败：只有 status 为 'error' 才是真正的失败
							if (status !== 'error') continue;
							break;
						case 'processed':
							// 已处理：除了 pending、error 和空状态之外的所有状态
							if (!status || status === 'pending' || status === 'error') {
								continue;
							}
							break;
					}
				} catch (error) {
					console.error(`读取文件状态失败: ${file.basename}`, error);
					continue;
				}
			}

			// 视频信息筛选（是否已有基础视频 info）
			if (this.infoFilter !== 'all') {
				try {
					const content = await this.app.vault.read(file);
					const hasInfo = this.noteProcessor.hasBasicVideoInfo(content);
					const hasLink = !!this.noteProcessor.extractVideoUrl(content);

					// no-info: 只保留「没有基础 info 且 有视频链接」的笔记
					if (this.infoFilter === 'no-info') {
						if (hasInfo || !hasLink) {
							continue;
						}
					}

					// has-info: 只保留已有基础 info 的笔记（是否有链接不限制）
					if (this.infoFilter === 'has-info' && !hasInfo) {
						continue;
					}
				} catch (error) {
					console.error(`读取文件视频信息失败: ${file.basename}`, error);
					continue;
				}
			}

			filteredFiles.push(file);
		}

		return filteredFiles;
	}

	private async applyFilters() {
		await this.renderFileList();
	}

	private async selectAllVisible() {
		const filteredFiles = await this.getFilteredFiles();
		filteredFiles.forEach(file => {
			if (!this.selectedFiles.some(f => f.path === file.path)) {
				this.selectedFiles.push(file);
			}
		});
		await this.renderFileList();
	}

	private async selectNone() {
		this.selectedFiles = [];
		await this.renderFileList();
	}

	private async selectByStatus(status: string) {
		// 根据状态筛选并选择文件
		const filteredFiles = await this.getFilteredFiles();
		this.selectedFiles = [];
		filteredFiles.forEach(file => {
			this.selectedFiles.push(file);
		});
		await this.renderFileList();
	}

	private async startBatchProcessing() {
		if (this.processingMode === 'files') {
			await this.processFiles();
		} else if (this.processingMode === 'playlist') {
			await this.processPlaylist();
		}
	}

	private async processFiles() {
		if (this.selectedFiles.length === 0) {
			new Notice('请先选择要处理的文件');
			return;
		}

		// 显示进度区域
		if (this.progressEl) {
			this.progressEl.style.display = 'block';
			this.updateProgressDisplay();
		}

		// 初始化进度
		this.progress = {
			total: this.selectedFiles.length,
			completed: 0,
			failed: 0,
			current: '',
			status: 'running'
		};

		try {
			// 构建批量请求
			const requests = await Promise.all(this.selectedFiles.map(async file => ({
				noteName: file.basename,
				input: this.noteProcessor.buildVideoInput(await this.app.vault.read(file)),
				mode: this.mode,
				language: this.language
			})));

			// 创建实时进度回调
			const onProgress = async (result: { success: boolean; result?: any; error?: string; noteName: string; index: number }) => {
				const file = this.selectedFiles[result.index];
				if (!file) return;

				this.progress.current = file.basename;

				if (result.success && result.result) {
					try {
						// 立即更新笔记
						await this.noteProcessor.updateNote(file, result.result, this.mode, {
							autoRename: this.plugin.settings.autoRenameEnabled,
							conflictStrategy: this.plugin.settings.renameConflictStrategy
						});
						this.progress.completed++;

						// 显示成功通知
						new Notice(`✅ ${file.basename} 处理完成`, 3000);
					} catch (updateError) {
						console.error(`更新笔记失败: ${file.basename}`, updateError);
						this.progress.failed++;
						new Notice(`❌ ${file.basename} 更新失败: ${updateError.message}`, 5000);
					}
				} else {
					// 设置错误状态
					try {
						await this.noteProcessor.setProcessingStatus(file, 'error');
						this.progress.failed++;
						new Notice(`❌ ${file.basename} 处理失败: ${result.error}`, 5000);
					} catch (statusError) {
						console.error(`设置状态失败: ${file.basename}`, statusError);
					}
				}

				// 实时更新进度显示
				this.updateProgressDisplay();
			};

			// 执行批量处理（使用实时回调）
			await this.plugin.api.batchProcess(
				requests,
				this.plugin.settings.batchConcurrency,
				onProgress
			);

			// 完成
			this.progress.status = 'complete';
			this.progress.current = '';
			this.updateProgressDisplay();

			// 显示完成通知
			const successText = `批量处理完成！成功: ${this.progress.completed}, 失败: ${this.progress.failed}`;
			new Notice(successText, 5000);

		} catch (error) {
			console.error('批量处理失败:', error);
			this.progress.status = 'error';
			this.updateProgressDisplay();
			new Notice(`❌ 批量处理失败: ${error.message}`, 0);
		}
	}

	private async processPlaylist() {
		const selectedItems = this.getSelectedPlaylistItems();
		if (selectedItems.length === 0) {
			new Notice('请先选择要处理的视频');
			return;
		}

		// 显示进度区域
		if (this.progressEl) {
			this.progressEl.style.display = 'block';
			this.updateProgressDisplay();
		}

		// 初始化进度
		this.progress = {
			total: selectedItems.length,
			completed: 0,
			failed: 0,
			current: '',
			status: 'running'
		};

		try {
			// 构建批量请求
			const requests = await Promise.all(selectedItems.map(async (item, index) => {
				// 创建笔记文件
				const fileName = `${item.title} - ${item.bvid}.md`;
				const filePath = `视频总结/${fileName}`;

				// 确保目录存在
				await this.ensureDirectoryExists('视频总结');

				// 创建笔记内容
				const noteContent = this.createNoteContent(item);

				// 创建文件
				await this.app.vault.create(filePath, noteContent);

				return {
					noteName: fileName,
					input: { url: item.url },
					mode: this.mode,
					language: this.language,
					filePath: filePath
				};
			}));

			// 创建实时进度回调
			const onProgress = async (result: { success: boolean; result?: any; error?: string; noteName: string; index: number }) => {
				const request = requests[result.index];
				if (!request) return;

				this.progress.current = request.noteName;

				if (result.success && result.result) {
					try {
						// 立即更新笔记
						const file = this.app.vault.getAbstractFileByPath(request.filePath) as TFile;
						if (file) {
							await this.noteProcessor.updateNote(file, result.result, this.mode, {
								autoRename: this.plugin.settings.autoRenameEnabled,
								conflictStrategy: this.plugin.settings.renameConflictStrategy
							});
						}
						this.progress.completed++;

						// 显示成功通知
						new Notice(`✅ ${request.noteName} 处理完成`, 3000);
					} catch (updateError) {
						console.error(`更新笔记失败: ${request.noteName}`, updateError);
						this.progress.failed++;
						new Notice(`❌ ${request.noteName} 更新失败: ${updateError.message}`, 5000);
					}
				} else {
					this.progress.failed++;
					new Notice(`❌ ${request.noteName} 处理失败: ${result.error}`, 5000);
				}

				// 实时更新进度显示
				this.updateProgressDisplay();
			};

			// 执行批量处理（使用实时回调）
			await this.plugin.api.batchProcess(
				requests.map(r => ({
					noteName: r.noteName,
					input: r.input,
					mode: r.mode,
					language: r.language
				})),
				this.plugin.settings.batchConcurrency,
				onProgress
			);

			// 完成
			this.progress.status = 'complete';
			this.progress.current = '';
			this.updateProgressDisplay();

			// 显示完成通知
			const successText = `播放列表处理完成！成功: ${this.progress.completed}, 失败: ${this.progress.failed}`;
			new Notice(successText, 5000);

		} catch (error) {
			console.error('播放列表处理失败:', error);
			this.progress.status = 'error';
			this.updateProgressDisplay();
			new Notice(`❌ 播放列表处理失败: ${error.message}`, 0);
		}
	}

	private getSelectedPlaylistItems(): PlaylistItem[] {
		const selectedItems: PlaylistItem[] = [];

		for (const item of this.playlistItems) {
			const checkbox = this.contentEl.querySelector(`#playlist-${item.bvid}`) as HTMLInputElement;
			if (checkbox && checkbox.checked) {
				selectedItems.push(item);
			}
		}

		return selectedItems;
	}

	private async ensureDirectoryExists(dirPath: string) {
		try {
			await this.app.vault.createFolder(dirPath);
		} catch (error) {
			// 目录已存在，忽略错误
		}
	}

	private createNoteContent(item: PlaylistItem): string {
		const now = new Date().toISOString().split('T')[0];
		return `---
link: ${item.url}
video_title: ${item.title}
video_author: ${item.author}
date: ${now}
status: pending
---

# ${item.title}

**UP主:** ${item.author}  
**BV号:** ${item.bvid}  
**链接:** ${item.url}  
**添加时间:** ${now}

## 视频总结

<!-- 视频总结将在这里生成 -->

## 文稿

<!-- 视频文稿将在这里生成 -->
`;
	}

	private updateProgressDisplay() {
		if (!this.progressEl) return;

		this.progressEl.empty();

		const statusText = this.progress.status === 'running' ? '⏳ 处理中' :
			this.progress.status === 'complete' ? '✅ 完成' :
				this.progress.status === 'error' ? '❌ 错误' : '📺 就绪';

		this.progressEl.createEl('h3', { text: `批量处理状态: ${statusText}` });

		if (this.progress.total > 0) {
			const progressBar = this.progressEl.createEl('div', { cls: 'progress-bar' });
			const progressFill = progressBar.createEl('div', { cls: 'progress-fill' });
			const progress = (this.progress.completed + this.progress.failed) / this.progress.total;
			progressFill.style.width = `${progress * 100}%`;

			this.progressEl.createEl('p', {
				text: `进度: ${this.progress.completed + this.progress.failed}/${this.progress.total}`
			});
			this.progressEl.createEl('p', {
				text: `成功: ${this.progress.completed}, 失败: ${this.progress.failed}`
			});

			if (this.progress.current) {
				this.progressEl.createEl('p', {
					text: `当前处理: ${this.progress.current}`,
					cls: 'current-file'
				});
			}

			// 添加实时状态列表
			if (this.progress.status === 'running' || this.progress.status === 'complete') {
				const statusListEl = this.progressEl.createEl('div', { cls: 'status-list' });
				statusListEl.createEl('h4', { text: '处理状态详情:' });

				// 显示已处理的文件状态
				const processedCount = this.progress.completed + this.progress.failed;
				if (processedCount > 0) {
					const statusSummary = statusListEl.createEl('div', { cls: 'status-summary' });
					statusSummary.innerHTML = `
						<div class="status-item success">✅ 已完成: ${this.progress.completed} 个</div>
						<div class="status-item error">❌ 失败: ${this.progress.failed} 个</div>
						<div class="status-item pending">⏳ 待处理: ${this.progress.total - processedCount} 个</div>
					`;
				}
			}
		}
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
} 