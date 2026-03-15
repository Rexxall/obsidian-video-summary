import { CacheItem, ProcessingMode, SupportedLanguage, ProcessingResult } from '../types';
import { TFile, Vault } from 'obsidian';

export interface CacheIndex {
	version: string;
	lastUpdated: number;
	maxSize: number;
	expiryDays: number;
	items: {
		[key: string]: {
			url: string;
			mode: ProcessingMode;
			language: SupportedLanguage;
			timestamp: number;
			expiryTimestamp: number;
			size: number;
			path: string;
		};
	};
}

export class CacheManager {
	private cache: Map<string, CacheItem> = new Map();
	private maxSize: number = 1000;
	private defaultExpiryDays: number = 30;
	private vault: Vault;
	private pluginDataPath: string;
	private cacheDir: string;
	private indexFile: string;
	private itemsDir: string;
	private index: CacheIndex;
	private isInitialized: boolean = false;
	private enabled: boolean = true;

	constructor(vault: Vault, pluginDataPath?: string) {
		this.vault = vault;
		this.pluginDataPath = pluginDataPath || '.obsidian/plugins/video-summary-plugin/data';
		this.cacheDir = `${this.pluginDataPath}/cache`;
		this.indexFile = `${this.pluginDataPath}/cache/index.json`;
		this.itemsDir = `${this.pluginDataPath}/cache/items`;
		this.index = this.createDefaultIndex();
		this.initializeCache();
	}

	/**
	 * 创建默认索引
	 */
	private createDefaultIndex(): CacheIndex {
		return {
			version: '2.0.0',
			lastUpdated: Date.now(),
			maxSize: this.maxSize,
			expiryDays: this.defaultExpiryDays,
			items: {}
		};
	}

	/**
	 * 初始化缓存系统
	 */
	private async initializeCache() {
		try {
			// 确保缓存目录存在
			await this.ensureCacheDirectory();
			
			// 加载索引
			await this.loadIndex();
			
			// 迁移旧数据（如果存在）
			await this.migrateFromLocalStorage();
			
			// 清理过期项
			await this.cleanup();
			
			this.isInitialized = true;
		} catch (error) {
			console.error('初始化缓存失败:', error);
			// 如果初始化失败，使用内存缓存
			this.isInitialized = false;
		}
	}

	/**
	 * 确保缓存目录存在
	 */
	private async ensureCacheDirectory(): Promise<void> {
		try {
			// 检查缓存目录是否存在
			const cacheDirExists = await this.vault.adapter.exists(this.cacheDir);
			if (!cacheDirExists) {
				await this.vault.adapter.mkdir(this.cacheDir);
			}

			// 检查items目录是否存在
			const itemsDirExists = await this.vault.adapter.exists(this.itemsDir);
			if (!itemsDirExists) {
				await this.vault.adapter.mkdir(this.itemsDir);
			}
		} catch (error) {
			console.error('创建缓存目录失败:', error);
			throw error;
		}
	}

	/**
	 * 生成缓存键
	 */
	private generateCacheKey(url: string, mode: ProcessingMode, language: SupportedLanguage): string {
		return `${url}|${mode}|${language}`;
	}

	/**
	 * 生成文件路径
	 */
	private generateFilePath(key: string): string {
		const hash = this.hashString(key);
		return `${this.itemsDir}/${hash}.json`;
	}

	/**
	 * 简单的字符串哈希函数
	 */
	private hashString(str: string): string {
		let hash = 0;
		for (let i = 0; i < str.length; i++) {
			const char = str.charCodeAt(i);
			hash = ((hash << 5) - hash) + char;
			hash = hash & hash; // 转换为32位整数
		}
		return Math.abs(hash).toString(36);
	}

	/**
	 * 从localStorage迁移数据
	 */
	private async migrateFromLocalStorage(): Promise<void> {
		try {
			if (typeof localStorage !== 'undefined') {
				const oldCacheData = localStorage.getItem('video-summary-cache');
				if (oldCacheData) {
					console.log('发现旧缓存数据，开始迁移...');
					
					const entries = JSON.parse(oldCacheData);
					let migratedCount = 0;
					
					for (const [key, item] of entries) {
						try {
							await this.set(key.split('|')[0], item.mode || 'summary', item.language || 'zh', item.result);
							migratedCount++;
						} catch (error) {
							console.error(`迁移缓存项失败: ${key}`, error);
						}
					}
					
					console.log(`迁移完成，共迁移 ${migratedCount} 项`);
					
					// 清空旧数据
					localStorage.removeItem('video-summary-cache');
				}
			}
		} catch (error) {
			console.error('迁移旧缓存失败:', error);
		}
	}

