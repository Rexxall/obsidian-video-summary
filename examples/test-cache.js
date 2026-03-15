// 缓存功能测试脚本
console.log('🧪 测试缓存功能...');

// 测试localStorage访问
function testLocalStorage() {
    console.log('1. 测试localStorage访问...');
    
    try {
        // 检查localStorage是否可用
        if (typeof localStorage !== 'undefined') {
            console.log('✅ localStorage 可用');
            
            // 检查是否有现有的缓存数据
            const existingCache = localStorage.getItem('video-summary-cache');
            if (existingCache) {
                console.log('📦 发现现有缓存数据:', existingCache.length, '字符');
                try {
                    const parsed = JSON.parse(existingCache);
                    console.log('📊 缓存项数量:', parsed.length);
                } catch (e) {
                    console.log('❌ 缓存数据格式错误:', e.message);
                }
            } else {
                console.log('📭 没有现有缓存数据');
            }
        } else {
            console.log('❌ localStorage 不可用');
        }
    } catch (error) {
        console.log('❌ localStorage 测试失败:', error.message);
    }
}

// 测试添加缓存数据
function testAddCache() {
    console.log('\n2. 测试添加缓存数据...');
    
    try {
        const testKey = 'https://example.com/video.mp4|summary|en';
        const testItem = {
            url: 'https://example.com/video.mp4',
            mode: 'summary',
            language: 'en',
            result: {
                summary: 'This is a test summary for the cache.',
                video_transcript: 'This is a test transcript for the cache.'
            },
            timestamp: Date.now(),
            expiryTimestamp: Date.now() + (5 * 60 * 1000) // 5分钟后过期
        };

        // 获取现有缓存
        const existingCache = localStorage.getItem('video-summary-cache');
        const entries = existingCache ? JSON.parse(existingCache) : [];
        
        // 添加测试项
        entries.push([testKey, testItem]);
        localStorage.setItem('video-summary-cache', JSON.stringify(entries));
        
        console.log('✅ 已添加测试缓存项');
        console.log('📊 当前缓存项数量:', entries.length);
        
        return entries.length;
    } catch (error) {
        console.log('❌ 添加缓存数据失败:', error.message);
        return 0;
    }
}

// 测试读取缓存数据
function testReadCache() {
    console.log('\n3. 测试读取缓存数据...');
    
    try {
        const cacheData = localStorage.getItem('video-summary-cache');
        if (cacheData) {
            const entries = JSON.parse(cacheData);
            console.log('📊 缓存项数量:', entries.length);
            
            if (entries.length > 0) {
                console.log('🔍 第一个缓存项:');
                const [key, item] = entries[0];
                console.log('  键:', key);
                console.log('  时间戳:', new Date(item.timestamp).toLocaleString());
                console.log('  过期时间:', new Date(item.expiryTimestamp).toLocaleString());
                console.log('  是否过期:', Date.now() > item.expiryTimestamp ? '是' : '否');
            }
        } else {
            console.log('📭 没有缓存数据');
        }
    } catch (error) {
        console.log('❌ 读取缓存数据失败:', error.message);
    }
}

// 测试缓存统计
function testCacheStats() {
    console.log('\n4. 测试缓存统计...');
    
    try {
        const cacheData = localStorage.getItem('video-summary-cache');
        if (cacheData) {
            const entries = JSON.parse(cacheData);
            const now = Date.now();
            let expiredCount = 0;
            
            for (const [key, item] of entries) {
                if (now > item.expiryTimestamp) {
                    expiredCount++;
                }
            }
            
            const stats = {
                size: entries.length,
                maxSize: 1000,
                expiredCount: expiredCount
            };
            
            console.log('📊 缓存统计:', stats);
            console.log('📈 使用率:', ((stats.size / stats.maxSize) * 100).toFixed(1) + '%');
        } else {
            console.log('📭 没有缓存数据，无法计算统计');
        }
    } catch (error) {
        console.log('❌ 计算缓存统计失败:', error.message);
    }
}

// 运行所有测试
function runAllTests() {
    console.log('🚀 开始缓存功能测试...\n');
    
    testLocalStorage();
    const cacheCount = testAddCache();
    testReadCache();
    testCacheStats();
    
    console.log('\n🎯 测试完成！');
    if (cacheCount > 0) {
        console.log('💡 现在你可以在Obsidian中查看缓存预览了');
        console.log('📍 路径: 设置 → 视频总结插件 → 高级配置 → 缓存配置 → 查看统计');
    }
}

// 执行测试
runAllTests();
