import { TFile } from 'obsidian';

export interface WebhookAuthConfig {
  /** HTTP header name used by an authenticated n8n Webhook. */
  headerName: string;
  /** Secret header value. An empty string disables webhook authentication. */
  secret: string;
}

export interface WebhookProfile extends WebhookAuthConfig {
  id: string;
  name: string;
  url: string;
}

export type ProcessingDepth = 'quick' | 'evidence' | 'deep-visual';

export type VideoContentType =
  | 'course'
  | 'interview'
  | 'tutorial'
  | 'news'
  | 'meeting'
  | 'review'
  | 'general';

export type RequestedContentType = VideoContentType | 'auto';

export type ContentRoutingSource = 'manual' | 'backend' | 'local' | 'fallback';

export type ContentRoutingSignal =
  | 'request'
  | 'backend'
  | 'title'
  | 'author'
  | 'transcript'
  | 'chapter'
  | 'structure'
  | 'fallback';

export interface ContentPromptSchemaProperty {
  type: 'object' | 'array' | 'string' | 'number' | 'boolean';
  description?: string;
  const?: string;
  required?: string[];
  properties?: Record<string, ContentPromptSchemaProperty>;
  items?: ContentPromptSchemaProperty;
}

export interface ContentPromptOutputSchema {
  type: 'object';
  required: string[];
  properties: Record<string, ContentPromptSchemaProperty>;
}

export interface ContentPromptSection {
  key: string;
  heading: string;
  purpose: string;
  required: boolean;
  evidence: 'required' | 'recommended' | 'optional';
}

export interface ContentPromptProfile {
  id: string;
  version: number;
  content_type: VideoContentType;
  objective: string;
  sections: ContentPromptSection[];
  output_schema: ContentPromptOutputSchema;
  guardrails: string[];
}

export interface ContentRoutingReason {
  signal: ContentRoutingSignal;
  message: string;
  weight?: number;
}

export interface ContentRoutingDecision {
  type: VideoContentType;
  confidence: number;
  source: ContentRoutingSource;
  reasons: ContentRoutingReason[];
  prompt_profile: ContentPromptProfile;
  candidate_scores?: Partial<Record<VideoContentType, number>>;
}

export type EvidenceSourceType = 'speech' | 'screen' | 'comment' | 'user' | 'ai-inference';

export type TimingQuality = 'exact' | 'aligned' | 'estimated' | 'none';

export interface MediaAssetReference {
  id: string;
  /** Vault-relative or plugin-data-relative path after localization. */
  path?: string;
  /** Remote source URL before localization. */
  url?: string;
  mime_type?: string;
  sha256?: string;
  width?: number;
  height?: number;
  bytes?: number;
}

export interface VideoSegment {
  /** Stable across reprocessing when source URL, timestamp, and text are unchanged. */
  id: string;
  start: number | null;
  end?: number | null;
  text: string;
  speaker?: string;
  source: EvidenceSourceType;
  timing_quality?: TimingQuality;
  timestamp_url?: string;
  keyframe?: MediaAssetReference;
  visual_text?: string;
  confidence?: number;
}

export interface VisualEvidence {
  id: string;
  start: number;
  end?: number;
  description: string;
  ocr_text?: string;
  keyframe?: MediaAssetReference;
  kind?: 'slide' | 'chart' | 'code' | 'interface' | 'object' | 'scene' | 'other';
  confidence?: number;
}

export interface EvidenceReference {
  segment_id: string;
  source: EvidenceSourceType;
  quote?: string;
  asset_id?: string;
}

export interface EvidenceClaim {
  id: string;
  claim: string;
  evidence: EvidenceReference[];
  start?: number | null;
  end?: number | null;
  confidence?: number;
  review_state?: 'supported' | 'needs-review' | 'inference';
}

export interface AttentionRange {
  start: number;
  end: number;
  reason: string;
}

export interface AttentionAssessment {
  action: 'watch' | 'skim' | 'skip';
  score?: number;
  confidence?: number;
  rationale: string;
  context?: string;
  information_density?: number;
  originality?: number;
  actionability?: number;
  vault_relevance?: number;
  promotional_ratio?: number;
  estimated_useful_seconds?: number;
  evidence_segment_ids?: string[];
  limitations?: string[];
  must_watch?: AttentionRange[];
  skippable?: AttentionRange[];
}

export interface LearningCard {
  id: string;
  /** Optional backend id retained only as provenance; local id is content-stable. */
  provider_id?: string;
  front: string;
  back: string;
  evidence_segment_ids?: string[];
  tags?: string[];
}

export interface QuizQuestion {
  id: string;
  /** Optional backend id retained only as provenance; local id is content-stable. */
  provider_id?: string;
  prompt: string;
  choices?: string[];
  answer: string;
  explanation?: string;
  evidence_segment_ids?: string[];
  difficulty?: 'easy' | 'medium' | 'hard';
}

export interface LearningPackage {
  flashcards?: LearningCard[];
  questions?: QuizQuestion[];
  feynman_prompts?: string[];
}

