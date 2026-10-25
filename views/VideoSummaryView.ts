import { ItemView, Notice, TFile, WorkspaceLeaf } from 'obsidian';
import { relinkVideoJobs } from '../utils/NoteOutput';
import VideoSummaryPlugin from '../main';
import { SubmitOptions } from '../core/JobService';
import { BackendState, DetailRef, PanelTab, ViewContext, ViewState } from './context';
import { renderActionBar } from './panels/ActionBar';
import { renderJobsPanel } from './panels/JobsPanel';
import {
  disconnectLibraryCoverObserver,
  renderLibraryPanel,
  resetLibraryPaging,
} from './panels/LibraryPanel';
import { renderDetailPanel } from './panels/DetailPanel';
import { segmented } from './ui';

export const VIDEO_SUMMARY_VIEW_TYPE = 'video-summary-view';

export class VideoSummaryView extends ItemView {
  private plugin: VideoSummaryPlugin;
  private state: ViewState;
  private actionHeaderEl: HTMLElement | null = null;
  private panelEl: HTMLElement | null = null;
  private unsubscribe: Array<() => void> = [];
  private renderQueued = false;
  private tickTimer: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private lastActiveFilePath = '';
  private backend: BackendState = 'is-unknown';
  private panelCleanup: Array<() => void> = [];

  constructor(leaf: WorkspaceLeaf, plugin: VideoSummaryPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.state = {
      inputDraft: '',
      transcriptDraft: '',
      localFileDraft: '',
      tab: plugin.settings.activePanelTab || 'jobs',
      detail: null,
      detailTab: 'preview',
      librarySearch: '',
      libraryFilter: (plugin.settings.statusFilterValue as ViewState['libraryFilter']) || 'all',
      librarySort: plugin.settings.fileListSortBy || 'mtime-desc',
      ignoreCache: false,
      advancedOpen: false,
      partsEnabled: false,
      partsStart: 1,
      partsEnd: 5,
    };
  }

  getViewType(): string {
    return VIDEO_SUMMARY_VIEW_TYPE;
  }

  getDisplayText(): string {
    return '视频总结';
  }

