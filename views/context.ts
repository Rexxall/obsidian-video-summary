import VideoSummaryPlugin from '../main';
import { SubmitOptions } from '../core/JobService';

export type PanelTab = 'jobs' | 'library';
export type LibraryFilter = 'all' | 'pending' | 'running' | 'success' | 'error';
export type DetailTab = 'reader' | 'evidence' | 'preview' | 'transcript' | 'meta' | 'logs';

export type DetailRef =
  | { kind: 'job'; id: string }
  | { kind: 'note'; path: string; artifactId: string }
  | { kind: 'history'; file: string; time: string };

export interface ViewState {
  /** 输入框草稿存在 state 里，切换笔记/重绘时不会把用户打了一半的内容清掉 */
  inputDraft: string;
  transcriptDraft: string;
  localFileDraft: string;
  tab: PanelTab;
  detail: DetailRef | null;
  detailTab: DetailTab;
  /** One-shot seek target used when another UI (for example review) opens evidence. */
  readerSeekSeconds?: number;
  librarySearch: string;
  libraryFilter: LibraryFilter;
  librarySort: string;
  /** 忽略缓存（强制重跑），只作用于本次会话 */
  ignoreCache: boolean;
  /** 高级输入区（文稿 / 本地文件 / 分P）是否展开 */
  advancedOpen: boolean;
  /** 分P范围，展开时才用 */
  partsEnabled: boolean;
  partsStart: number;
  partsEnd: number;
}

export type BackendState = 'is-unknown' | 'is-online' | 'is-offline' | 'is-checking';

export interface ViewContext {
  plugin: VideoSummaryPlugin;
  state: ViewState;
  /** 后端连通状态，只影响头部那颗点，不参与处理逻辑 */
  backendState(): BackendState;
  setBackendState(state: BackendState): void;
  /** 只重画下半区（任务/笔记库/详情），输入框内容与滚动位置不受影响 */
  renderPanels(): void;
  /** 重画整个视图，包括顶部行动区 */
  renderAll(): void;
  openNote(path: string): Promise<void>;
  openDetail(ref: DetailRef): void;
  closeDetail(): void;
  submitOptions(): SubmitOptions;
  /** Register DOM/listener cleanup owned by the currently rendered panel. */
  registerPanelCleanup(cleanup: () => void): void;
}