export interface ArtifactProvenance {
  schema_version: number;
  artifact_id?: string;
  source_url?: string;
  source_hash?: string;
  transcript_hash?: string;
  /** Complete cache identity for this exact source + processing configuration. */
  fingerprint?: string;
  fingerprint_version?: number;
  fingerprint_digest?: string;
  run_hash?: string;
  backend?: ProcessingBackend;
  model?: string;
  prompt_profile?: string;
  prompt_version?: string;
  processing_depth?: ProcessingDepth;
  content_routing?: {
    source: ContentRoutingSource;
    confidence: number;
    reasons: string[];
    prompt_profile: string;
  };
  generated_at?: string;
  transcript_source?: string;
  /** Exact Vault-relative root used by the plugin's verified media localizer. */
  media_asset_root?: string;
  warnings?: string[];
}

export interface RelatedNoteSuggestion {
  note_path: string;
  relation: 'supplements' | 'repeats' | 'conflicts' | 'updates' | 'related';
  reason: string;
  confidence?: number;
}

export interface UserHighlight {
  id: string;
  segment_id: string;
  note?: string;
  created_at: string;
  /** Previous segment id when a reprocess changed segmentation. */
  original_segment_id?: string;
  /** The highlight was retained but its new segment mapping needs user review. */
  needs_review?: boolean;
}

export interface VideoKnowledgeArtifact {
  schema_version: number;
  artifact_id: string;
  source: {
    url?: string;
    local_file?: string;
    note_path?: string;
    /** Stable identity for transcript-only inputs whose note may be renamed. */
    transcript_hash?: string;
    source_hash: string;
  };
  title?: string;
  author?: string;
  platform?: string;
  duration?: string;
  cover?: string;
  content_type?: VideoContentType;
  timing_quality: TimingQuality;
  transcript?: string;
  segments: VideoSegment[];
  claims: EvidenceClaim[];
  visual_evidence: VisualEvidence[];
  attention?: AttentionAssessment;
  learning?: LearningPackage;
  related_notes: RelatedNoteSuggestion[];
  highlights: UserHighlight[];
  course_ids: string[];
  provenance: ArtifactProvenance;
  created_at: string;
  updated_at: string;
}

export interface VideoSummarySettings {
  // API 配置
  activeBackend: ProcessingBackend;
  n8nWebhookUrl: string;
  codexWorkerUrl: string;
  webhookProfiles: WebhookProfile[];
  activeWebhookId: string;
  setupGuideDismissed: boolean;

  // 处理配置
  defaultLanguage: 'zh' | 'en' | 'ja';
  defaultMode: ProcessingMode;
  defaultProcessingDepth: ProcessingDepth;
  defaultContentType: RequestedContentType;
  autoRouteContent: boolean;
  attentionAssessmentEnabled: boolean;
  generateLearningArtifacts: boolean;
  /** 纸墨风格：默认关，打开后在 body 上加 vs-paper，叠加纸感和细墨线 */
  paperStyle: boolean;
  /** 阅读器里复制或插入文稿段落时用的 Markdown 模板 */
  readerQuoteTemplate: string;
  aiModel: string;
  customAiModels: string[];
  timeoutMinutes: number;
  autoSave: boolean;

  // 批量处理配置
  batchConcurrency: number;

  // 输出配置
  outputFolder: string;
  // 自动重命名配置
  autoRenameEnabled: boolean;
  renameConflictStrategy: 'skip' | 'append-number' | 'append-date';

  // 高级配置
  enableDebugMode: boolean;
  retryCount: number;

  // 成功状态自定义
  successStatusValue: string;

  // 缓存配置
  enableCache: boolean;
  cacheExpiryDays: number;

  // 一键处理配置
  quickSummaryOptions: QuickProcessingOptions;
  quickTranscriptOptions: QuickProcessingOptions;

  // Payload 键配置
  payloadKeys: PayloadKeys;

  // UI 配置
  fileListSortBy: string; // 文件列表排序方式
  historySortBy: string; // 历史记录排序方式
  statusFilterValue: string; // 状态筛选值
  /** 侧栏当前停留的分页：任务流 / 笔记库 */
  activePanelTab: 'jobs' | 'library';
  /** 处理完先进预览，确认后才写入笔记 */
  previewBeforeWrite: boolean;

  // 历史记录
  // 注意：history / webhookHistory 自 2.2.0 起持久化在插件目录的 history.json，
  // 不再写入 data.json（避免 data.json 无限膨胀）。内存中仍挂在 settings 上以兼容视图。
  history: ProcessingHistory[];
  webhookHistory: WebhookHistoryEntry[];
  historyLimit: number;

  // 处理前后端自检
  preflightCheckEnabled: boolean;

  // 短链自动展开
  expandShortLinks: boolean;

  // cookies 目录（n8n docker/cookies 的绝对路径，桌面端）
  cookiesDirPath: string;
}

export interface PayloadKeys {
  mode: string;
  language: string;
  ai: string;
  info_only: string;
  link: string;
  provided_transcript: string;
  local_file: string;
}

export type ProcessingBackend = 'n8n' | 'codex-worker';

export interface QuickProcessingOptions {
  language: 'zh' | 'en' | 'ja';
  mode: ProcessingMode;
  outputFolder: string;
  timeoutMinutes: number;
}

