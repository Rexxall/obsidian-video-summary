import { DEFAULT_QUOTE_TEMPLATE } from './core/TranscriptQuote';
import type { PlatformCapability, VideoSummarySettings, WorkflowHealthInfo } from './types';

// 已知的短链域名：发给后端前先展开成最终链接，减少一类下载失败
export const SHORT_LINK_HOSTS = [
  'b23.tv',
  'v.douyin.com',
  'vm.tiktok.com',
  'vt.tiktok.com',
  'xhslink.com',
  'xhs.cn',
];

// history.json 的默认上限（history 条数；webhookHistory 固定上限见 API 内部）
export const DEFAULT_HISTORY_LIMIT = 300;

export const DEFAULT_AI_MODELS: string[] = ['Gemini 3.1', 'Gemini 3.0'];
export const DEFAULT_WEBHOOK_AUTH_HEADER = 'X-Video-Summary-Token';
export const DEFAULT_N8N_WEBHOOK_URL = 'http://127.0.0.1:5678/webhook/obsidian-video-summary';
export const LEGACY_DEFAULT_N8N_WEBHOOK_URL =
  'http://localhost:5678/webhook/obsidian-video-summary';
export const LEGACY_N8N_WEBHOOK_URL = 'http://localhost:5678/webhook/cyrus';
export const RECOMMENDED_WORKFLOW: Required<WorkflowHealthInfo> = {
  name: 'Video Summary Advanced Workflow',
  version: '2.1.5',
  variant: 'advanced',
  webhookPath: 'obsidian-video-summary',
  models: [...DEFAULT_AI_MODELS],
  requiredTools: ['yt-dlp', 'ffmpeg'],
  uploadsPath: '/home/node/uploads',
};

export const PLATFORM_CAPABILITIES: PlatformCapability[] = [
  {
    platform: '本地音频/视频',
    status: 'recommended',
    input: 'local_file',
    requirements: '把文件放进 docker/uploads，只填写根目录内的文件名。',
    notes: '最稳定，适合长录音、会议、课程和个人素材。',
  },
  {
    platform: 'YouTube',
    status: 'supported',
    input: 'link',
    requirements: '公开视频通常可用；受限视频可能需要 cookies。',
    notes: 'workflow 会先试原生字幕，再回退到音频提取。',
  },
  {
    platform: 'Bilibili',
    status: 'supported',
    input: 'link',
    requirements: '公开视频通常可用；受限视频或部分分 P 仍可能需要 cookies。',
    notes: 'yt-dlp 遇到 HTTP 412 时会回退到公开 API 读取元数据与音轨。',
  },
  {
    platform: '抖音',
    status: 'limited',
    input: 'link',
    requirements: '经常需要浏览器导出的 cookies。',
    notes: '短链可能过期或跳转失败；必要时改用最终链接或粘贴文稿。',
  },
  {
    platform: 'TikTok',
    status: 'limited',
    input: 'link',
    requirements: '经常需要 cookies，也可能受地区限制。',
    notes: '下载失败通常是平台访问问题，不一定是 Obsidian 笔记问题。',
  },
  {
    platform: '小红书 / Rednote',
    status: 'limited',
    input: 'link',
    requirements: '通常需要 cookies，部分分享链接不稳定。',
    notes: '建议作为 best-effort 处理；先保存来源信息再处理。',
  },
  {
    platform: '手动粘贴文稿',
    status: 'local',
    input: 'provided_transcript',
    requirements: '不依赖下载器。',
    notes: '平台下载受阻但你已有文字时，优先用这个方式。',
  },
];

export const DEFAULT_SETTINGS: VideoSummarySettings = {
  activeBackend: 'n8n',
  n8nWebhookUrl: DEFAULT_N8N_WEBHOOK_URL,
  codexWorkerUrl: 'http://127.0.0.1:8787/video-summary/process-sync',
  webhookProfiles: [
    {
      id: 'default-webhook',
      name: 'Local n8n',
      url: DEFAULT_N8N_WEBHOOK_URL,
      headerName: DEFAULT_WEBHOOK_AUTH_HEADER,
      secret: '',
    },
  ],
  activeWebhookId: 'default-webhook',
  setupGuideDismissed: false,
  defaultLanguage: 'zh',
  defaultMode: 'summary',
  defaultProcessingDepth: 'evidence',
  defaultContentType: 'auto',
  autoRouteContent: true,
  attentionAssessmentEnabled: true,
  generateLearningArtifacts: false,
  paperStyle: false,
  readerQuoteTemplate: DEFAULT_QUOTE_TEMPLATE,
  aiModel: 'Gemini 3.1',
  customAiModels: [...DEFAULT_AI_MODELS],
  timeoutMinutes: 30,
  autoSave: true,
  batchConcurrency: 3,
  outputFolder: '',
  autoRenameEnabled: true,
  renameConflictStrategy: 'append-number',
  enableDebugMode: false,
  retryCount: 2,
  successStatusValue: 'success',
  enableCache: true, // 默认启用缓存
  cacheExpiryDays: 30, // 默认缓存30天
  quickSummaryOptions: {
    language: 'zh',
    mode: 'summary',
    outputFolder: '',
    timeoutMinutes: 30,
  },
  quickTranscriptOptions: {
    language: 'zh',
    mode: 'transcript-only',
    outputFolder: '',
    timeoutMinutes: 30,
  },
  fileListSortBy: 'ctime-desc', // 默认按创建时间（最新）排序
  historySortBy: 'time-desc', // 默认按时间（最新）排序
  statusFilterValue: 'all', // 默认显示全部状态
  activePanelTab: 'jobs', // 侧栏默认停在任务流
  previewBeforeWrite: false, // 默认沿用直接写入；打开后结果先预览再落笔记
  history: [],
  webhookHistory: [],
  historyLimit: DEFAULT_HISTORY_LIMIT,
  preflightCheckEnabled: true, // 处理前先 ping 后端，失败时提示/建议切换
  expandShortLinks: true, // 短链（b23.tv / v.douyin.com 等）先展开再发给后端
  cookiesDirPath: '', // n8n docker/cookies 目录的绝对路径（桌面端 cookies 管理用）
  payloadKeys: {
    mode: 'mode',
    language: 'language',
    ai: 'ai',
    info_only: 'info_only',
    link: 'link',
    provided_transcript: 'provided_transcript',
    local_file: 'local_file',
  },
};

// 平台列表统一来自共享单一来源（vendored @video-summary/shared，由 sync 脚本同步）。
export { SUPPORTED_PLATFORMS } from './shared';

export const LANGUAGE_OPTIONS = [
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
];

export const PROCESSING_MODES = [
  { value: 'summary', label: '完整总结' },
  { value: 'transcript-only', label: '仅提取文稿' },
  { value: 'info-only', label: '仅获取视频信息' },
];

export const STATUS_ICONS = {
  idle: '📺',
  running: '⏳',
  complete: '✅',
  error: '❌',
};

export const ERROR_MESSAGES = {
  NO_FILE: '请先打开一个笔记',
  NO_LINK: '笔记中没有找到视频链接',
  NO_TRANSCRIPT: '笔记中没有找到文稿内容',
  NO_INPUT: '请提供视频链接、文稿内容或本地文件路径中的至少一个',
  API_ERROR: 'API调用失败',
  TIMEOUT: '请求超时',
  INVALID_RESPONSE: '无效的API响应',
  NETWORK_ERROR: '网络连接错误',
};
