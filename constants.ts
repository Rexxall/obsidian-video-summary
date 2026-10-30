import { DEFAULT_QUOTE_TEMPLATE } from './core/TranscriptQuote';
import type { PlatformCapability, VideoSummarySettings, WorkflowHealthInfo } from './types';

import { tr } from './utils/i18n';
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

/** Provenance label until the setup check reports the backend's real model name. */
export const BACKEND_DEFAULT_MODEL_LABEL = '后端默认模型';
export const DEFAULT_WEBHOOK_AUTH_HEADER = 'X-Video-Summary-Token';
export const DEFAULT_N8N_WEBHOOK_URL = 'http://127.0.0.1:5678/webhook/obsidian-video-summary';
export const LEGACY_DEFAULT_N8N_WEBHOOK_URL =
  'http://localhost:5678/webhook/obsidian-video-summary';
export const SETUP_GUIDE_URL =
  'https://github.com/Rexxall/obsidian-video-summary/blob/main/INSTALL.md';
/** Short built-in text for the setup wizard's trial run, in the interface language. */
export const setupTrialTranscript = () =>
  tr(
    '今天介绍番茄工作法。它由弗朗切斯科·西里洛在上世纪八十年代提出：选一件任务，计时二十五分钟专心做，然后休息五分钟；每完成四轮，休息十五到三十分钟。好处是把大任务切成小块，降低开始的难度，并用固定的休息防止疲劳。二十五分钟只是默认值，可以按任务调整。',
    'Today: the Pomodoro Technique. Francesco Cirillo came up with it in the late 1980s: pick one task, work on it for twenty-five minutes, then take a five-minute break; after four rounds, rest for fifteen to thirty minutes. It cuts a big task into small pieces, makes starting easier, and the fixed breaks keep you from tiring. Twenty-five minutes is only the default; adjust it to the task.',
  );
export const LEGACY_N8N_WEBHOOK_URL = 'http://localhost:5678/webhook/cyrus';
export const RECOMMENDED_WORKFLOW: Required<WorkflowHealthInfo> = {
  name: 'Video Summary',
  version: '3.1.0',
  variant: 'packaged',
  webhookPath: 'obsidian-video-summary',
  models: [],
  requiredTools: ['yt-dlp', 'ffmpeg'],
  uploadsPath: '/home/node/uploads',
};

/** A function so the texts follow the interface language set when the plugin loads. */
export const platformCapabilities = (): PlatformCapability[] => [
  {
    platform: tr('本地音频/视频', 'Local audio/video'),
    status: 'recommended',
    input: 'local_file',
    requirements: tr(
      '放进后端的 uploads 文件夹，只填文件名',
      "Put it in the backend's uploads folder; give only the name",
    ),
  },
  {
    platform: 'YouTube',
    status: 'supported',
    input: 'link',
    requirements: tr(
      '公开视频直接可用；中国大陆需要代理',
      'Public videos work; needs a proxy in mainland China',
    ),
  },
  {
    platform: 'Bilibili',
    status: 'recommended',
    input: 'link',
    requirements: tr(
      '扫码登录后用字幕，不登录改走语音转写',
      'Subtitles after QR login; speech-to-text without it',
    ),
  },
  {
    platform: tr('抖音', 'Douyin'),
    status: 'limited',
    input: 'link',
    requirements: tr('常需 cookies', 'Often needs cookies'),
  },
  {
    platform: 'TikTok',
    status: 'limited',
    input: 'link',
    requirements: tr('常需 cookies，可能有地区限制', 'Often needs cookies; may be region-locked'),
  },
  {
    platform: tr('小红书 / Rednote', 'Xiaohongshu / Rednote'),
    status: 'limited',
    input: 'link',
    requirements: tr(
      '常需 cookies，部分分享链接不稳定',
      'Usually needs cookies; some share links fail',
    ),
  },
  {
    platform: tr('手动粘贴文稿', 'Pasted transcript'),
    status: 'local',
    input: 'provided_transcript',
    requirements: tr('不用下载；平台受阻时用它', 'No download; use it when a platform blocks'),
  },
];

export const DEFAULT_SETTINGS: VideoSummarySettings = {
  n8nWebhookUrl: DEFAULT_N8N_WEBHOOK_URL,
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
  readerQuoteTemplate: DEFAULT_QUOTE_TEMPLATE,
  aiModel: BACKEND_DEFAULT_MODEL_LABEL,
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
  cookiesDirPath: '', // 后端文件夹里 cookies 目录的绝对路径（桌面端 cookies 管理用）
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

export const processingModes = () => [
  { value: 'summary', label: tr('完整总结', 'Full summary') },
  { value: 'transcript-only', label: tr('仅提取文稿', 'Transcript only') },
  { value: 'info-only', label: tr('仅获取视频信息', 'Video info only') },
];

export const STATUS_ICONS = {
  idle: '📺',
  running: '⏳',
  complete: '✅',
  error: '❌',
};

export const ERROR_MESSAGES = {
  get NO_FILE() {
    return tr('请先打开一个笔记', 'Open a note first');
  },
  get NO_INPUT() {
    return tr(
      '请提供视频链接、文稿内容或本地文件路径中的至少一个',
      'Give a video link, a transcript or a local file name',
    );
  },
};
