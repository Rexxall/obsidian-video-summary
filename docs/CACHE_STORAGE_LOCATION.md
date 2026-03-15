# 缓存存储位置说明

## 📍 缓存存储位置

### 当前版本 (v2.1.2+)
缓存文件现在存储在插件的专用数据目录中：

```
.obsidian/plugins/video-summary-plugin/data/cache/
├── index.json          # 缓存索引文件
└── items/              # 缓存项文件目录
    ├── abc123.json     # 缓存项文件（文件名是URL的哈希值）
    ├── def456.json
    └── ...
```

### 之前版本 (v2.1.1及以下)
缓存文件存储在库根目录：

```
库根目录/
├── cache/              # 缓存目录
│   ├── index.json      # 缓存索引文件
│   └── items/          # 缓存项文件目录
│       ├── abc123.json
│       └── ...
└── 其他文件...
```

## 🔄 迁移说明

### 自动迁移
- 插件会自动检测旧的缓存位置
- 如果发现旧缓存，会自动迁移到新位置
- 迁移完成后，旧缓存文件会被保留（作为备份）

### 手动迁移（如果需要）
如果自动迁移失败，可以手动迁移：

1. **备份旧缓存**
   ```bash
   cp -r cache/ cache_backup/
   ```

2. **创建新缓存目录**
   ```bash
   mkdir -p .obsidian/plugins/video-summary-plugin/data/cache/items
   ```

3. **复制缓存文件**
   ```bash
   cp cache/index.json .obsidian/plugins/video-summary-plugin/data/cache/
   cp cache/items/* .obsidian/plugins/video-summary-plugin/data/cache/items/
   ```

## 🎯 为什么改变存储位置？

### 问题
- 旧位置：缓存文件存储在库根目录，与其他笔记文件混在一起
- 影响：可能被误删、版本控制冲突、备份时包含不必要文件

### 解决方案
- 新位置：缓存文件存储在插件专用目录
- 优势：
  - ✅ 与笔记文件分离
  - ✅ 不会被误删
  - ✅ 版本控制时可以选择忽略
  - ✅ 备份时更清晰
  - ✅ 符合Obsidian插件标准

## 📁 目录结构说明

### 插件数据目录
```
.obsidian/plugins/video-summary-plugin/
├── data.json           # 插件设置文件
├── data/               # 插件数据目录
│   └── cache/          # 缓存目录
│       ├── index.json  # 缓存索引
│       └── items/      # 缓存项文件
└── main.js             # 插件主文件
```

### 缓存索引文件 (index.json)
```json
{
  "version": "2.0.0",
  "lastUpdated": 1703123456789,
  "maxSize": 1000,
  "expiryDays": 30,
  "items": {
    "https://example.com/video.mp4|summary|zh": {
      "url": "https://example.com/video.mp4",
      "mode": "summary",
      "language": "zh",
      "timestamp": 1703123456789,
      "expiryTimestamp": 1705715456789,
      "size": 1024,
      "path": "cache/items/abc123.json"
    }
  }
}
```

### 缓存项文件 (items/*.json)
```json
{
  "url": "https://example.com/video.mp4",
  "mode": "summary",
  "language": "zh",
  "result": {
    "summary": "视频摘要内容...",
    "video_transcript": "视频转录内容...",
    "video_title": "视频标题",
    "processed_at": "2023-12-21T10:30:56.789Z"
  },
  "timestamp": 1703123456789,
  "expiryTimestamp": 1705715456789
}
```

## 🔧 清理缓存

### 通过插件界面
1. 打开设置 → 视频总结插件 → 高级配置 → 缓存配置
2. 点击相应的清理按钮

### 手动清理
```bash
# 删除所有缓存
rm -rf .obsidian/plugins/video-summary-plugin/data/cache/

# 只删除缓存项文件（保留索引）
rm -rf .obsidian/plugins/video-summary-plugin/data/cache/items/*
```

## ⚠️ 注意事项

1. **不要手动删除插件目录**：可能导致插件无法正常工作
2. **备份重要数据**：清理缓存前建议备份
3. **版本控制**：建议将 `.obsidian/plugins/*/data/` 添加到 `.gitignore`
4. **磁盘空间**：定期清理过期缓存以节省空间

## 🆘 故障排除

### 缓存不工作
1. 检查插件数据目录是否存在
2. 检查文件权限
3. 查看浏览器控制台错误信息

### 迁移失败
1. 检查旧缓存目录是否存在
2. 手动执行迁移步骤
3. 重启Obsidian

### 缓存文件损坏
1. 删除损坏的缓存文件
2. 重新处理视频
3. 如果问题持续，清空所有缓存
