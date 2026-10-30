# 后端能力矩阵（Backend Capability Matrix）

Video Summary 可以连接两类处理端点，也可以只用 Obsidian URI 做离线收件。
能力取决于实际部署的端点；插件不会把不存在的阶段、画面分析或在线结果显示为成功。

最后核对：2026-08-24，插件版本 2.4.2。

## 一句话选择

- **第一次安装或需要下载、字幕与转写**：使用仓库附带的 `n8n` 工作流。
- **已经部署兼容的 Codex Worker，并需要任务进度、取消或深度视觉**：选择
  `codex-worker`。Worker 不包含在本仓库或插件安装包中。
- **只想先收进 Vault，稍后处理**：使用 `obsidian://video-summary` 的
  `capture-only` 入口；它不要求后端在线。

## 能力对照

| 能力                  | 附带的 n8n 工作流             | 兼容的 Codex Worker                          | Obsidian URI 收件   |
| --------------------- | ----------------------------- | -------------------------------------------- | ------------------- |
| 入口角色              | 默认处理后端                  | 可选外部处理后端                             | 收件与显式触发      |
| URL / 文稿 / 本地文件 | 支持；只接受上传根目录文件名  | 取决于 Worker 部署与媒体根目录配置           | 先保存来源          |
| `yt-dlp` 下载与元数据 | 支持                          | 取决于 Worker 部署                           | 不处理              |
| 原生字幕              | 支持                          | 取决于 Worker 部署                           | 不处理              |
| 无字幕时音频转写      | 需另行配置 ASR 子工作流       | 取决于 Worker 部署                           | 不处理              |
| 语音时间轴与证据主张  | 支持 `evidence` 深度          | 支持兼容的 v3 响应                           | 不处理              |
| 真实画面 / 关键帧分析 | **不支持**；会停在 `evidence` | 仅在 Worker、ffmpeg 与视觉模型均已配置时支持 | 不处理              |
| 任务阶段              | 单次 webhook，不伪造中间阶段  | 兼容端点可报告阶段                           | 不适用              |
| 取消                  | 只能停止插件侧等待            | 兼容端点可取消轮询与任务                     | 不适用              |
| 后端离线时收件        | 不适用                        | 不适用                                       | `capture-only` 可用 |

## 重要边界

### n8n

后端安装包里的 `backend/workflows/video-summary.json` 是自动导入的通用工作流，默认 webhook 为：

```text
http://127.0.0.1:5678/webhook/obsidian-video-summary
```

它可以生成时间化语音证据、主张、内容类型、注意力评估和学习材料。原生字幕和粘贴
文稿无需 ASR；无字幕视频和本地音视频要求用户把两个 Transcript 子流程节点绑定到
自己的 ASR 工作流。公开导出不会附带实例专属工作流 ID 或语音服务凭据，具体合同见
[ASR_SUBWORKFLOW_CONTRACT.md](ASR_SUBWORKFLOW_CONTRACT.md)。

附带工作流 2.1.5 的 webhook 强制使用 n8n `Header Auth`。导入后为 webhook 绑定一个
`Header Auth` credential，Header 名称设为 `X-Video-Summary-Token`，值使用本机生成的
高强度随机 Secret；再把完全相同的名称和值填入插件的端点设置。Secret 不会包含在公开
工作流导出中。仓库的 Docker Compose 默认只监听 `127.0.0.1`；若自行开放到局域网或
公网，还必须配置 TLS、访问控制和反向代理限流，不能只依赖这个 Header。

本地文件必须直接复制到 后端文件夹的 `uploads/` 根目录，请求里只发送 basename。任意子目录、
macOS/Windows 绝对路径、斜杠和 shell 元字符都会被拒绝；`obsidian://` 的绝对本地文件
只能离线收件，或交给已配置显式媒体根目录并执行 realpath 边界检查的兼容 Worker。

工作流中的本地图片/PDF OCR 节点不等于视频画面理解；视频帧分析路径没有接入有效
流程。因此插件会把 `deep-visual` 请求降级为 `evidence`，并在 provenance 中记录
实际深度。

### Codex Worker

插件包含兼容 Worker API 的客户端与本地媒体资产安全检查，但 **Worker 服务本身不在
此仓库，也不在 GitHub Release 中**。只有你已经部署了兼容端点并配置 ffmpeg、
视觉模型与相关凭据时，才能使用深度视觉。没有这些条件时不要选择
`deep-visual`，也不要把普通摘要当成画面分析。

### Obsidian URI

`obsidian://video-summary` 默认执行 `capture-only`：创建或复用一条待处理笔记，不调用
AI。只有显式传入 `capture-and-process` 或 `process` 时，插件才会把条目送到当前活动
后端。短链在离线收件阶段无法保证与展开后的长链绝对去重。

URI 本地文件参数必须是绝对路径，以便稳定去重；因此 bundled n8n 后端会保留收件笔记
但拒绝自动提交。要处理它，请直接复制到 后端文件夹的 `uploads/` 后从侧栏/笔记用文件名提交，
或切换到已配置媒体根目录且能够安全访问该路径的 Worker。

## 默认值与切换

- 新安装默认后端是 `n8n`。
- 在 `设置 → Video Summary → 工作流` 中切换后端和端点。
- 设置页的连接检查会验证端点；它不会替你安装 Worker、填写凭据或启用 n8n 工作流。
- 后端预检失败时，插件可以检查另一已配置后端并提示切换，但不会静默替你更换处理端。

## 数据与凭据

凭据、Cookie 和模型密钥应只保存在你自己的 n8n / Worker 部署或本地 Cookie 文件中，
不要写入工作流导出或提交到 Git。Webhook Secret 会保存在 Obsidian 插件的 `data.json`
中（明文、由本机文件权限保护），因此不要同步、分享或提交该文件；怀疑泄露时立即在
n8n 和插件两端轮换。插件会把结构化工件、学习进度与课程状态保存在插件数据目录；详见
[README 的隐私与数据边界](../README.md#privacy-and-data)。