	/**
	 * 加载索引文件
	 */
	private async loadIndex(): Promise<void> {
		try {
			const indexExists = await this.vault.adapter.exists(this.indexFile);
			if (indexExists) {
				const indexData = await this.vault.adapter.read(this.indexFile);
				this.index = JSON.parse(indexData);
				
				// 验证索引完整性
				if (!this.index.version || !this.index.items) {
					throw new Error('索引文件格式无效');
				}
				
				// 更新配置
				this.maxSize = this.index.maxSize;
				this.defaultExpiryDays = this.index.expiryDays;
			} else {
				// 创建新索引
				await this.saveIndex();
			}
		} catch (error) {
			console.error('加载索引失败:', error);
			// 使用默认索引
			this.index = this.createDefaultIndex();
		}
	}

	/**
	 * 保存索引文件
	 */
	private async saveIndex(): Promise<void> {
		try {
			this.index.lastUpdated = Date.now();
			const indexData = JSON.stringify(this.index, null, 2);
			await this.vault.adapter.write(this.indexFile, indexData);
		} catch (error) {
			console.error('保存索引失败:', error);
			throw error;
		}
	}

	/**
	 * 获取缓存项
	 */
	async get(
		url: string,
		mode: ProcessingMode,
		language: SupportedLanguage,
		options?: { bypassDisabled?: boolean }
	): Promise<ProcessingResult | null> {
		if ((!this.enabled && !options?.bypassDisabled) || !this.isInitialized) {
			return null;
		}

		const key = this.generateCacheKey(url, mode, language);
		const indexItem = this.index.items[key];
		
		if (!indexItem) {
			return null;
		}

		// 检查是否过期
		if (Date.now() > indexItem.expiryTimestamp) {
			await this.remove(url, mode, language);
			return null;
		}

		try {
			// 从文件读取缓存内容
			const cacheData = await this.vault.adapter.read(indexItem.path);
			const cacheItem: CacheItem = JSON.parse(cacheData);
			return cacheItem.result;
		} catch (error) {
			console.error('读取缓存文件失败:', error);
			// 删除损坏的索引项
			delete this.index.items[key];
			await this.saveIndex();
			return null;
		}
	}

	/**
	 * 设置缓存项
	 */
	async set(url: string, mode: ProcessingMode, language: SupportedLanguage, result: ProcessingResult): Promise<void> {
		if (!this.enabled || !this.isInitialized) {
			return;
		}

		const key = this.generateCacheKey(url, mode, language);
		const filePath = this.generateFilePath(key);
		
		// 创建缓存项
		const cacheItem: CacheItem = {
			url,
			mode,
			language,
			result,
			timestamp: Date.now(),
			expiryTimestamp: Date.now() + (this.defaultExpiryDays * 24 * 60 * 60 * 1000)
		};

		try {
			// 保存缓存内容到文件
			const cacheData = JSON.stringify(cacheItem, null, 2);
			await this.vault.adapter.write(filePath, cacheData);

			// 更新索引
			this.index.items[key] = {
				url,
				mode,
				language,
				timestamp: cacheItem.timestamp,
				expiryTimestamp: cacheItem.expiryTimestamp,
				size: cacheData.length,
				path: filePath
			};

			// 检查容量限制
			if (Object.keys(this.index.items).length > this.maxSize) {
				await this.evictOldest();
			}

			// 保存索引
			await this.saveIndex();
		} catch (error) {
			console.error('保存缓存失败:', error);
			throw error;
		}
	}

	/**
	 * 检查是否有缓存
	 */
	has(url: string, mode: ProcessingMode, language: SupportedLanguage): boolean {
		if (!this.enabled || !this.isInitialized) {
			return false;
		}

		const key = this.generateCacheKey(url, mode, language);
		const indexItem = this.index.items[key];
		
		if (!indexItem) {
			return false;
		}

		// 检查是否过期
		return Date.now() <= indexItem.expiryTimestamp;
	}

	/**
	 * 删除缓存项
	 */
	async remove(url: string, mode: ProcessingMode, language: SupportedLanguage): Promise<void> {
		if (!this.isInitialized) {
			return;
		}

		const key = this.generateCacheKey(url, mode, language);
		const indexItem = this.index.items[key];
		
		if (indexItem) {
			try {
				// 删除缓存文件
				const fileExists = await this.vault.adapter.exists(indexItem.path);
				if (fileExists) {
					await this.vault.adapter.remove(indexItem.path);
				}
			} catch (error) {
				console.error('删除缓存文件失败:', error);
			}

			// 从索引中删除
			delete this.index.items[key];
			await this.saveIndex();
		}
	}

