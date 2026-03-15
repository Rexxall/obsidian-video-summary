# 视频总结插件安装指南

## 快速安装

### 方法一：手动安装（推荐用于开发）

1. **下载插件文件**
   ```bash
   git clone https://github.com/RoronoaZoro35/obsidian-video-summary-plugin.git
   cd obsidian-video-summary-plugin
   ```

2. **安装依赖**
   ```bash
   npm install
   ```

3. **构建插件**
   ```bash
   npm run build
   ```

4. **复制到 Obsidian 插件目录**
   ```bash
   # 将整个文件夹复制到你的 Obsidian 库的插件目录
   cp -r . ~/path/to/your/vault/.obsidian/plugins/video-summary-plugin/
   ```

5. **重启 Obsidian**
   - 关闭 Obsidian
   - 重新打开
   - 进入设置 → 社区插件 → 启用 "Video Summary Plugin"

### 方法二：从社区插件安装（发布后）

1. 打开 Obsidian 设置
2. 进入"社区插件"
3. 搜索"Video Summary Plugin"
4. 点击安装并启用

## 配置 n8n 工作流

### 1. 安装 n8n

```bash
# 使用 Docker
docker run -it --rm \
  --name n8n \
  -p 5678:5678 \
  -v ~/.n8n:/home/node/.n8n \
  n8nio/n8n

# 或使用 npm
npm install n8n -g
n8n start
```

### 2. 导入工作流

1. 打开 n8n 界面：http://localhost:5678
2. 点击右上角的 "Add workflow"（新建工作流）
3. 点击工作流设置齿轮旁边的 `...` 菜单，选择 **"Import from File..."**
4. 选择本项目中的 `Obsidian Video Summary.json` 文件进行导入
5. 保存并激活该工作流 (右上角 Toggle 开启)

### 3. 配置 API 密钥与凭证

由于我们分享的模板移除了原有的 API 密钥，你需要自己配置相关的 AI 模型凭证：

1. **配置 AI Agent 凭证 (Google Gemini / OpenAI 等)**：
   - 在 n8n 流程图中找到标有 `AI-Studio` 或 `Google Gemini` 的节点（如 `Google Gemini 3.1` 等）
   - 双击节点，在 `Credential for ...` 下拉菜单中选择 "Create New Credential"（新建凭证）
   - 输入你的 API Key 并保存，然后**确保所有相关联的 AI 节点都选中了你新建的凭证**。
2. **配置 Gemini Vision 节点的 API Key (如果需要处理图片/视觉内容)**：
   - 找到名为 `Gemini Vision` 的 `HTTP Request` 节点
   - 双击节点，在 "Query Parameters" 中找到 `key` 参数
   - 将数值 `YOUR_GEMINI_API_KEY_HERE` 替换为你自己的 Google Gemini API Key 字符串。

### 4. 配置 Cookie 文件（可选，用于特定的视频网站解析）

对于某些受限平台（如抖音、YouTube 限制年龄视频），需要配置 Cookie 文件供 `yt-dlp` 使用：

```bash
# 创建 Cookie 目录 (假设你映射到了 /home/node/cookies)
mkdir -p ~/.n8n/cookies

# 为不同平台创建 Cookie 文件并填入你在浏览器提取到的 Netscape 格式 cookie
touch ~/.n8n/cookies/youtube_cookies.txt
touch ~/.n8n/cookies/douyin_cookies.txt
```
> **注意**：你需要进入流程图中的 **"Code: Detect Platform & Prepare Download"** 节点，确认脚本第一部分的 `const douyinCookiePath` 等路径与你在 Docker 容器内的路径匹配。

## 插件配置

### 基本设置

1. 打开 Obsidian 设置
2. 进入"视频总结插件"设置
3. 配置以下选项：

**必需设置：**
- **n8n Webhook URL**: `http://localhost:5678/webhook/obsidian-video-summary`

**可选设置：**
- **默认语言**: 中文/英文/日文
- **请求超时时间**: 10分钟（推荐）
- **批量处理并发数**: 3（推荐）
- **显示状态栏**: 开启

### 高级设置

- **自动保存**: 处理完成后自动保存文件
- **调试模式**: 启用详细日志（开发时使用）
- **重试次数**: 网络错误时的重试次数

## 使用方法

### 1. 创建视频笔记

```yaml
---
link: "https://www.youtube.com/watch?v=example"
---
```

### 2. 处理视频

**方法一：命令面板**
- `Ctrl/Cmd + Shift + P`
- 输入"视频总结"
- 选择相应的命令

**方法二：右键菜单**
- 右键点击笔记
- 选择"视频总结"

**方法三：批量处理**
- 命令面板 → "视频总结 - 批量处理"
- 扫描并选择要处理的文件
- 开始批量处理

### 3. 查看管理界面

- 命令面板 → "打开视频总结管理视图"
- 查看统计信息和处理历史

## 故障排除

### 常见问题

**Q: 插件无法连接到 n8n**
```
A: 检查以下几点：
1. n8n 是否正在运行 (http://localhost:5678)
2. Webhook URL 是否正确
3. 防火墙是否阻止了连接
```

**Q: 处理超时**
```
A: 可能的解决方案：
1. 增加超时时间设置
2. 检查网络连接
3. 检查 n8n 工作流是否正常运行
```

**Q: 某些视频无法处理**
```
A: 检查：
1. 视频平台是否受支持
2. 视频是否可公开访问
3. 是否需要配置 Cookie
```

**Q: 生成的总结质量不佳**
```
A: 改进方法：
1. 调整 n8n 工作流中的 AI 提示词
2. 尝试不同的语言模型
3. 检查 API 密钥是否正确配置
```

### 日志查看

启用调试模式后，可以在浏览器控制台查看详细日志：

1. 打开开发者工具 (`F12`)
2. 查看 Console 标签页
3. 查找以 `[Video Summary Plugin]` 开头的日志

### 获取帮助

- **GitHub Issues**: [报告问题](https://github.com/yourusername/obsidian-video-summary-plugin/issues)
- **讨论**: [GitHub Discussions](https://github.com/yourusername/obsidian-video-summary-plugin/discussions)
- **邮箱**: your.email@example.com

## 开发模式

### 启动开发环境

```bash
# 安装依赖
npm install

# 启动开发模式（自动重新构建）
npm run dev

# 在另一个终端中启动 n8n
n8n start
```

### 调试技巧

1. **启用调试模式**: 在插件设置中开启调试模式
2. **查看控制台**: 使用浏览器开发者工具查看日志
3. **热重载**: 开发模式下修改代码会自动重新构建

### 贡献代码

1. Fork 仓库
2. 创建功能分支
3. 提交更改
4. 创建 Pull Request

---

**享受智能化的视频学习体验！** 🎥✨ 