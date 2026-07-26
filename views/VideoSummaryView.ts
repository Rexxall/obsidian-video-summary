// agent: claude (2026-07-26) — v2.3.0 侧栏重构：行动区 / 任务流 / 笔记库 / 详情四层
import { ItemView, TFile, WorkspaceLeaf, setIcon } from 'obsidian';
import VideoSummaryPlugin from '../main';
import { SubmitOptions } from '../core/JobService';
import { BackendState, DetailRef, PanelTab, ViewContext, ViewState } from './context';
import { renderActionBar } from './panels/ActionBar';
import { renderJobsPanel } from './panels/JobsPanel';
import { renderDetailPanel } from './panels/DetailPanel';

export const VIDEO_SUMMARY_VIEW_TYPE = 'video-summary-view';

export class VideoSummaryView extends ItemView {
  private plugin: VideoSummaryPlugin;
  private state: ViewState;
  private headerEl: HTMLElement | null = null;
  private panelEl: HTMLElement | null = null;
  private unsubscribe: Array<() => void> = [];
  private renderQueued = false;
  private tickTimer: number | null = null;
  private lastActiveFilePath = '';
  private backend: BackendState = 'is-unknown';

  constructor(leaf: WorkspaceLeaf, plugin: VideoSummaryPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.state = {
      inputDraft: '',
      transcriptDraft: '',
      localFileDraft: '',
      tab: 'jobs',
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

    this.headerEl = container.createDiv({ cls: 'vs-top' });
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
    this.unsubscribe.forEach((off) => off());
    this.unsubscribe = [];
    if (this.tickTimer !== null) {
      window.clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  /** 兼容旧调用方（main.ts 里的 refreshVideoSummaryView） */
  async refreshView(): Promise<void> {
    this.renderAll();
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
        this.state.detailTab = 'preview';
        this.renderPanels();
      },
      closeDetail: () => {
        this.state.detail = null;
        this.renderPanels();
      },
      openWorkbench: (tab: PanelTab = 'library') => {
        void this.plugin.openVideoSummaryWorkbench(tab);
      },
      submitOptions: (): SubmitOptions => ({
        mode: this.plugin.settings.defaultMode,
        language: this.plugin.settings.defaultLanguage,
        useCache: this.plugin.settings.enableCache && !this.state.ignoreCache,
        previewBeforeWrite: this.plugin.settings.previewBeforeWrite === true,
      }),
    };
  }

  private renderAll() {
    if (!this.headerEl) return;
    this.headerEl.empty();
    renderActionBar(this.headerEl, this.context());
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
    panel.empty();

    if (this.state.detail) {
      renderDetailPanel(panel, this.context());
      return;
    }

    this.renderSidebarNavigation(panel);
    const body = panel.createDiv({ cls: 'vs-panel-body' });
    renderJobsPanel(body, this.context());
    panel.scrollTop = scrollTop;
  }

  private renderSidebarNavigation(panel: HTMLElement) {
    const activeCount =
      this.plugin.jobs.getActive().length + this.plugin.jobs.countByState('review');
    const libraryCount = this.plugin.noteIndex.getAll().length;
    const wrapper = panel.createDiv({ cls: 'vs-sidebar-nav' });
    const label = wrapper.createDiv({ cls: 'vs-sidebar-nav-label' });
    label.createSpan({ text: activeCount > 0 ? `当前任务 ${activeCount}` : '最近活动' });
    if (activeCount === 0) {
      label.createSpan({ text: ' · 队列空闲', cls: 'vs-sidebar-nav-muted' });
    }

    const library = wrapper.createEl('button', {
      cls: 'vs-open-workbench',
      attr: {
        type: 'button',
        title: `在主区域打开视频知识工作台（${libraryCount} 篇）`,
      },
    });
    library.createSpan({ text: `知识库 ${libraryCount}` });
    const openIcon = library.createSpan({ cls: 'vs-open-workbench-icon' });
    setIcon(openIcon, 'arrow-up-right');
    library.addEventListener('click', () => {
      void this.plugin.openVideoSummaryWorkbench('library');
    });
  }

  private openNote(path: string) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      void this.app.workspace.getLeaf(false).openFile(file);
    }
  }
}
