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
/** Short built-in text for the setup wizard's trial run. */
export const SETUP_TRIAL_TRANSCRIPT =
  '今天介绍番茄工作法。它由弗朗切斯科·西里洛在上世纪八十年代提出：选一件任务，计时二十五分钟专心做，然后休息五分钟；每完成四轮，休息十五到三十分钟。好处是把大任务切成小块，降低开始的难度，并用固定的休息防止疲劳。二十五分钟只是默认值，可以按任务调整。';
export const LEGACY_N8N_WEBHOOK_URL = 'http://localhost:5678/webhook/cyrus';
export const RECOMMENDED_WORKFLOW: Required<WorkflowHealthInfo> = {
  name: 'Video Summary',
  version: '3.0.0',
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
      '把文件放进后端文件夹的 uploads，只填写文件名。',
      "Put the file in the backend's uploads folder and give only its name.",
    ),
    notes: tr(
      '最稳定，适合长录音、会议、课程和个人素材。',
      'The most reliable; good for long recordings, meetings, lectures and your own material.',
    ),
  },
  {
    platform: 'YouTube',
    status: 'supported',
    input: 'link',
    requirements: tr(
      '公开视频通常可用；受限视频可能需要 cookies。在中国大陆需要代理。',
      'Public videos usually work; restricted ones may need cookies. Needs a proxy in mainland China.',
    ),
    notes: tr(
      '先用视频自带的字幕，没有字幕时再下载音频转写。',
      'Uses the video subtitles first and transcribes the audio when there are none.',
    ),
  },
  {
    platform: 'Bilibili',
    status: 'recommended',
    input: 'link',
    requirements: tr(
      '登录后（首次配置第 ④ 步扫码）能用 UP 主字幕和 B 站 AI 字幕；不登录会改走语音转写。',
      'After logging in (step ④ of first-run setup) it uses uploader subtitles and Bilibili AI subtitles; without login it falls back to speech-to-text.',
    ),
    notes: tr(
      '顺序是 UP 主字幕 → AI 字幕 → 语音转写，弹幕不会当成文稿。',
      'Order: uploader subtitles → AI subtitles → speech-to-text; danmaku is never used as a transcript.',
    ),
  },
  {
    platform: tr('抖音', 'Douyin'),
    status: 'limited',
    input: 'link',
    requirements: tr(
      '经常需要浏览器导出的 cookies。',
      'Often needs cookies exported from your browser.',
    ),
    notes: tr(
      '尽力而为。短链可能过期或跳转失败；必要时改用最终链接或粘贴文稿。',
      'Best effort. Short links can expire or fail to redirect; use the final link or paste the transcript.',
    ),
  },
  {
    platform: 'TikTok',
    status: 'limited',
    input: 'link',
    requirements: tr(
      '经常需要 cookies，也可能受地区限制。',
      'Often needs cookies and may be region-restricted.',
    ),
    notes: tr(
      '尽力而为。下载失败通常是平台访问问题，不是笔记的问题。',
      'Best effort. Download failures are usually platform access problems, not note problems.',
    ),
  },
  {
    platform: tr('小红书 / Rednote', 'Xiaohongshu / Rednote'),
    status: 'limited',
    input: 'link',
    requirements: tr(
      '通常需要 cookies，部分分享链接不稳定。',
      'Usually needs cookies; some share links are unreliable.',
    ),
    notes: tr(
      '尽力而为；先保存来源信息再处理。',
      'Best effort; save the source first, then process it.',
    ),
  },
  {
    platform: tr('手动粘贴文稿', 'Pasted transcript'),
    status: 'local',
    input: 'provided_transcript',
    requirements: tr('不依赖下载器。', 'No downloader needed.'),
    notes: tr(
      '平台下载受阻但你已有文字时，优先用这个方式。',
      'When a platform blocks downloads but you already have the text, use this.',
    ),
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
