import { TFile } from 'obsidian';

export interface WebhookProfile {
	id: string;
	name: string;
	url: string;
}

export interface VideoSummarySettings {
	// API 配置
	n8nWebhookUrl: string;
	webhookProfiles: WebhookProfile[];
	activeWebhookId: string;

	// 处理配置
	defaultLanguage: 'zh' | 'en' | 'ja';
	defaultMode: ProcessingMode;
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
	historySortBy: string;  // 历史记录排序方式
	statusFilterValue: string; // 状态筛选值

	// 历史记录
	history: ProcessingHistory[];
	webhookHistory: WebhookHistoryEntry[];
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
}

export interface WebhookHistoryEntry {
	result: ProcessingResult;
	input: VideoInput;
	mode: ProcessingMode;
	language: SupportedLanguage;
	timestamp: number;
}

export type ProcessingMode = 'summary' | 'transcript-only' | 'info-only';

export type SupportedLanguage = 'zh' | 'en' | 'ja';

export interface VideoInput {
	url?: string;
	transcript?: string;
	localFile?: string;
	localFiles?: string[];
	merge?: boolean;
}

export interface ProcessingResult {
	summary?: string;
	note?: string;
	video_transcript?: string;
	video_title?: string;
	video_author?: string;
	video_duration?: string;
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
	link?: string;
	video_title?: string;
	video_author?: string;
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