export interface ProcessingHistory {
  file: string;
  time: string;
  result: 'success' | 'error';
  mode: ProcessingMode;
  language?: string;
  // 以下字段自 2.3.0 起记录；旧记录没有，读的时候都当可选处理
  url?: string;
  platform?: string;
  /** 失败原因原文，界面直接显示，不用再翻控制台 */
  error?: string;
  durationMs?: number;
}

export interface WebhookHistoryEntry {
  result: ProcessingResult;
  input: VideoInput;
  mode: ProcessingMode;
  language: SupportedLanguage;
  timestamp: number;
}

export interface ConnectionTestResult {
  success: boolean;
  durationMs?: number;
  status?: number;
  bodySnippet?: string;
  error?: string;
  hint?: string;
  workflow?: WorkflowHealthInfo;
  warnings?: string[];
}

export interface SetupCheckItem {
  label: string;
  state: 'ready' | 'warning' | 'missing';
  detail: string;
}

export interface WorkflowHealthInfo {
  name?: string;
  version?: string;
  variant?: string;
  webhookPath?: string;
  models?: string[];
  requiredTools?: string[];
  uploadsPath?: string;
}

export interface PlatformCapability {
  platform: string;
  status: 'recommended' | 'supported' | 'limited' | 'local';
  input: string;
  requirements: string;
  notes: string;
}

export type ProcessingMode = 'summary' | 'transcript-only' | 'info-only';

export type SupportedLanguage = 'zh' | 'en' | 'ja';

export interface VideoInput {
  url?: string;
  /** Stable source identity retained when the backend must not fetch the URL. */
  sourceUrl?: string;
  transcript?: string;
  localFile?: string;
  localFiles?: string[];
  merge?: boolean;
  processingDepth?: ProcessingDepth;
  contentType?: RequestedContentType;
  autoRoute?: boolean;
  attentionAssessment?: boolean;
  generateLearning?: boolean;
  artifactId?: string;
  highlightedSegmentIds?: string[];
  /** Reprocess only persisted raw inputs; the backend must not download/transcribe. */
  skipSourceFetch?: boolean;
  /** Integrity-checked evidence snapshot used by no-fetch reprocessing. */
  persistedSegments?: VideoSegment[];
  persistedEvidenceClaims?: EvidenceClaim[];
  persistedVisualEvidence?: VisualEvidence[];
  persistedRun?: {
    backend: ProcessingBackend;
    model: string;
    prompt: string;
    version: string;
  };
}

export interface ProcessingResult {
  summary?: string;
  note?: string;
  video_transcript?: string;
  video_title?: string;
  video_author?: string;
  video_duration?: string;
  /** 后端返回的视频封面；只作为展示元数据，不主动联网补抓 */
  video_cover?: string;
  video_id?: string;
  video_platform?: string;
  video_published_at?: string;
  transcript_source?: string;
  timing_quality?: TimingQuality;
  video_segments?: VideoSegment[];
  evidence_claims?: EvidenceClaim[];
  visual_evidence?: VisualEvidence[];
  content_type?: VideoContentType;
  content_routing?: ContentRoutingDecision;
  attention?: AttentionAssessment;
  learning?: LearningPackage;
  artifact?: ArtifactProvenance;
  related_notes?: RelatedNoteSuggestion[];
  error?: string;
}

export interface ProcessingStatus {
  stage: 'idle' | 'running' | 'complete' | 'error';
  message: string;
  progress: number;
  file?: string;
}

export interface BatchProcessingOptions {
  mode: ProcessingMode;
  language: SupportedLanguage;
  files: TFile[];
  concurrency: number;
}

export interface VideoMetadata {
  title?: string;
  author?: string;
  duration?: number;
  platform?: string;
  url?: string;
}

export interface NoteMetadata {
  status?: string;
  video_summary_status?: string;
  video_summary?: boolean;
  source_type?: string;
  link?: string;
  video_title?: string;
  video_author?: string;
  video_duration?: string;
  video_cover?: string;
  video_artifact_id?: string;
  video_content_type?: string;
  video_attention_action?: string;
  video_processing_depth?: string;
  video_review_due?: string;
  summary?: string;
  video_transcript?: string;
  date?: string;
}

// 缓存项类型定义
export interface CacheItem {
  url: string;
  mode: ProcessingMode;
  language: SupportedLanguage;
  result: ProcessingResult;
  timestamp: number;
  expiryTimestamp: number;
}

// 缓存配置
export interface CacheConfig {
  enabled: boolean;
  expiryDays: number;
  maxSize: number;
}

export interface APIResponse {
  success: boolean;
  data?: ProcessingResult;
  error?: string;
  message?: string;
}

export interface BatchProgress {
  total: number;
  completed: number;
  failed: number;
  current: string;
  status: 'idle' | 'running' | 'complete' | 'error';
}

export interface PlaylistItem {
  bvid: string;
  title: string;
  author: string;
  duration?: string;
  url: string;
}

export interface PlaylistInfo {
  title: string;
  description?: string;
  itemCount: number;
  items: PlaylistItem[];
}
