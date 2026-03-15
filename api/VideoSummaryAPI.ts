import { Notice } from 'obsidian';
import { ProcessingMode, SupportedLanguage, VideoInput, ProcessingResult, WebhookHistoryEntry } from '../types';
import { CacheManager } from '../utils/CacheManager';
import { Vault } from 'obsidian';

export class VideoSummaryAPI {
	private webhookUrl: string;
	private timeout: number;
	private debugMode: boolean = false;
	private aiModel: string = 'Gemini';
	private cacheManager: CacheManager;
	private payloadKeys: any;

	setAiModel(model: string) {
		this.aiModel = model;
	}
	private lastWebhookResult:
		| {
			result: ProcessingResult;
			input: VideoInput;
			mode: ProcessingMode;
			language: SupportedLanguage;
			timestamp: number;
		}
		| null = null;
	private webhookHistory: WebhookHistoryEntry[] = [];
	private webhookHistoryLimit = 50;
	private historyListener?: (history: WebhookHistoryEntry[]) => void;
	private controllers: Map<string, AbortController> = new Map();
	constructor(webhookUrl: string, vault: Vault, pluginDataPath?: string, payloadKeys?: any) {
		this.webhookUrl = webhookUrl;
		this.timeout = 30000; // 30秒超时
		this.cacheManager = new CacheManager(vault, pluginDataPath);
		this.payloadKeys = payloadKeys || {
			mode: 'mode',
			language: 'language',
			ai: 'ai',
			info_only: 'info_only',
			link: 'link',
			provided_transcript: 'provided_transcript',
			local_file: 'local_file'
		};
	}

	setPayloadKeys(keys: any) {
		this.payloadKeys = keys;
	}

	/**
	 * 设置调试模式
	 */
	setDebug(debug: boolean) {
		this.debugMode = debug;
	}

