// 缓存功能演示脚本
// 这个脚本展示了智能缓存系统的工作原理

console.log('🚀 视频总结插件 - 智能缓存系统演示');
console.log('=====================================');

// 模拟缓存管理器
class DemoCacheManager {
    constructor() {
        this.cache = new Map();
        this.stats = {
            hits: 0,
            misses: 0,
            savings: 0
        };
    }

    // 生成缓存键
    generateKey(url, mode, language) {
        return `${url}|${mode}|${language}`;
    }

    // 检查缓存
    has(url, mode, language) {
        const key = this.generateKey(url, mode, language);
        return this.cache.has(key);
    }

    // 获取缓存
    get(url, mode, language) {
        const key = this.generateKey(url, mode, language);
        const item = this.cache.get(key);
        if (item) {
            this.stats.hits++;
            console.log(`✅ 缓存命中: ${url}`);
            return item;
        }
        this.stats.misses++;
        console.log(`❌ 缓存未命中: ${url}`);
        return null;
    }

    // 设置缓存
    set(url, mode, language, result) {
        const key = this.generateKey(url, mode, language);
        this.cache.set(key, result);
        console.log(`💾 缓存已保存: ${url}`);
    }

    // 显示统计
    showStats() {
        console.log('\n📊 缓存统计:');
        console.log(`  命中次数: ${this.stats.hits}`);
        console.log(`  未命中次数: ${this.stats.misses}`);
        console.log(`  命中率: ${((this.stats.hits / (this.stats.hits + this.stats.misses)) * 100).toFixed(1)}%`);
        console.log(`  缓存项数: ${this.cache.size}`);
    }
}

// 模拟API调用
class DemoAPI {
    constructor(cacheManager) {
        this.cacheManager = cacheManager;
        this.apiCalls = 0;
        this.costPerCall = 0.01; // $0.01 per API call
    }

    async processVideo(url, mode, language) {
        console.log(`\n🎥 处理视频: ${url}`);
        console.log(`   模式: ${mode}, 语言: ${language}`);

        // 检查缓存
        if (this.cacheManager.has(url, mode, language)) {
            const cachedResult = this.cacheManager.get(url, mode, language);
            console.log(`💰 使用缓存，节省API费用 $${this.costPerCall}`);
            return cachedResult;
        }

        // 调用API
        console.log(`🌐 调用API处理...`);
        this.apiCalls++;
        
        // 模拟API处理时间
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // 模拟API结果
        const result = {
            summary: `这是 ${url} 的 ${mode} 结果（${language}）`,
            timestamp: new Date().toISOString()
        };

        // 保存到缓存
        this.cacheManager.set(url, mode, language, result);
        
        console.log(`💸 API调用完成，费用 $${this.costPerCall}`);
        return result;
    }

    showCosts() {
        const totalCost = this.apiCalls * this.costPerCall;
        console.log(`\n💵 费用统计:`);
        console.log(`  API调用次数: ${this.apiCalls}`);
        console.log(`  总费用: $${totalCost.toFixed(2)}`);
        console.log(`  平均每次费用: $${this.costPerCall}`);
    }
}

// 演示场景
async function runDemo() {
    const cacheManager = new DemoCacheManager();
    const api = new DemoAPI(cacheManager);

    console.log('\n📺 场景1: 首次处理视频（会调用API）');
    await api.processVideo('https://bilibili.com/video/BV123456', 'summary', 'zh');

    console.log('\n📺 场景2: 重复处理相同视频（使用缓存）');
    await api.processVideo('https://bilibili.com/video/BV123456', 'summary', 'zh');

    console.log('\n📺 场景3: 不同模式处理（会调用API）');
    await api.processVideo('https://bilibili.com/video/BV123456', 'transcript-only', 'zh');

    console.log('\n📺 场景4: 不同语言处理（会调用API）');
    await api.processVideo('https://bilibili.com/video/BV123456', 'summary', 'en');

    console.log('\n📺 场景5: 再次处理中文总结（使用缓存）');
    await api.processVideo('https://bilibili.com/video/BV123456', 'summary', 'zh');

    console.log('\n📺 场景6: 处理新视频（会调用API）');
    await api.processVideo('https://bilibili.com/video/BV789012', 'summary', 'zh');

    // 显示统计信息
    cacheManager.showStats();
    api.showCosts();

    console.log('\n🎯 演示总结:');
    console.log('  - 相同URL + 相同模式 + 相同语言 = 使用缓存');
    console.log('  - 不同URL/模式/语言 = 调用API');
    console.log('  - 缓存功能大幅节省API费用');
    console.log('  - 提升处理速度和用户体验');
}

// 运行演示
runDemo().catch(console.error);