	/**
	 * 删除最旧的缓存项
	 */
	private async evictOldest(): Promise<void> {
		let oldestKey: string | null = null;
		let oldestTimestamp = Date.now();

		for (const [key, item] of Object.entries(this.index.items)) {
			if (item.timestamp < oldestTimestamp) {
				oldestTimestamp = item.timestamp;
				oldestKey = key;
			}
		}

		if (oldestKey) {
			const url = this.index.items[oldestKey].url;
			const mode = this.index.items[oldestKey].mode;
			const language = this.index.items[oldestKey].language;
			await this.remove(url, mode, language);
		}
	}

	/**
	 * 清理过期项
	 */
	async cleanup(): Promise<void> {
		if (!this.isInitialized) {
			return;
		}

		const now = Date.now();
		const keysToRemove: string[] = [];

		for (const [key, item] of Object.entries(this.index.items)) {
			if (now > item.expiryTimestamp) {
				keysToRemove.push(key);
			}
		}

		for (const key of keysToRemove) {
			const item = this.index.items[key];
			await this.remove(item.url, item.mode, item.language);
		}

		if (keysToRemove.length > 0) {
			console.log(`清理了 ${keysToRemove.length} 个过期缓存项`);
		}
	}

	/**
	 * 获取缓存统计信息
	 */
	getStats(): { size: number; maxSize: number; expiredCount: number; totalSize: number } {
		if (!this.isInitialized) {
			return { size: 0, maxSize: this.maxSize, expiredCount: 0, totalSize: 0 };
		}

		const now = Date.now();
		let expiredCount = 0;
		let totalSize = 0;

		for (const item of Object.values(this.index.items)) {
			if (now > item.expiryTimestamp) {
				expiredCount++;
			}
			totalSize += item.size;
		}

		return {
			size: Object.keys(this.index.items).length,
			maxSize: this.maxSize,
			expiredCount,
			totalSize
		};
	}

	/**
	 * 清空所有缓存
	 */
	async clear(): Promise<void> {
		if (!this.isInitialized) {
			return;
		}

		try {
			// 删除所有缓存文件
			for (const item of Object.values(this.index.items)) {
				try {
					const fileExists = await this.vault.adapter.exists(item.path);
					if (fileExists) {
						await this.vault.adapter.remove(item.path);
					}
				} catch (error) {
					console.error('删除缓存文件失败:', error);
				}
			}

			// 清空索引
			this.index.items = {};
			await this.saveIndex();
		} catch (error) {
			console.error('清空缓存失败:', error);
			throw error;
		}
	}

	/**
	 * 设置缓存配置
	 */
	setConfig(maxSize: number, expiryDays: number): void {
		this.maxSize = maxSize;
		this.defaultExpiryDays = expiryDays;
		
		if (this.isInitialized) {
			this.index.maxSize = maxSize;
			this.index.expiryDays = expiryDays;
			this.saveIndex();
		}
	}

	/**
	 * 获取所有缓存项（用于预览）
	 */
	async getAllItems(): Promise<Array<{
		key: string;
		url: string;
		mode: ProcessingMode;
		language: SupportedLanguage;
		timestamp: number;
		expiryTimestamp: number;
		size: number;
		isExpired: boolean;
	}>> {
		if (!this.isInitialized) {
			return [];
		}

		const now = Date.now();
		const items: Array<{
			key: string;
			url: string;
			mode: ProcessingMode;
			language: SupportedLanguage;
			timestamp: number;
			expiryTimestamp: number;
			size: number;
			isExpired: boolean;
		}> = [];

		for (const [key, item] of Object.entries(this.index.items)) {
			items.push({
				key,
				url: item.url,
				mode: item.mode,
				language: item.language,
				timestamp: item.timestamp,
				expiryTimestamp: item.expiryTimestamp,
				size: item.size,
				isExpired: now > item.expiryTimestamp
			});
		}

		// 按时间戳排序（最新的在前）
		return items.sort((a, b) => b.timestamp - a.timestamp);
	}

	/**
	 * 获取单个缓存项内容（用于预览）
	 */
	async getItemContent(url: string, mode: ProcessingMode, language: SupportedLanguage): Promise<ProcessingResult | null> {
		return await this.get(url, mode, language, { bypassDisabled: true });
	}

	setEnabled(enabled: boolean) {
		this.enabled = enabled;
	}

	isEnabled(): boolean {
		return this.enabled;
	}
}

