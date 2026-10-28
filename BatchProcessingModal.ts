import { App, Modal, Notice, Setting, TFile, setIcon } from 'obsidian';
import VideoSummaryPlugin from './main';
import { ProcessingMode, SupportedLanguage, BatchProgress, VideoInput } from './types';
import { LANGUAGE_OPTIONS, PROCESSING_MODES } from './constants';
import { NoteProcessor } from './utils/NoteProcessor';
import {
  PlaylistInfo,
  PlaylistItem,
  PlaylistProcessor,
  canonicalizeVideoUrl,
} from './utils/PlaylistProcessor';
import { MenuItemSpec, configChip, segmented, showMenu, statusPill } from './views/ui';
import { platformLabel } from './core/NoteIndex';
import { CourseStore, CourseManifest, summarizeCourseProgress } from './core/CourseStore';
import {
  CourseImportResult,
  compileCourseImport,
  courseIndexBaseName,
} from './core/CourseCompiler';
import { NoteFactory } from './core/NoteFactory';
import { syncCourseIndexAtomic } from './core/CourseIndexWriter';

export class BatchProcessingModal extends Modal {
  private plugin: VideoSummaryPlugin;
  private noteProcessor: NoteProcessor;
  private noteFactory: NoteFactory;
  private courseStore: CourseStore;

  private mode: ProcessingMode = 'summary';
  private language: SupportedLanguage = 'zh';
  private selectedFiles: TFile[] = [];
  private allVideoFiles: TFile[] = [];
  private playlistItems: PlaylistItem[] = [];
  private playlistInfo: PlaylistInfo | null = null;
  private courseImport: CourseImportResult | null = null;
  private selectedPlaylistKeys = new Set<string>();
  private processingMode: 'files' | 'playlist' = 'files';
  private playlistUrl: string = '';
  private progress: BatchProgress = {
    total: 0,
    completed: 0,
    failed: 0,
    current: '',
    status: 'idle',
  };

