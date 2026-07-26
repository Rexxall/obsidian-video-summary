// agent: claude (2026-07-26) — v2.3.0 侧栏重构：行动区 / 任务流 / 笔记库 / 详情四层
import { ItemView, TFile, WorkspaceLeaf } from 'obsidian';
import VideoSummaryPlugin from '../main';
import { SubmitOptions } from '../core/JobService';
import { DetailRef, PanelTab, ViewContext, ViewState } from './context';
import { renderActionBar } from './panels/ActionBar';
import { renderJobsPanel } from './panels/JobsPanel';
import { renderLibraryPanel, resetLibraryPaging } from './panels/LibraryPanel';
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

    this.headerEl = container.createDiv({ cls: 'vs-top' });
    this.panelEl = container.createDiv({ cls: 'vs-panels' });

    this.unsubscribe.push(this.plugin.jobs.subscribe(() => this.schedulePanelRender()));
    this.unsubscribe.push(this.plugin.noteIndex.subscribe(() => this.schedulePanelRender()));
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.renderAll()));

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
    const tabs: Array<[PanelTab, string]> = [
      ['jobs', activeCount > 0 ? `任务 ${activeCount}` : '任务'],
      ['library', `笔记库 ${libraryCount}`],
    ];

    const row = panel.createDiv({ cls: 'vs-tab-row' });
    tabs.forEach(([value, label]) => {
      const tab = row.createEl('button', {
        text: label,
        cls: `vs-tab${this.state.tab === value ? ' is-active' : ''}`,
        attr: { type: 'button' },
      });
      tab.addEventListener('click', async () => {
        if (this.state.tab === value) return;
        this.state.tab = value;
        this.plugin.settings.activePanelTab = value;
        await this.plugin.saveSettings();
        if (value === 'library') resetLibraryPaging();
        this.renderPanels();
      });
    });
  }

  private openNote(path: string) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      void this.app.workspace.getLeaf(false).openFile(file);
    }
  }
}