	/**
	 * 处理单个视频
	 */
	async processVideo(
		noteName: string,
		input: VideoInput,
		mode: ProcessingMode,
		language: SupportedLanguage = 'zh',
		useCache: boolean = true
	): Promise<ProcessingResult> {
		// 检查缓存（如果启用）
		if (useCache && input.url && this.cacheManager.has(input.url, mode, language)) {
			const cachedResult = await this.cacheManager.get(input.url, mode, language);
			if (cachedResult) {
				if (this.debugMode) {
					console.log(`[VideoSummaryAPI] 使用缓存结果: ${input.url}`);
				}
				return cachedResult;
			}
		}

		// 构建请求负载
		const payload = this.buildPayload(noteName, input, mode, language);

		// 创建并注册中止控制器（同名任务仅允许一个并行请求）
		const controller = new AbortController();
		const existingController = this.controllers.get(noteName);
		if (existingController) {
			try {
				existingController.abort();
			} catch { }
		}
		this.controllers.set(noteName, controller);

		try {
			const response = await fetch(this.webhookUrl, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(payload),
				signal: controller.signal,
			});

			if (!response.ok) {
				throw new Error(`HTTP ${response.status}: ${response.statusText}`);
			}

			const data = await response.json();
			const result = this.parseSummaryResponse(data);

			this.recordWebhookResult(result, input, mode, language);

			// 存储最近一次webhook调用的结果
			this.lastWebhookResult = {
				result,
				input,
				mode,
				language,
				timestamp: Date.now()
			};

			// 将结果存入缓存
			if (useCache && input.url && result) {
				await this.cacheManager.set(input.url, mode, language, result);
			}

			return result;
		} catch (error) {
			if ((error as Error).name === 'AbortError') {
				throw new Error('请求被取消');
			}
			throw error;
		} finally {
			const activeController = this.controllers.get(noteName);
			if (activeController === controller) {
				this.controllers.delete(noteName);
			}
		}
	}

	/**
	 * 简单处理视频（不更新笔记）
	 */
	async processVideoSimple(
		input: VideoInput,
		mode: ProcessingMode,
		language: SupportedLanguage = 'zh',
		useCache: boolean = true
	): Promise<ProcessingResult> {
		try {
			// 检查缓存（如果启用）
			if (useCache && input.url && this.cacheManager.has(input.url, mode, language)) {
				const cachedResult = await this.cacheManager.get(input.url, mode, language);
				if (cachedResult) {
					if (this.debugMode) {
						console.log(`[VideoSummaryAPI] 使用缓存结果: ${input.url}`);
					}
					return cachedResult;
				}
			}

			// 构建请求负载
			const payload = this.buildPayload('temp', input, mode, language);

			// 发送请求
			const response = await fetch(this.webhookUrl, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(payload),
			});

			if (!response.ok) {
				throw new Error(`HTTP ${response.status}: ${response.statusText}`);
			}

			const data = await response.json();
			const result = this.parseSummaryResponse(data);

			this.recordWebhookResult(result, input, mode, language);

			// 存储最近一次webhook调用的结果
			this.lastWebhookResult = {
				result,
				input,
				mode,
				language,
				timestamp: Date.now()
			};

			// 将结果存入缓存
			if (useCache && input.url && result) {
				await this.cacheManager.set(input.url, mode, language, result);
			}

			return result;
		} catch (error) {
			throw error;
		}
	}

	/**
	 * 获取上次webhook调用的结果
	 */
	getLastWebhookResult(): {
		result: ProcessingResult;
		input: VideoInput;
		mode: ProcessingMode;
		language: SupportedLanguage;
		timestamp: number;
	} | null {
		return this.lastWebhookResult;
	}

	getWebhookHistory(limit: number = this.webhookHistoryLimit) {
		return this.webhookHistory.slice(0, limit).map((entry) => ({ ...entry }));
	}

	normalizeWebhookPayload(data: any): ProcessingResult {
		return this.parseSummaryResponse(data);
	}

	setWebhookHistory(history: WebhookHistoryEntry[]) {
		this.webhookHistory = Array.isArray(history) ? [...history] : [];
		this.lastWebhookResult = this.webhookHistory[0] ?? null;
	}

	onWebhookHistoryChange(listener: (history: WebhookHistoryEntry[]) => void) {
		this.historyListener = listener;
	}

	// 取消指定笔记的请求
	cancelByNoteName(noteName: string) {
		const controller = this.controllers.get(noteName);
		if (controller) {
			try {
				controller.abort();
			} catch { }
			this.controllers.delete(noteName);
		}
	}

	// 缓存管理方法
	/**
	 * 获取缓存统计信息
	 */
	getCacheStats() {
		return this.cacheManager.getStats();
	}

	/**
	 * 清空缓存
	 */
	clearCache() {
		this.cacheManager.clear();
	}

	/**
	 * 清理过期缓存
	 */
	cleanupCache() {
		this.cacheManager.cleanup();
	}

	/**
	 * 设置缓存配置
	 */
	setCacheConfig(maxSize: number, expiryDays: number) {
		this.cacheManager.setConfig(maxSize, expiryDays);
	}

	/**
	 * 启用或禁用缓存
	 */
	setCacheEnabled(enabled: boolean) {
		this.cacheManager.setEnabled(enabled);
		// 如果禁用缓存，清空现有缓存
		if (!enabled) {
			this.cacheManager
				.clear()
				.catch((error) => console.error('[VideoSummaryAPI] 清空缓存失败:', error));
		}
	}

	/**
	 * 检查URL是否有缓存
	 */
	hasCache(url: string, mode: ProcessingMode, language: SupportedLanguage): boolean {
		return this.cacheManager.has(url, mode, language);
	}

	/**
	 * 获取所有缓存项（用于预览）
	 */
	async getAllCacheItems() {
		return await this.cacheManager.getAllItems();
	}

	/**
	 * 删除单个缓存项
	 */
	async removeCacheItem(url: string, mode: ProcessingMode, language: SupportedLanguage) {
		return await this.cacheManager.remove(url, mode, language);
	}

	/**
	 * 获取单个缓存项内容（用于预览）
	 */
	async getCacheItemContent(url: string, mode: ProcessingMode, language: SupportedLanguage) {
		return await this.cacheManager.getItemContent(url, mode, language);
	}

	/**
	 * 直接设置缓存项（用于测试和管理）
	 */
	async setCacheItem(url: string, mode: ProcessingMode, language: SupportedLanguage, result: ProcessingResult) {
		return await this.cacheManager.set(url, mode, language, result);
	}

	// 取消所有正在进行的请求
	cancelAll() {
		for (const [key, controller] of this.controllers.entries()) {
			try {
				controller.abort();
			} catch { }
			this.controllers.delete(key);
		}
	}

	private buildPayload(
		noteName: string,
		input: VideoInput,
		mode: ProcessingMode,
		language: SupportedLanguage
	) {
		const keys = this.payloadKeys;
		const metadata: any = {};
		metadata[keys.mode] = mode;
		metadata[keys.language] = language;
		metadata[keys.ai] = this.aiModel;

		if (mode === 'info-only') {
			metadata[keys.info_only] = true;
		}

		// 添加输入数据
		if (input.url) {
			metadata[keys.link] = input.url;
		}
		if (input.transcript) {
			metadata[keys.provided_transcript] = input.transcript;
		}
		if (input.localFile) {
			// 如果用户配置了 local_file 键，则使用它
			metadata[keys.local_file] = input.localFile;
			
			// 为了向后兼容，如果 local_file 键不是 "localFile"，我们也保留原来的映射？
			// 不，用户说“改成能在设置里自行修改”，所以应该完全遵循配置。
			// 但考虑到 input.localFile 是内部属性名，我们只映射到负载。
		}

		return {
			name: noteName,
			metadata,
			content: '', // 正文内容
		};
	}

	private recordWebhookResult(result: ProcessingResult, input: VideoInput, mode: ProcessingMode, language: SupportedLanguage) {
		const entry = {
			result,
			input,
			mode,
			language,
			timestamp: Date.now(),
		};
		this.lastWebhookResult = entry;
		this.webhookHistory.unshift(entry);
		if (this.webhookHistory.length > this.webhookHistoryLimit) {
			this.webhookHistory = this.webhookHistory.slice(0, this.webhookHistoryLimit);
		}
		if (this.historyListener) {
			this.historyListener(this.webhookHistory.map((item) => ({ ...item })));
		}
	}

	private parseSummaryResponse(data: any): ProcessingResult {
		// n8n 可能返回数组，需要合并所有对象的数据
		const preserveKeys = new Set(['summary', 'note', 'video_transcript']);
		const payload: any = Array.isArray(data) ? {} : data;

		if (Array.isArray(data)) {
			for (const item of data) {
				if (!item || typeof item !== 'object') continue;
				for (const [key, value] of Object.entries(item)) {
					if (value === undefined || value === null) continue;
					if (preserveKeys.has(key)) {
						if (payload[key] === undefined || payload[key] === null || payload[key] === '') {
							payload[key] = value;
						}
						continue;
					}
					payload[key] = value;
				}
			}
		}

		// 检查是否是错误响应
		if (payload?.error) {
			throw new Error(payload.error);
		}

		// 检查数据是否为空或无效
		if (!payload || typeof payload !== 'object') {
			throw new Error('服务器返回无效的数据格式');
		}

		// 兼容 info-only/summary 混合数据的字段命名（支持嵌套结构）
		const infoSources: Array<Record<string, any> | undefined> = [
			payload,
			payload.info,
			payload.videoInfo,
			payload.video_info,
			payload.metadata,
		];

		const pickField = (aliases: string[]): string | undefined => {
			for (const source of infoSources) {
				if (!source || typeof source !== 'object') continue;
				for (const key of aliases) {
					const value = source[key];
					if (typeof value === 'string' && value.trim()) {
						return value.trim();
					}
				}
			}
			return undefined;
		};

		const normalizedTitle = pickField(['video_title', 'title', 'name']);
		if (normalizedTitle) {
			payload.video_title = normalizedTitle;
		}

		const normalizedAuthor = pickField(['video_author', 'author', 'channel', 'creator', 'uploader', 'up']);
		if (normalizedAuthor) {
			payload.video_author = normalizedAuthor;
		}

		const normalizedDuration = pickField(['video_duration', 'duration']);
		if (normalizedDuration) {
			payload.video_duration = normalizedDuration;
		}

		// 解析成功响应
		const result: ProcessingResult = {};

		if (payload.summary && typeof payload.summary === 'string') {
			result.summary = payload.summary;
		}
		if (payload.note && typeof payload.note === 'string') {
			// 处理换行符
			result.note = payload.note.replace(/\\n/g, '\n');
		}
		if (payload.video_transcript && typeof payload.video_transcript === 'string') {
			result.video_transcript = payload.video_transcript;
		}
		if (payload.video_title && typeof payload.video_title === 'string') {
			result.video_title = payload.video_title;
		}
		if (payload.video_author && typeof payload.video_author === 'string') {
			result.video_author = payload.video_author;
		}
		if (payload.video_duration && typeof payload.video_duration === 'string') {
			result.video_duration = payload.video_duration;
		}

		// 检查是否有任何有效数据
		if (Object.keys(result).length === 0) {
			throw new Error('服务器返回的数据中没有有效内容');
		}

		return result;
	}

	// 批量处理API - 支持实时回调
	async batchProcess(
		requests: Array<{
			noteName: string;
			input: VideoInput;
			mode: ProcessingMode;
			language: SupportedLanguage;
		}>,
		concurrency: number = 3,
		onProgress?: (result: { success: boolean; result?: ProcessingResult; error?: string; noteName: string; index: number }) => void,
		useCache: boolean = true
	): Promise<Array<{ success: boolean; result?: ProcessingResult; error?: string; noteName: string }>> {
		const results: Array<{ success: boolean; result?: ProcessingResult; error?: string; noteName: string }> = [];
		const chunks = this.chunkArray(requests, concurrency);

		for (const chunk of chunks) {
			const chunkPromises = chunk.map(async (request, chunkIndex) => {
				const globalIndex = results.length + chunkIndex;
				try {
					const result = await this.processVideo(
						request.noteName,
						request.input,
						request.mode,
						request.language,
						useCache
					);

					const resultObj = {
						success: true,
						result,
						noteName: request.noteName,
					};

					// 实时回调
					if (onProgress) {
						onProgress({ ...resultObj, index: globalIndex });
					}

					return resultObj;
				} catch (error) {
					const errorObj = {
						success: false,
						error: error.message,
						noteName: request.noteName,
					};

					// 实时回调
					if (onProgress) {
						onProgress({ ...errorObj, index: globalIndex });
					}

					return errorObj;
				}
			});

			const chunkResults = await Promise.all(chunkPromises);
			results.push(...chunkResults);
		}

		return results;
	}

	private chunkArray<T>(array: T[], size: number): T[][] {
		const chunks: T[][] = [];
		for (let i = 0; i < array.length; i += size) {
			chunks.push(array.slice(i, i + size));
		}
		return chunks;
	}

	// 测试连接（返回耗时与响应片段，便于诊断）
	async testConnection(): Promise<{
		success: boolean;
		durationMs?: number;
		status?: number;
		bodySnippet?: string;
		error?: string;
	}> {
		const started = Date.now();
		try {
			const response = await fetch(this.webhookUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: 'test', metadata: { mode: 'transcript-only' }, content: '' }),
			});

			const durationMs = Date.now() - started;
			const text = await response.text();
			const snippet = (text || '').slice(0, 180);

			if (!response.ok) {
				return {
					success: false,
					durationMs,
					status: response.status,
					bodySnippet: snippet,
					error: `HTTP ${response.status} ${response.statusText}`,
				};
			}

			if (!text || text.trim() === '') {
				return {
					success: false,
					durationMs,
					status: response.status,
					error: '服务器返回空响应',
				};
			}

			return { success: true, durationMs, status: response.status, bodySnippet: snippet };
		} catch (error) {
			return {
				success: false,
				durationMs: Date.now() - started,
				error: `连接失败: ${error.message}`,
			};
		}
	}
} 