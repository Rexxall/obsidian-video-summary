// 测试新的基于文件的缓存系统
console.log('🧪 测试新的缓存系统...');

// 模拟Obsidian环境
const mockVault = {
	adapter: {
		exists: async (path) => {
			console.log(`检查路径是否存在: ${path}`);
			return false; // 假设路径不存在
		},
		mkdir: async (path) => {
			console.log(`创建目录: ${path}`);
			return true;
		},
		read: async (path) => {
			console.log(`读取文件: ${path}`);
			return '{}'; // 返回空JSON
		},
		write: async (path, content) => {
			console.log(`写入文件: ${path}`);
			console.log(`内容长度: ${content.length} 字符`);
			return true;
		},
		remove: async (path) => {
			console.log(`删除文件: ${path}`);
			return true;
		}
	}
};

// 模拟CacheManager
class MockCacheManager {
	constructor(vault) {
		this.vault = vault;
		this.index = {
			version: '2.0.0',
			lastUpdated: Date.now(),
			maxSize: 1000,
			expiryDays: 30,
			items: {}
		};
		console.log('✅ MockCacheManager 初始化成功');
	}

	async initializeCache() {
		console.log('🔄 开始初始化缓存...');
		try {
			await this.ensureCacheDirectory();
			await this.loadIndex();
			await this.migrateFromLocalStorage();
			await this.cleanup();
			console.log('✅ 缓存初始化完成');
		} catch (error) {
			console.error('❌ 缓存初始化失败:', error);
		}
	}

	async ensureCacheDirectory() {
		console.log('📁 确保缓存目录存在...');
		const cacheDirExists = await this.vault.adapter.exists('cache');
		if (!cacheDirExists) {
			await this.vault.adapter.mkdir('cache');
			console.log('📁 缓存目录已创建');
		}

		const itemsDirExists = await this.vault.adapter.exists('cache/items');
		if (!itemsDirExists) {
			await this.vault.adapter.mkdir('cache/items');
			console.log('📁 items目录已创建');
		}
	}

	async loadIndex() {
		console.log('📖 加载索引文件...');
		try {
			const indexExists = await this.vault.adapter.exists('cache/index.json');
			if (indexExists) {
				const indexData = await this.vault.adapter.read('cache/index.json');
				this.index = JSON.parse(indexData);
				console.log('📖 索引文件加载成功');
			} else {
				console.log('📖 索引文件不存在，将创建新索引');
				await this.saveIndex();
			}
		} catch (error) {
			console.error('❌ 加载索引失败:', error);
		}
	}

	async saveIndex() {
		console.log('💾 保存索引文件...');
		try {
			this.index.lastUpdated = Date.now();
			const indexData = JSON.stringify(this.index, null, 2);
			await this.vault.adapter.write('cache/index.json', indexData);
			console.log('💾 索引文件保存成功');
		} catch (error) {
			console.error('❌ 保存索引失败:', error);
		}
	}

	async migrateFromLocalStorage() {
		console.log('🔄 检查是否需要从localStorage迁移...');
		// 模拟没有旧数据
		console.log('📭 没有发现旧数据，无需迁移');
	}

	async cleanup() {
		console.log('🧹 清理过期缓存项...');
		const now = Date.now();
		const keysToRemove = [];

		for (const [key, item] of Object.entries(this.index.items)) {
			if (now > item.expiryTimestamp) {
				keysToRemove.push(key);
			}
		}

		if (keysToRemove.length > 0) {
			console.log(`🧹 清理了 ${keysToRemove.length} 个过期项`);
		} else {
			console.log('🧹 没有过期项需要清理');
		}
	}

	async set(url, mode, language, result) {
		console.log(`💾 设置缓存项: ${url} | ${mode} | ${language}`);
		const key = `${url}|${mode}|${language}`;
		const filePath = `cache/items/${this.hashString(key)}.json`;
		
		const cacheItem = {
			url,
			mode,
			language,
			result,
			timestamp: Date.now(),
			expiryTimestamp: Date.now() + (this.index.expiryDays * 24 * 60 * 60 * 1000)
		};

		try {
			const cacheData = JSON.stringify(cacheItem, null, 2);
			await this.vault.adapter.write(filePath, cacheData);

			this.index.items[key] = {
				url,
				mode,
				language,
				timestamp: cacheItem.timestamp,
				expiryTimestamp: cacheItem.expiryTimestamp,
				size: cacheData.length,
				path: filePath
			};

			await this.saveIndex();
			console.log('✅ 缓存项设置成功');
		} catch (error) {
			console.error('❌ 设置缓存项失败:', error);
			throw error;
		}
	}

	async get(url, mode, language) {
		console.log(`🔍 获取缓存项: ${url} | ${mode} | ${language}`);
		const key = `${url}|${mode}|${language}`;
		const indexItem = this.index.items[key];
		
		if (!indexItem) {
			console.log('📭 缓存项不存在');
			return null;
		}

		if (Date.now() > indexItem.expiryTimestamp) {
			console.log('⏰ 缓存项已过期');
			return null;
		}

		try {
			const cacheData = await this.vault.adapter.read(indexItem.path);
			const cacheItem = JSON.parse(cacheData);
			console.log('✅ 缓存项获取成功');
			return cacheItem.result;
		} catch (error) {
			console.error('❌ 读取缓存项失败:', error);
			return null;
		}
	}

	async has(url, mode, language) {
		const key = `${url}|${mode}|${language}`;
		const indexItem = this.index.items[key];
		
		if (!indexItem) {
			return false;
		}

		return Date.now() <= indexItem.expiryTimestamp;
	}

	getStats() {
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
			maxSize: this.index.maxSize,
			expiredCount,
			totalSize
		};
	}

	hashString(str) {
		let hash = 0;
		for (let i = 0; i < str.length; i++) {
			const char = str.charCodeAt(i);
			hash = ((hash << 5) - hash) + char;
			hash = hash & hash;
		}
		return Math.abs(hash).toString(36);
	}
}

// 运行测试
async function runTest() {
	console.log('🚀 开始运行缓存系统测试...\n');

	try {
		// 创建缓存管理器
		const cacheManager = new MockCacheManager(mockVault);
		
		// 初始化缓存
		await cacheManager.initializeCache();
		
		// 测试设置缓存项
		console.log('\n📝 测试设置缓存项...');
		const testResult = {
			summary: '这是一个测试视频摘要',
			video_transcript: '这是测试视频的转录内容',
			video_title: '测试视频'
		};
		
		await cacheManager.set('https://example.com/test.mp4', 'summary', 'zh', testResult);
		
		// 测试获取缓存项
		console.log('\n🔍 测试获取缓存项...');
		const retrievedResult = await cacheManager.get('https://example.com/test.mp4', 'summary', 'zh');
		console.log('获取结果:', retrievedResult);
		
		// 测试缓存统计
		console.log('\n📊 测试缓存统计...');
		const stats = cacheManager.getStats();
		console.log('缓存统计:', stats);
		
		// 测试缓存存在性
		console.log('\n✅ 测试缓存存在性...');
		const hasCache = cacheManager.has('https://example.com/test.mp4', 'summary', 'zh');
		console.log('缓存是否存在:', hasCache);
		
		console.log('\n🎉 所有测试完成！');
		
	} catch (error) {
		console.error('❌ 测试过程中出现错误:', error);
	}
}

// 执行测试
runTest();