  private progressEl: HTMLElement | null = null;
  private fileListEl: HTMLElement | null = null;
  private filterEl: HTMLElement | null = null;
  private countEl: HTMLElement | null = null;
  private startButtonEl: HTMLButtonElement | null = null;
  private startLabelEl: HTMLElement | null = null;
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
    this.noteFactory = new NoteFactory(app);
    this.courseStore = plugin.courseStore;
  }

  onOpen() {
    this.modalEl.addClass('ap', 'ap-modal');
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('batch-processing-modal');
    contentEl.addClass('vs-modal');

    const header = contentEl.createDiv({ cls: 'vs-modal-header' });
    header.createSpan({ text: '批量处理', cls: 'vs-modal-title' });
    const closeBtn = header.createEl('button', {
      cls: 'vs-icon-btn',
      attr: { type: 'button', 'aria-label': '关闭' },
    });
    setIcon(closeBtn, 'x');
    closeBtn.onclick = () => this.close();

    const bodyEl = contentEl.createDiv({ cls: 'vs-modal-body' });

    segmented(
      bodyEl,
      [
        { value: 'files' as const, label: '本地笔记文件', icon: 'files' },
        { value: 'playlist' as const, label: '导入视频课程', icon: 'list-video' },
      ],
      this.processingMode,
      (value: 'files' | 'playlist') => {
        this.processingMode = value;
        this.updateModeDisplay();
      },
    );

    const chipRow = bodyEl.createDiv({ cls: 'vs-chip-row' });
    configChip(
      chipRow,
      '处理模式',
      PROCESSING_MODES.find((item) => item.value === this.mode)?.label || '完整总结',
      PROCESSING_MODES.map((item) => ({
        title: item.label,
        onClick: () => {
          this.mode = item.value as ProcessingMode;
          this.onOpen();
        },
      })),
    );
    configChip(
      chipRow,
      '输出语言',
      LANGUAGE_OPTIONS.find((item) => item.value === this.language)?.label || '中文',
      LANGUAGE_OPTIONS.map((item) => ({
        title: item.label,
        onClick: () => {
          this.language = item.value as SupportedLanguage;
          this.onOpen();
        },
      })),
    );

    // ---------- 本地笔记文件 ----------
    const fileSelectionEl = bodyEl.createDiv({ cls: 'batch-file-selection' });

    this.filterEl = fileSelectionEl.createDiv({ cls: 'vs-modal-filters' });
    const search = this.filterEl.createDiv({ cls: 'vs-search' });
    const searchIcon = search.createSpan({ cls: 'vs-search-icon' });
    setIcon(searchIcon, 'search');
    const searchInput = search.createEl('input', {
      cls: 'vs-search-input',
      attr: { type: 'text', placeholder: '搜索文件名…', value: this.searchFilter },
    });
    searchInput.addEventListener('input', async () => {
      this.searchFilter = searchInput.value.toLowerCase();
      await this.applyFilters();
    });

    const statusLabels: Record<string, string> = {
      all: '全部状态',
      pending: '待处理',
      error: '处理失败',
      processed: '已处理',
    };
    this.filterPill(this.filterEl, statusLabels[this.statusFilter] || '全部状态', () =>
      Object.entries(statusLabels).map(([value, label]) => ({
        title: label,
        onClick: async () => {
          this.statusFilter = value;
          await this.applyFilters();
          this.refreshFilterPills();
        },
      })),
    );

    this.filterPill(
      this.filterEl,
      this.folderFilter === 'all' ? '全部文件夹' : this.folderFilter,
      () => [
        {
          title: '全部文件夹',
          onClick: async () => {
            this.folderFilter = 'all';
            await this.applyFilters();
            this.refreshFilterPills();
          },
        },
        ...this.collectFolders().map((folder) => ({
          title: folder,
          onClick: async () => {
            this.folderFilter = folder;
            await this.applyFilters();
            this.refreshFilterPills();
          },
        })),
      ],
    );

    const dateLabels: Record<string, string> = {
      all: '全部时间',
      today: '今天',
      week: '本周',
      month: '本月',
    };
    this.filterPill(this.filterEl, dateLabels[this.dateFilter] || '全部时间', () =>
      Object.entries(dateLabels).map(([value, label]) => ({
        title: label,
        onClick: async () => {
          this.dateFilter = value;
          await this.applyFilters();
          this.refreshFilterPills();
        },
      })),
    );

    const quickRow = fileSelectionEl.createDiv({ cls: 'vs-modal-quick' });
    const quickChip = (label: string, active: boolean, onClick: () => void) => {
      const chip = quickRow.createEl('button', {
        text: label,
        cls: `vs-quick-chip${active ? ' is-active' : ''}`,
        attr: { type: 'button' },
      });
      chip.addEventListener('click', (event) => {
        event.preventDefault();
        onClick();
      });
    };
    quickChip('全选', false, () => void this.selectAllVisible());
    quickChip('清空', false, () => void this.selectNone());
    quickChip('选择待处理', false, () => void this.selectByStatus('pending'));
    quickChip('选择失败', false, () => void this.selectByStatus('error'));
    quickChip('缺少视频信息', this.infoFilter === 'no-info', async () => {
      this.infoFilter = this.infoFilter === 'no-info' ? 'all' : 'no-info';
      await this.applyFilters();
      this.onOpen();
    });
    quickRow.createSpan({ cls: 'vs-quick-spacer' });
    this.countEl = quickRow.createSpan({ cls: 'vs-quick-count' });

    this.fileListEl = fileSelectionEl.createDiv({ cls: 'vs-modal-list' });
    this.renderLastBatch(fileSelectionEl);

    // ---------- 播放列表 ----------
    const playlistSelectionEl = bodyEl.createDiv({ cls: 'batch-playlist-selection' });
    new Setting(playlistSelectionEl)
      .setName('课程来源链接')
      .setDesc('支持 YouTube 播放列表与 B站合集/收藏夹；解析和导入不会调用 AI')
      .addText((text) =>
        text
          .setPlaceholder('YouTube playlist 或 B站合集/收藏夹链接')
          .setValue(this.playlistUrl)
          .onChange((value) => {
            this.playlistUrl = value;
          }),
      );
    const parseButton = playlistSelectionEl.createEl('button', {
      text: '预览增量',
      cls: 'vs-text-btn is-primary',
      attr: { type: 'button' },
    });
    parseButton.addEventListener('click', () => {
      void this.parsePlaylist();
    });
    this.playlistEl = playlistSelectionEl.createDiv({ cls: 'batch-playlist-list' });

    this.progressEl = bodyEl.createDiv({ cls: 'batch-progress' });
    this.progressEl.hide();

    // ---------- 底部 ----------
    const footer = contentEl.createDiv({ cls: 'vs-modal-footer' });
    const concurrency = footer.createEl('button', {
      cls: 'vs-quick-chip',
      attr: { type: 'button', title: '同时处理的最大数量' },
    });
    concurrency.setText(`并发 ${this.plugin.settings.batchConcurrency}`);
    concurrency.addEventListener('click', (event) => {
      event.preventDefault();
      showMenu(
        event,
        [1, 2, 3, 4, 6, 8].map((value) => ({
          title: String(value),
          onClick: async () => {
            this.plugin.settings.batchConcurrency = value;
            this.plugin.jobs.setConcurrency(value);
            await this.plugin.saveSettings();
            concurrency.setText(`并发 ${value}`);
          },
        })),
      );
    });
    footer.createSpan({ cls: 'vs-quick-spacer' });
    const cancelButton = footer.createEl('button', {
      text: '取消',
      cls: 'vs-text-btn',
      attr: { type: 'button' },
    });
    cancelButton.addEventListener('click', () => this.close());
    this.startButtonEl = footer.createEl('button', {
      cls: 'vs-primary-btn',
      attr: { type: 'button' },
    });
    const startIcon = this.startButtonEl.createSpan({ cls: 'vs-btn-icon' });
    setIcon(startIcon, 'play');
    this.startLabelEl = this.startButtonEl.createSpan({ text: '开始处理' });
    this.startButtonEl.addEventListener('click', () => {
      void this.startBatchProcessing();
    });

    this.updateModeDisplay();
    void this.scanVideoFiles();
  }

  /** 一行筛选里的下拉胶囊：点开是 Obsidian Menu */
  private filterPill(parent: HTMLElement, label: string, items: () => MenuItemSpec[]) {
    const pill = parent.createEl('button', {
      cls: 'vs-filter-pill',
      attr: { type: 'button' },
    });
    pill.createSpan({ text: label });
    const caret = pill.createSpan({ cls: 'vs-chip-caret' });
    setIcon(caret, 'chevron-down');
    pill.addEventListener('click', (event) => {
      event.preventDefault();
      showMenu(event, items());
    });
    return pill;
  }

  private refreshFilterPills() {
    // 标签变了就重画一次弹窗内容（状态都在实例上，重画无副作用）
    this.onOpen();
  }

  private collectFolders(): string[] {
    const folders = new Set<string>();
    this.allVideoFiles.forEach((file) => {
      const folder = file.parent?.path;
      if (folder && folder !== '/') folders.add(folder);
    });
    return Array.from(folders).sort().slice(0, 60);
  }

  /** 上次批量的成败比例，数据来自 settings.history */
  private renderLastBatch(container: HTMLElement) {
    const history = this.plugin.settings.history || [];
    if (history.length === 0) return;

    // 把结尾连续、时间相邻的记录当作同一批
    const recent = history.slice(-40).reverse();
    const batch: typeof recent = [];
    let previous: number | null = null;
    for (const record of recent) {
      const time = Date.parse(record.time) || 0;
      if (previous !== null && previous - time > 30 * 60 * 1000) break;
      batch.push(record);
      previous = time;
    }
    if (batch.length < 2) return;

    const success = batch.filter((record) => record.result === 'success').length;
    const failed = batch.length - success;

    const card = container.createDiv({ cls: 'vs-last-batch' });
    const row = card.createDiv({ cls: 'vs-last-batch-row' });
    row.createSpan({ text: `上次批量 · ${batch.length} 个文件`, cls: 'vs-last-batch-title' });
    row.createSpan({ text: `${success} 成功`, cls: 'vs-mono vs-last-ok' });
    if (failed > 0) row.createSpan({ text: `${failed} 失败`, cls: 'vs-mono vs-last-fail' });

    const bar = card.createDiv({ cls: 'vs-last-batch-bar' });
    bar.createSpan({ cls: 'is-ok' }).style.width = `${Math.round((success / batch.length) * 100)}%`;
    if (failed > 0) {
      bar.createSpan({ cls: 'is-fail' }).style.width =
        `${Math.round((failed / batch.length) * 100)}%`;
    }
  }

  private updateModeDisplay() {
    const fileSelectionEl = this.contentEl.querySelector('.batch-file-selection') as HTMLElement;
    const playlistSelectionEl = this.contentEl.querySelector(
      '.batch-playlist-selection',
    ) as HTMLElement;
    if (fileSelectionEl) {
      fileSelectionEl.style.display = this.processingMode === 'files' ? 'block' : 'none';
    }
    if (playlistSelectionEl) {
      playlistSelectionEl.style.display = this.processingMode === 'playlist' ? 'block' : 'none';
    }
    this.contentEl.querySelectorAll('.vs-seg-item').forEach((item, index) => {
      const isActive = (index === 0) === (this.processingMode === 'files');
      item.toggleClass('is-active', isActive);
    });
    this.updateStartButton();
  }

  private updateStartButton() {
    if (this.startLabelEl) {
      if (this.processingMode === 'playlist') {
        const count = this.selectedPlaylistKeys.size;
        this.startLabelEl.setText(
          this.courseImport
            ? count > 0
              ? `导入课程 · 新建 ${count} 条待处理笔记`
              : '更新课程索引'
            : '先预览课程增量',
        );
      } else {
        const count = this.selectedFiles.length;
        this.startLabelEl.setText(count > 0 ? `开始处理 ${count} 个` : '开始处理');
      }
    }
    if (this.countEl) {
      this.countEl.setText(`已选 ${this.selectedFiles.length} / ${this.allVideoFiles.length}`);
    }
  }

  private async parsePlaylist() {
    if (!this.playlistUrl.trim()) {
      new Notice('请输入播放列表链接');
      return;
    }

    if (!PlaylistProcessor.isPlaylistUrl(this.playlistUrl)) {
      new Notice('请输入有效的 YouTube 播放列表或 B站合集/收藏夹链接');
      return;
    }

    if (!this.playlistEl) return;

    this.playlistEl.empty();
    this.playlistEl.createEl('p', {
      text: '正在解析播放列表...',
      cls: 'mod-muted',
    });

    try {
      const playlistInfo = await PlaylistProcessor.extract(this.playlistUrl, {
        maxItems: 500,
        maxPages: 20,
        pageSize: 50,
      });
      const previous = await this.courseStore.loadForPlaylist(playlistInfo);
      const courseImport = compileCourseImport(playlistInfo, previous);
      this.playlistInfo = playlistInfo;
      this.courseImport = courseImport;
      this.playlistItems = playlistInfo.items;
      const newKeys = new Set(courseImport.diff.new.map((item) => item.canonical_key));
      const selectableKeys = new Set(
        courseImport.manifest.items
          .filter(
            (item) =>
              !item.removed_from_source &&
              ['pending', 'error'].includes(item.progress.status) &&
              !item.progress.note_path,
          )
          .map((item) => item.canonical_key),
      );
      this.selectedPlaylistKeys = new Set(selectableKeys);

      this.playlistEl.empty();
      this.playlistEl.createEl('h4', { text: `课程: ${playlistInfo.title}` });
      this.playlistEl.createEl('p', {
        text: `共 ${playlistInfo.itemCount} 个 · 新增 ${courseImport.diff.new.length} · 已存在 ${courseImport.diff.existing.length} · 来源移除 ${courseImport.diff.removed.length}`,
      });
      if (playlistInfo.truncated) {
        this.playlistEl.createEl('p', {
          text: `已触达安全上限（${playlistInfo.fetchedPages} 页），当前预览可能不是完整列表`,
          cls: 'mod-warning',
        });
      }

      // 显示视频列表
      for (const item of this.playlistItems) {
        const itemEl = this.playlistEl.createEl('div', { cls: 'playlist-item' });
        const isNew = newKeys.has(item.canonicalKey);
        const canCreatePendingNote = selectableKeys.has(item.canonicalKey);

        // 复选框
        const checkbox = itemEl.createEl('input', {
          type: 'checkbox',
        });
        checkbox.checked = canCreatePendingNote;
        checkbox.disabled = !canCreatePendingNote;
        checkbox.addEventListener('change', () => {
          if (checkbox.checked) this.selectedPlaylistKeys.add(item.canonicalKey);
          else this.selectedPlaylistKeys.delete(item.canonicalKey);
          this.updateStartButton();
        });

        // 视频信息
        const infoEl = itemEl.createEl('div', { cls: 'playlist-item-info' });
        infoEl.createEl('div', {
          text: item.title,
          cls: 'playlist-item-title',
        });
        infoEl.createEl('div', {
          text: `${item.platform === 'youtube' ? '频道' : 'UP主'}: ${item.author || '未知'}`,
          cls: 'playlist-item-author',
        });
        if (item.duration) {
          infoEl.createEl('div', {
            text: `时长: ${item.duration}`,
            cls: 'playlist-item-duration',
          });
        }
        infoEl.createEl('div', {
          text: `${
            isNew
              ? '新增 · 将进入待处理'
              : canCreatePendingNote
                ? '已在课程中 · 可补建待处理笔记'
                : '已导入 · 不重复创建'
          } · ${item.videoId}`,
          cls: 'playlist-item-bvid',
        });
      }

      this.updateStartButton();
      new Notice(`课程增量已就绪：${courseImport.diff.new.length} 个新增视频（尚未调用 AI）`);
    } catch (error) {
      console.error('解析播放列表失败:', error);
      const message = messageOf(error);
      this.playlistEl.empty();
      this.playlistEl.createEl('p', {
        text: `❌ 解析失败: ${message}`,
        cls: 'mod-warning',
      });
      new Notice(`❌ 解析播放列表失败: ${message}`);
    }
  }

  /** 扫描视频笔记：直接用插件已有的索引，不再全库读正文 */
  private async scanVideoFiles() {
    if (!this.fileListEl) return;

    const entries = this.plugin.noteIndex.getAll();
    const files: TFile[] = [];
    for (const entry of entries) {
      const file = this.app.vault.getAbstractFileByPath(entry.path);
      if (file instanceof TFile) files.push(file);
    }
    this.allVideoFiles = files;
    this.selectedFiles = this.selectedFiles.filter((selected) =>
      files.some((file) => file.path === selected.path),
    );

    await this.renderFileList();
  }

  private async renderFileList() {
    if (!this.fileListEl) return;
    this.fileListEl.empty();

    const filteredFiles = await this.getFilteredFiles();

    if (filteredFiles.length === 0) {
      this.fileListEl.createDiv({
        text: this.allVideoFiles.length === 0 ? '库里还没有视频笔记' : '没有符合筛选条件的笔记',
        cls: 'vs-modal-empty',
      });
      this.updateStartButton();
      return;
    }

    for (const file of filteredFiles) {
      const entry = this.plugin.noteIndex.get(file.path);
      const row = this.fileListEl.createDiv({ cls: 'vs-modal-row' });
      const checked = this.selectedFiles.some((selected) => selected.path === file.path);

      const box = row.createDiv({ cls: `vs-checkbox${checked ? ' is-checked' : ''}` });
      if (checked) setIcon(box, 'check');

      const body = row.createDiv({ cls: 'vs-modal-row-body' });
      body.createDiv({
        text: file.basename,
        cls: `vs-modal-row-title${checked ? ' is-checked' : ''}`,
      });
      const sub = body.createDiv({ cls: 'vs-modal-row-sub' });
      if (entry?.platform) {
        sub.createSpan({
          text: platformLabel(entry.platform),
          cls: `vs-platform is-${entry.platform}`,
        });
      }
      sub.createSpan({
        text: file.parent?.path && file.parent.path !== '/' ? file.parent.path : '根目录',
      });
      sub.createSpan({ text: new Date(file.stat.mtime).toLocaleDateString('zh-CN') });

      statusPill(row, entry?.status || 'pending');

      row.addEventListener('click', () => {
        if (checked) {
          this.selectedFiles = this.selectedFiles.filter((selected) => selected.path !== file.path);
        } else {
          this.selectedFiles.push(file);
        }
        void this.renderFileList();
      });
    }

    this.updateStartButton();
  }

  private async getFilteredFiles(): Promise<TFile[]> {
    const now = Date.now();
    const dateFloor =
      this.dateFilter === 'today'
        ? now - 24 * 60 * 60 * 1000
        : this.dateFilter === 'week'
          ? now - 7 * 24 * 60 * 60 * 1000
          : this.dateFilter === 'month'
            ? now - 30 * 24 * 60 * 60 * 1000
            : 0;

    const result: TFile[] = [];
    for (const file of this.allVideoFiles) {
      const entry = this.plugin.noteIndex.get(file.path);
      const status = entry?.status || 'pending';

      if (this.searchFilter && !file.basename.toLowerCase().includes(this.searchFilter)) continue;
      if (this.statusFilter !== 'all') {
        const wanted = this.statusFilter === 'processed' ? 'success' : this.statusFilter;
        if (status !== wanted) continue;
      }
      if (this.folderFilter !== 'all' && (file.parent?.path || '') !== this.folderFilter) continue;
      if (dateFloor && file.stat.mtime < dateFloor) continue;

      if (this.infoFilter !== 'all') {
        // 只有这个筛选需要看正文，其余都走索引
        const content = await this.app.vault.cachedRead(file);
        const hasInfo = this.noteProcessor.hasBasicVideoInfo(content);
        if (this.infoFilter === 'no-info' && hasInfo) continue;
        if (this.infoFilter === 'has-info' && !hasInfo) continue;
      }

      result.push(file);
    }
    return result;
  }

  private async applyFilters() {
    await this.renderFileList();
  }

  private async selectAllVisible() {
    const filteredFiles = await this.getFilteredFiles();
    filteredFiles.forEach((file) => {
      if (!this.selectedFiles.some((f) => f.path === file.path)) {
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
    const filteredFiles = await this.getFilteredFiles();
    this.selectedFiles = filteredFiles.filter(
      (file) => (this.plugin.noteIndex.get(file.path)?.status || 'pending') === status,
    );
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
    if (!(await this.plugin.ensureBackendReady())) return;

    // 显示进度区域
    if (this.progressEl) {
      this.progressEl.show();
      this.updateProgressDisplay();
    }

    // 初始化进度
    this.progress = {
      total: this.selectedFiles.length,
      completed: 0,
      failed: 0,
      current: '',
      status: 'running',
    };

    try {
      // 逐个构建请求：一个文件读取失败时，不应让其他已标记为 running 的文件
      // 停在半途中；同时保留独立的文件数组，避免失败项造成回调索引错位。
      const requests: Array<{
        noteName: string;
        input: VideoInput;
        mode: ProcessingMode;
        language: SupportedLanguage;
      }> = [];
      const requestFiles: TFile[] = [];
      for (const file of [...this.selectedFiles]) {
        try {
          const input = this.noteProcessor.buildVideoInput(await this.app.vault.read(file));
          await this.noteProcessor.setProcessingStatus(file, 'running');
          await this.plugin.jobService.updateCourseProgressForFile(file, 'processing', 10);
          requests.push({
            noteName: file.basename,
            input: {
              ...input,
              processingDepth: this.plugin.settings.defaultProcessingDepth,
              contentType: this.plugin.settings.defaultContentType,
              autoRoute: this.plugin.settings.autoRouteContent,
              attentionAssessment: this.plugin.settings.attentionAssessmentEnabled,
              generateLearning: this.plugin.settings.generateLearningArtifacts,
            },
            mode: this.mode,
            language: this.language,
          });
          requestFiles.push(file);
        } catch (requestError) {
          const normalizedError =
            requestError instanceof Error ? requestError : new Error(String(requestError));
          console.error(`读取批量文件失败: ${file.basename}`, normalizedError);
          try {
            await this.noteProcessor.setProcessingError(file, normalizedError);
            await this.plugin.jobService.updateCourseProgressForFile(file, 'error', 0);
          } catch (statusError) {
            console.error(`设置批量文件错误状态失败: ${file.basename}`, statusError);
          }
          this.progress.failed++;
          this.progress.current = file.basename;
          this.updateProgressDisplay();
          new Notice(`❌ ${file.basename} 无法加入批量任务: ${normalizedError.message}`, 5000);
        }
      }

      // 创建实时进度回调
      const onProgress = async (result: {
        success: boolean;
        result?: any;
        error?: string;
        noteName: string;
        index: number;
      }) => {
        const file = requestFiles[result.index];
        if (!file) return;

        this.progress.current = file.basename;

        if (result.success && result.result) {
          try {
            const request = requests[result.index];
            const artifactContext = {
              title: file.basename,
              notePath: file.path,
              input: request.input,
              platform: result.result.video_platform,
            };
            await this.plugin.jobService.persistExternalResult(artifactContext, result.result);
            await this.noteProcessor.updateNote(file, result.result, this.mode, {
              autoRename: this.plugin.settings.autoRenameEnabled,
              conflictStrategy: this.plugin.settings.renameConflictStrategy,
            });
            await this.plugin.jobService.relinkExternalResult(artifactContext, result.result, file);
            await this.noteProcessor.setProcessingStatus(
              file,
              this.plugin.settings.successStatusValue ?? 'success',
            );
            await this.plugin.jobService.updateCourseProgressForFile(
              file,
              'complete',
              100,
              result.result.artifact?.artifact_id,
            );
            this.progress.completed++;

            // 显示成功通知
            new Notice(`✅ ${file.basename} 处理完成`, 3000);
          } catch (updateError) {
            console.error(`更新笔记失败: ${file.basename}`, updateError);
            await this.noteProcessor.setProcessingError(file, updateError);
            await this.plugin.jobService.updateCourseProgressForFile(file, 'error', 0);
            this.progress.failed++;
            new Notice(`❌ ${file.basename} 更新失败: ${updateError.message}`, 5000);
          }
        } else {
          // 设置错误状态
          try {
            await this.noteProcessor.setProcessingError(
              file,
              new Error(result.error || '批量处理失败'),
            );
            await this.plugin.jobService.updateCourseProgressForFile(file, 'error', 0);
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
        onProgress,
        this.plugin.settings.enableCache !== false,
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
    if (!this.courseImport || !this.playlistInfo) {
      new Notice('请先预览课程增量');
      return;
    }
    const selectedKeys = new Set(this.selectedPlaylistKeys);
    let manifest = this.courseImport.manifest;
    const selectedItemKeys = manifest.items
      .filter((item) => !item.removed_from_source && selectedKeys.has(item.canonical_key))
      .map((item) => item.canonical_key);

    if (this.progressEl) {
      this.progressEl.show();
    }
    this.progress = {
      total: selectedItemKeys.length,
      completed: 0,
      failed: 0,
      current: '',
      status: 'running',
    };
    this.updateProgressDisplay();

    try {
      manifest.index_note_path =
        manifest.index_note_path ?? (await this.resolveCourseIndexPath(manifest));
      const reusableNotes = await this.indexReusableCourseNotes(manifest.course_id);
      const reusableArtifacts = new Map(
        (await this.plugin.artifactStore.list())
          .filter((artifact) => artifact.source.note_path)
          .map((artifact) => [artifact.source.note_path as string, artifact] as const),
      );
      for (const itemKey of selectedItemKeys) {
        const item = manifest.items.find((candidate) => candidate.canonical_key === itemKey);
        if (!item) {
          this.progress.failed += 1;
          continue;
        }
        this.progress.current = item.title;
        this.updateProgressDisplay();
        const recovered = reusableNotes.get(item.canonical_key);
        const file =
          recovered ||
          (await this.noteFactory.createStubNote(
            {
              title: item.title,
              input: { url: item.canonical_url },
              source: 'url',
              platform: item.platform,
            },
            {
              outputFolder: this.plugin.settings.outputFolder || '',
              successStatusValue: this.plugin.settings.successStatusValue ?? 'success',
            },
          ));
        if (!file) {
          item.progress = {
            ...item.progress,
            status: 'error',
            percent: 0,
            updated_at: new Date().toISOString(),
          };
          this.progress.failed += 1;
          manifest.progress = summarizeCourseProgress(manifest.items);
          manifest = await this.courseStore.save(manifest);
          await this.writeCourseIndex(manifest);
          continue;
        }
        await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
          frontmatter.video_course_id = manifest.course_id;
          frontmatter.video_course_item_id = item.item_id;
          frontmatter.video_course_position = item.recommended_position + 1;
        });
        const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
        const frontmatterArtifactId = String(frontmatter?.video_artifact_id || '').trim();
        let linkedArtifact = reusableArtifacts.get(file.path);
        if (!linkedArtifact && frontmatterArtifactId) {
          try {
            linkedArtifact = await this.plugin.artifactStore.load(frontmatterArtifactId);
          } catch {
            // A stale frontmatter id is not proof that a sidecar still exists.
          }
        }
        let artifactId = '';
        if (linkedArtifact) {
          try {
            linkedArtifact = await this.plugin.artifactStore.save({
              ...linkedArtifact,
              source: { ...linkedArtifact.source, note_path: file.path },
              course_ids: Array.from(
                new Set([...(linkedArtifact.course_ids || []), manifest.course_id]),
              ).sort(),
            });
            artifactId = linkedArtifact.artifact_id;
            reusableArtifacts.set(file.path, linkedArtifact);
            this.plugin.memoryIndex.upsert(linkedArtifact);
            if (artifactId !== frontmatterArtifactId) {
              await this.app.fileManager.processFrontMatter(file, (current) => {
                current.video_artifact_id = artifactId;
              });
            }
          } catch (error) {
            console.warn(`课程工件关联失败: ${file.path}`, error);
          }
        }
        const alreadyComplete = Boolean(artifactId);
        item.progress = {
          ...item.progress,
          status: alreadyComplete ? 'complete' : 'pending',
          percent: alreadyComplete ? 100 : 0,
          note_path: file.path,
          ...(artifactId ? { artifact_id: artifactId } : {}),
          updated_at: new Date().toISOString(),
        };
        this.progress.completed += 1;
        reusableNotes.set(item.canonical_key, file);
        manifest.progress = summarizeCourseProgress(manifest.items);
        manifest = await this.courseStore.save(manifest);
        await this.writeCourseIndex(manifest);
      }
      manifest.progress = summarizeCourseProgress(manifest.items);
      manifest = await this.courseStore.save(manifest);
      await this.writeCourseIndex(manifest);
      this.progress.status = 'complete';
      this.progress.current = '';
      this.updateProgressDisplay();
      this.selectedPlaylistKeys.clear();
      this.courseImport = compileCourseImport(this.playlistInfo, manifest);
      this.updateStartButton();
      new Notice(
        `课程已导入：${this.progress.completed} 条待处理笔记，未调用 AI${
          this.progress.failed > 0 ? `，${this.progress.failed} 条创建失败` : ''
        }`,
        5000,
      );
    } catch (error) {
      console.error('课程导入失败:', error);
      this.progress.status = 'error';
      this.updateProgressDisplay();
      new Notice(`❌ 课程导入失败: ${messageOf(error)}`, 0);
    }
  }

  /**
   * Recover a note created just before an interrupted manifest write. Reusing
   * the canonical source prevents an import retry from creating duplicates.
   */
  private async indexReusableCourseNotes(courseId: string): Promise<Map<string, TFile>> {
    const byKey = new Map<string, TFile>();
    for (const file of this.app.vault.getMarkdownFiles()) {
      const cached = this.app.metadataCache.getFileCache(file)?.frontmatter;
      const existingCourseId = String(cached?.video_course_id || '').trim();
      if (existingCourseId && existingCourseId !== courseId) continue;
      let link = '';
      if (typeof cached?.link === 'string') link = cached.link.trim();
      if (!link) {
        const content = await this.app.vault.cachedRead(file);
        link = this.noteProcessor.extractVideoUrl(content) || '';
      }
      if (!link) continue;
      try {
        const canonical = canonicalizeVideoUrl(link);
        if (!byKey.has(canonical.canonicalKey)) byKey.set(canonical.canonicalKey, file);
      } catch {
        // Non-playlist video notes are irrelevant to this recovery index.
      }
    }
    return byKey;
  }

  private async resolveCourseIndexPath(manifest: CourseManifest): Promise<string> {
    const folder = [this.plugin.settings.outputFolder || '', '课程'].filter(Boolean).join('/');
    await this.ensureDirectoryExists(folder);
    const base = courseIndexBaseName(manifest);
    let path = folder ? `${folder}/${base}.md` : `${base}.md`;
    let suffix = 1;
    while (await this.app.vault.adapter.exists(path)) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        const content = await this.app.vault.read(file);
        if (content.includes(`course_id: ${manifest.course_id}`)) return path;
      }
      path = folder ? `${folder}/${base} (${suffix}).md` : `${base} (${suffix}).md`;
      suffix += 1;
    }
    return path;
  }

  private async writeCourseIndex(manifest: CourseManifest): Promise<void> {
    await syncCourseIndexAtomic(this.app.vault, this.courseStore, manifest.course_id);
  }

  private async ensureDirectoryExists(dirPath: string): Promise<void> {
    const parts = dirPath.split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        await this.app.vault.createFolder(current);
      }
    }
  }

  private updateProgressDisplay() {
    if (!this.progressEl) return;

    this.progressEl.empty();

    const statusText =
      this.progress.status === 'running'
        ? '⏳ 处理中'
        : this.progress.status === 'complete'
          ? '✅ 完成'
          : this.progress.status === 'error'
            ? '❌ 错误'
            : '📺 就绪';

    this.progressEl.createEl('h3', { text: `批量处理状态: ${statusText}` });

    if (this.progress.total > 0) {
      const progressBar = this.progressEl.createEl('div', { cls: 'progress-bar' });
      const progressFill = progressBar.createEl('div', { cls: 'progress-fill' });
      const progress = (this.progress.completed + this.progress.failed) / this.progress.total;
      progressFill.style.width = `${progress * 100}%`;

      this.progressEl.createEl('p', {
        text: `进度: ${this.progress.completed + this.progress.failed}/${this.progress.total}`,
      });
      this.progressEl.createEl('p', {
        text: `成功: ${this.progress.completed}, 失败: ${this.progress.failed}`,
      });

      if (this.progress.current) {
        this.progressEl.createEl('p', {
          text: `当前处理: ${this.progress.current}`,
          cls: 'current-file',
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
          statusSummary.createEl('div', {
            cls: 'status-item success',
            text: `✅ 已完成: ${this.progress.completed} 个`,
          });
          statusSummary.createEl('div', {
            cls: 'status-item error',
            text: `❌ 失败: ${this.progress.failed} 个`,
          });
          statusSummary.createEl('div', {
            cls: 'status-item pending',
            text: `⏳ 待处理: ${this.progress.total - processedCount} 个`,
          });
        }
      }
    }
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
