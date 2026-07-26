// agent: codex (2026-07-26) — v3 preview: move library and review work out of the narrow sidebar
import { ItemView, TFile, WorkspaceLeaf, setIcon } from 'obsidian';
import VideoSummaryPlugin from '../main';
import { BatchProcessingModal } from '../BatchProcessingModal';
import { SubmitOptions } from '../core/JobService';
import { BackendState, DetailRef, PanelTab, ViewContext, ViewState } from './context';
import { renderDetailPanel } from './panels/DetailPanel';
import { renderJobsPanel } from './panels/JobsPanel';
import { renderLibraryPanel, resetLibraryPaging } from './panels/LibraryPanel';
import { segmented } from './ui';

export const VIDEO_SUMMARY_WORKSPACE_VIEW_TYPE = 'video-summary-workspace-view';

export class VideoSummaryWorkspaceView extends ItemView {
  private plugin: VideoSummaryPlugin;
  private state: ViewState;
  private content: HTMLElement | null = null;
  private unsubscribe: Array<() => void> = [];
  private backend: BackendState = 'is-unknown';

  constructor(leaf: WorkspaceLeaf, plugin: VideoSummaryPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.state = {
      inputDraft: '',
      transcriptDraft: '',
      localFileDraft: '',
      tab: 'library',
      detail: null,
      detailTab: 'preview',
      librarySearch: '',
      libraryFilter: 'all',
      librarySort: plugin.settings.fileListSortBy || 'mtime-desc',
      ignoreCache: false,
      advancedOpen: false,
      partsEnabled: false,
      partsStart: 1,
      partsEnd: 5,
    };
  }

  getViewType(): string {
    return VIDEO_SUMMARY_WORKSPACE_VIEW_TYPE;
  }

  getDisplayText(): string {
    return '视频知识工作台';
  }

  getIcon(): string {
    return 'library-big';
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass('video-summary-view');
    container.addClass('video-summary-workspace');
    this.content = container.createDiv({ cls: 'vs-workbench-shell' });

    this.unsubscribe.push(this.plugin.jobs.subscribe(() => this.render()));
    this.unsubscribe.push(this.plugin.noteIndex.subscribe(() => this.render()));
    this.render();
  }

  async onClose(): Promise<void> {
    this.unsubscribe.forEach((off) => off());
    this.unsubscribe = [];
  }

  showTab(tab: PanelTab) {
    this.state.detail = null;
    this.state.tab = tab;
    if (tab === 'library') resetLibraryPaging();
    this.render();
  }

  private context(): ViewContext {
    return {
      plugin: this.plugin,
      state: this.state,
      isWorkspace: true,
      backendState: () => this.backend,
      setBackendState: (state: BackendState) => {
        this.backend = state;
      },
      renderPanels: () => this.render(),
      renderAll: () => this.render(),
      openNote: (path: string) => this.openNote(path),
      openDetail: (ref: DetailRef) => {
        this.state.detail = ref;
        this.state.detailTab = 'preview';
        this.render();
      },
      closeDetail: () => {
        this.state.detail = null;
        this.render();
      },
      openWorkbench: (tab: PanelTab = 'library') => this.showTab(tab),
      submitOptions: (): SubmitOptions => ({
        mode: this.plugin.settings.defaultMode,
        language: this.plugin.settings.defaultLanguage,
        useCache: this.plugin.settings.enableCache,
        previewBeforeWrite: this.plugin.settings.previewBeforeWrite === true,
      }),
    };
  }

  private render() {
    if (!this.content) return;
    this.content.empty();

    if (this.state.detail) {
      const detailHeader = this.content.createDiv({ cls: 'vs-workbench-detail-header' });
      const back = detailHeader.createEl('button', {
        cls: 'vs-workbench-back',
        attr: { type: 'button' },
      });
      const backIcon = back.createSpan();
      setIcon(backIcon, 'arrow-left');
      back.createSpan({ text: '返回工作台' });
      back.addEventListener('click', () => {
        this.state.detail = null;
        this.render();
      });
      renderDetailPanel(this.content.createDiv({ cls: 'vs-workbench-detail' }), this.context());
      return;
    }

    this.renderHeader();
    this.renderStats();
    this.renderNavigation();

    const body = this.content.createDiv({ cls: 'vs-workbench-body' });
    if (this.state.tab === 'jobs') {
      renderJobsPanel(body, this.context());
    } else {
      renderLibraryPanel(body, this.context());
    }
  }

  private renderHeader() {
    const header = this.content!.createDiv({ cls: 'vs-workbench-header' });
    const copy = header.createDiv({ cls: 'vs-workbench-title-wrap' });
    copy.createDiv({ text: 'VIDEO SUMMARY', cls: 'vs-workbench-eyebrow' });
    copy.createEl('h2', { text: '视频知识工作台', cls: 'vs-workbench-title' });
    copy.createDiv({
      text: '在主区域筛选、审阅和整理视频笔记；右侧栏只负责快速提交。',
      cls: 'vs-workbench-subtitle',
    });

    const actions = header.createDiv({ cls: 'vs-workbench-actions' });
    const batch = actions.createEl('button', {
      cls: 'vs-workbench-secondary-btn',
      attr: { type: 'button' },
    });
    const batchIcon = batch.createSpan();
    setIcon(batchIcon, 'layers-3');
    batch.createSpan({ text: '批量处理' });
    batch.addEventListener('click', () => {
      new BatchProcessingModal(this.app, this.plugin).open();
    });
  }

  private renderStats() {
    const entries = this.plugin.noteIndex.getAll();
    const counts = entries.reduce(
      (result, entry) => {
        if (entry.status === 'success') result.success += 1;
        else if (entry.status === 'error') result.error += 1;
        else if (entry.status === 'running') result.running += 1;
        else result.pending += 1;
        return result;
      },
      { pending: 0, running: 0, success: 0, error: 0 },
    );
    const active =
      this.plugin.jobs.getActive().length + this.plugin.jobs.countByState('review');

    const stats = this.content!.createDiv({ cls: 'vs-workbench-stats' });
    [
      ['全部笔记', entries.length, 'file-stack'],
      ['待整理', counts.pending, 'inbox'],
      ['需要处理', counts.error, 'circle-alert'],
      ['当前任务', active, 'loader-circle'],
    ].forEach(([label, value, iconName]) => {
      const item = stats.createDiv({ cls: 'vs-workbench-stat' });
      const icon = item.createSpan({ cls: 'vs-workbench-stat-icon' });
      setIcon(icon, String(iconName));
      const text = item.createDiv();
      text.createDiv({ text: String(value), cls: 'vs-workbench-stat-value' });
      text.createDiv({ text: String(label), cls: 'vs-workbench-stat-label' });
    });
  }

  private renderNavigation() {
    const wrapper = this.content!.createDiv({ cls: 'vs-workbench-nav' });
    const activeCount =
      this.plugin.jobs.getActive().length + this.plugin.jobs.countByState('review');
    segmented(
      wrapper,
      [
        {
          value: 'library' as PanelTab,
          label: '笔记库',
          count: String(this.plugin.noteIndex.getAll().length),
          icon: 'library-big',
        },
        {
          value: 'jobs' as PanelTab,
          label: '任务与记录',
          count: activeCount > 0 ? String(activeCount) : undefined,
          icon: 'list-checks',
        },
      ],
      this.state.tab,
      (value) => this.showTab(value),
    );
  }

  private openNote(path: string) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      void this.app.workspace.getLeaf(false).openFile(file);
    }
  }
}