  getIcon(): string {
    return 'video';
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass('video-summary-view');
    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? container.clientWidth;
      container.toggleClass('is-narrow', width <= 520);
      container.toggleClass('is-tiny', width <= 260);
    });
    this.resizeObserver.observe(container);
    container.toggleClass('is-narrow', container.clientWidth <= 520);
    container.toggleClass('is-tiny', container.clientWidth <= 260);

    this.actionHeaderEl = container.createDiv({ cls: 'vs-top' });
    this.panelEl = container.createDiv({ cls: 'vs-panels' });

    this.unsubscribe.push(this.plugin.jobs.subscribe(() => this.schedulePanelRender()));
    this.unsubscribe.push(this.plugin.noteIndex.subscribe(() => this.schedulePanelRender()));
    // 只在真的换了笔记时重画顶部，点侧栏内部不触发重建
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        const path = this.app.workspace.getActiveFile()?.path ?? '';
        if (path === this.lastActiveFilePath) return;
        this.lastActiveFilePath = path;
        this.renderAll();
      }),
    );

    // 只在有任务在跑时开计时器刷新"已用 xx"，空闲时不空转
    this.tickTimer = window.setInterval(() => {
      if (
        this.plugin.jobs.getActive().length > 0 &&
        this.state.tab === 'jobs' &&
        !this.state.detail
      ) {
        this.schedulePanelRender();
      }
    }, 1000);

    this.renderAll();
  }

  async onClose(): Promise<void> {
    disconnectLibraryCoverObserver();
    this.unsubscribe.forEach((off) => off());
    this.unsubscribe = [];
    if (this.tickTimer !== null) {
      window.clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.cleanupPanelResources();
  }

  /** 兼容旧调用方（main.ts 里的 refreshVideoSummaryView） */
  async refreshView(): Promise<void> {
    this.renderAll();
  }

  /** Open a persisted artifact and optionally seek its synchronized reader. */
  openArtifact(notePath: string, artifactId: string, seekSeconds?: number): void {
    this.state.tab = 'library';
    this.state.detail = { kind: 'note', path: notePath, artifactId };
    this.state.detailTab = 'reader';
    this.state.readerSeekSeconds =
      typeof seekSeconds === 'number' && Number.isFinite(seekSeconds)
        ? Math.max(0, seekSeconds)
        : undefined;
    this.renderPanels();
  }

  private context(): ViewContext {
    return {
      plugin: this.plugin,
      state: this.state,
      backendState: () => this.backend,
      setBackendState: (state: BackendState) => {
        this.backend = state;
      },
      renderPanels: () => this.renderPanels(),
      renderAll: () => this.renderAll(),
      openNote: (path: string) => this.openNote(path),
      openDetail: (ref: DetailRef) => {
        this.state.detail = ref;
        this.state.detailTab = ref.kind === 'note' ? 'reader' : 'preview';
        this.renderPanels();
      },
      closeDetail: () => {
        this.state.detail = null;
        this.renderPanels();
      },
      submitOptions: (): SubmitOptions => ({
        mode: this.plugin.settings.defaultMode,
        language: this.plugin.settings.defaultLanguage,
        useCache: this.plugin.settings.enableCache && !this.state.ignoreCache,
        previewBeforeWrite: this.plugin.settings.previewBeforeWrite === true,
        processingDepth: this.plugin.settings.defaultProcessingDepth,
        contentType: this.plugin.settings.defaultContentType,
        autoRoute: this.plugin.settings.autoRouteContent,
        attentionAssessment: this.plugin.settings.attentionAssessmentEnabled,
        generateLearning: this.plugin.settings.generateLearningArtifacts,
      }),
      registerPanelCleanup: (cleanup) => {
        this.panelCleanup.push(cleanup);
      },
    };
  }

  private renderAll() {
    if (!this.actionHeaderEl) return;
    this.actionHeaderEl.empty();
    renderActionBar(this.actionHeaderEl, this.context());
    this.renderPanels();
  }

  private schedulePanelRender() {
    if (this.renderQueued) return;
    this.renderQueued = true;
    window.requestAnimationFrame(() => {
      this.renderQueued = false;
      this.renderPanels();
    });
  }

  private renderPanels() {
    const panel = this.panelEl;
    if (!panel) return;
    const scrollTop = panel.scrollTop;
    this.cleanupPanelResources();
    disconnectLibraryCoverObserver();
    panel.empty();

    // 设计稿的笔记库与详情都是独立页面：只在任务页保留顶部输入区。
    // 旧实现把 ActionBar 永久钉在三种页面上方，实际运行时会比 2b/2c 多出半屏内容。
    this.actionHeaderEl?.toggleAttribute(
      'hidden',
      this.state.tab === 'library' || this.state.detail !== null,
    );

    if (this.state.detail) {
      panel.scrollTop = 0;
      renderDetailPanel(panel, this.context());
      return;
    }

    this.renderTabs(panel);
    const body = panel.createDiv({ cls: 'vs-panel-body' });
    if (this.state.tab === 'library') {
      renderLibraryPanel(body, this.context());
    } else {
      renderJobsPanel(body, this.context());
    }
    panel.scrollTop = scrollTop;
  }

  private renderTabs(panel: HTMLElement) {
    const activeCount =
      this.plugin.jobs.getActive().length + this.plugin.jobs.countByState('review');
    const libraryCount = this.plugin.noteIndex.getAll().length;
    const tabs: Array<[PanelTab, string, string | undefined]> = [
      ['jobs', '任务', activeCount > 0 ? String(activeCount) : undefined],
      ['library', '笔记库', String(libraryCount)],
    ];

    const wrapper = panel.createDiv({ cls: 'vs-tab-row' });
    segmented(
      wrapper,
      tabs.map(([value, label, count]) => ({ value, label, count })),
      this.state.tab,
      async (value) => {
        this.state.tab = value;
        this.plugin.settings.activePanelTab = value;
        await this.plugin.saveSettings();
        if (value === 'library') resetLibraryPaging();
        this.renderPanels();
      },
    );
  }

  private async openNote(path: string) {
    let file = this.app.vault.getAbstractFileByPath(path);
    // A task finished before a rename can still point at the old filename.
    if (!(file instanceof TFile)) {
      const job = this.plugin.jobs.getAll().find((item) => item.notePath === path);
      const artifactId = job?.result?.artifact?.artifact_id || job?.input?.artifactId;
      if (artifactId) {
        try {
          const artifact = await this.plugin.artifactStore.load(artifactId);
          const resolved = artifact?.source?.note_path;
          if (resolved) file = this.app.vault.getAbstractFileByPath(resolved);
          if (file instanceof TFile) relinkVideoJobs(this.plugin.jobs, path, file);
        } catch {
          // Missing artifact: fall through to the notice below.
        }
      }
    }
    if (!(file instanceof TFile)) {
      new Notice('笔记已移动或重命名，请从笔记库打开。');
      return;
    }
    try {
      const leaf = this.app.workspace.getLeaf(false);
      await leaf.openFile(file, { active: true });
      await this.app.workspace.revealLeaf(leaf);
    } catch (error) {
      new Notice(`打开笔记失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private cleanupPanelResources() {
    this.panelCleanup.splice(0).forEach((cleanup) => {
      try {
        cleanup();
      } catch (error) {
        console.error('[VideoSummaryView] panel cleanup failed', error);
      }
    });
  }
}
