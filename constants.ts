import { VideoSummarySettings } from './types';

export const DEFAULT_AI_MODELS: string[] = [
	'Gemini',
	'Gemini Pro',
	'Gemini Flash'
];

export const DEFAULT_SETTINGS: VideoSummarySettings = {
	n8nWebhookUrl: 'http://localhost:5678/webhook/obsidian-video-summary',
	webhookProfiles: [
		{
			id: 'default-webhook',
			name: '默认 Webhook',
			url: 'http://localhost:5678/webhook/obsidian-video-summary'
		}
	],
	activeWebhookId: 'default-webhook',
	defaultLanguage: 'zh',
	defaultMode: 'summary',
	aiModel: 'Gemini',
	customAiModels: [...DEFAULT_AI_MODELS],
	timeoutMinutes: 10,
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
		timeoutMinutes: 10
	},
	quickTranscriptOptions: {
		language: 'zh',
		mode: 'transcript-only',
		outputFolder: '',
		timeoutMinutes: 10
	},
	fileListSortBy: 'ctime-desc', // 默认按创建时间（最新）排序
	historySortBy: 'time-desc',   // 默认按时间（最新）排序
	statusFilterValue: 'all',     // 默认显示全部状态
	history: [],
	webhookHistory: [],
	payloadKeys: {
		mode: 'mode',
		language: 'language',
		ai: 'ai',
		info_only: 'info_only',
		link: 'link',
		provided_transcript: 'provided_transcript',
		local_file: 'local_file'
	}
};

export const SUPPORTED_PLATFORMS = [
	'youtube.com',
	'youtu.be',
	'bilibili.com',
	'douyin.com',
	'tiktok.com'
];

export const LANGUAGE_OPTIONS = [
	{ value: 'zh', label: '中文' },
	{ value: 'en', label: 'English' },
	{ value: 'ja', label: '日本語' }
];

export const PROCESSING_MODES = [
	{ value: 'summary', label: '完整总结' },
	{ value: 'transcript-only', label: '仅提取文稿' },
	{ value: 'info-only', label: '仅获取视频信息' }
];

export const STATUS_ICONS = {
	idle: '📺',
	running: '⏳',
	complete: '✅',
	error: '❌'
};

export const ERROR_MESSAGES = {
	NO_FILE: '请先打开一个笔记',
	NO_LINK: '笔记中没有找到视频链接',
	NO_TRANSCRIPT: '笔记中没有找到文稿内容',
	NO_INPUT: '请提供视频链接、文稿内容或本地文件路径中的至少一个',
	API_ERROR: 'API调用失败',
	TIMEOUT: '请求超时',
	INVALID_RESPONSE: '无效的API响应',
	NETWORK_ERROR: '网络连接错误'
}; 