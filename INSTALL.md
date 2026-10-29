# 安装教程

[English](docs/INSTALL.en.md) · [日本語](docs/INSTALL.ja.md)

视频总结由两部分组成：

- **Obsidian 插件：** 在笔记里贴链接、看进度、读结果。
- **后端：** 在你自己电脑上运行，负责下载字幕或音频、转文字、调用模型写总结。它跑在 Docker 里，用一个启动脚本就能装好，不需要会写代码。

整个过程大约 20 分钟，其中第一次构建后端要等 5–15 分钟。

## 0. 先准备

| 要什么                                               | 做什么用                                 | 去哪里拿                                                                                            |
| ---------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Obsidian 桌面版                                      | 写笔记                                   | [obsidian.md](https://obsidian.md)                                                                  |
| Docker Desktop（Windows、macOS）或 OrbStack（macOS） | 运行后端                                 | [Docker Desktop](https://www.docker.com/products/docker-desktop/)、[OrbStack](https://orbstack.dev) |
| DeepSeek 密钥                                        | 写总结                                   | [DeepSeek 开放平台](https://platform.deepseek.com/api_keys)，充值几元就够用很久                     |
| 硅基流动密钥                                         | 没有字幕的视频、本地音视频转文字；读图片 | [硅基流动](https://cloud.siliconflow.cn/account/ak)，语音转写模型免费                               |
| 哔哩哔哩账号（可选）                                 | 拿 B 站字幕和 AI 字幕                    | 手机客户端扫码即可                                                                                  |

**费用：** 以下价格按 2026-10-29 的官方价格页核对，以对方页面为准。

- **DeepSeek：** 默认模型 `deepseek-flash` 每百万词元输入 1–2 元、输出 4–8 元，工作日白天是高峰价，其余时间半价（[价格页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)）。总结一个半小时以内的视频通常只要几分钱。
- **硅基流动：** 语音转写模型 `FunAudioLLM/SenseVoiceSmall` 免费（[价格页](https://siliconflow.cn/pricing)），但账户里要有余额：实测余额为 0 时，连免费模型也会被拒绝（402），充值一两元即可。读图片默认用 `Qwen/Qwen3-VL-8B-Instruct`，按量计费，读一张图通常不到一分钱。
- **实测：** 2026-10-29 验收时跑了 8 次总结（包括一段 47 分钟的视频），DeepSeek 一共花了约 0.4 元（非高峰时段）。

只想用一家？可以全部用硅基流动：把总结模型也换成硅基流动上的 DeepSeek，见 [换模型](#换模型)。

## 1. 安装插件

在 Obsidian 里打开 **设置 → 第三方插件 → 浏览**，搜索 **Video Summary**，安装并启用。

如果商店里暂时搜不到：从 [最新 Release](https://github.com/Rexxall/obsidian-video-summary/releases/latest) 下载 `video-summary-<版本>.zip`，把里面的 `main.js`、`manifest.json`、`styles.css` 三个文件放进 `<你的库>/.obsidian/plugins/video-summary/`，重启 Obsidian 后在第三方插件里启用。

## 2. 安装并打开 Docker

装好 Docker Desktop 或 OrbStack 后打开它，等它显示正在运行（Docker Desktop 左下角是绿色的 Engine running）。以后每次开机，后端都会随 Docker 自动启动。

## 3. 下载并启动后端

1. 从 [最新 Release](https://github.com/Rexxall/obsidian-video-summary/releases/latest) 下载 `video-summary-backend-<版本>.zip`。
2. 解压到一个不会被删掉的位置，例如“文稿”或 `D:\`。**不要放进 Obsidian 库里**，否则会被同步软件同步。
3. 打开解压出来的 `video-summary-backend` 文件夹：
   - **macOS：** 右键点 `start-mac.command`，选“打开”。第一次 macOS 会问是否打开来自网络的文件，选“打开”。
   - **Windows：** 双击 `start-windows.cmd`。如果出现“Windows 已保护你的电脑”，点“更多信息 → 仍要运行”。
4. 按提示粘贴两个密钥。输入时屏幕上不显示内容，粘贴后直接按回车；暂时没有的可以直接回车跳过，以后再填。
5. 等待。第一次要下载和构建，约 5–15 分钟。脚本会自动判断网络：连不上 Docker Hub 时自动改用国内镜像。
6. 看到“好了”和一行 **连接码** 就成功了。连接码已经复制到剪贴板。

启动脚本最后会显示（连接码里的端口可能是 5679 等，以实际显示为准）：

```text
等待后端就绪.......... 好了。

连接码（在 Obsidian → 设置 → 视频总结 → 首次配置 里粘贴）：

  http://127.0.0.1:5678/webhook/obsidian-video-summary#token=…

已复制到剪贴板。
```

**连接码** 长这样：`http://127.0.0.1:5678/webhook/obsidian-video-summary#token=…`。它相当于后端的口令，不要发给别人。忘了的话，在后端文件夹里运行 `./vs-backend.sh code`（Windows：`.\vs-backend.ps1 code`）可以再显示一次。

## 4. 在 Obsidian 里完成首次配置

打开 **设置 → 视频总结**，最上面是 **首次配置**：

1. **① 连接码：** 点“从剪贴板粘贴”。
2. **② 检查：** 点“完整检查”。它会确认后端、连接码、模型和语音转写都能用。哪一项不对，会直接写出怎么改。
3. **③ 试运行：** 用一段内置短文稿生成一次总结，看到“跑通了”就说明整条流程没问题。
4. **④ 哔哩哔哩登录（可选）：** 点“扫码登录”，用 B 站手机客户端扫一下并确认。之后有字幕的 B 站视频会直接用字幕（包括 B 站的 AI 字幕），更快也更准；不登录也能用，只是会改用语音转写。

<img src="docs/screenshots/setup-check.jpg" width="640" alt="首次配置：完整检查全部通过">

## 5. 总结第一个视频

新建一篇笔记，写上：

```yaml
---
link: 'https://www.bilibili.com/video/BV…'
status: pending
---
```

然后点左侧栏的视频总结图标，或运行命令“处理当前笔记”。也可以直接在侧栏的输入框里粘贴链接。

| 输入                        | 后端怎么做                                                                                   |
| --------------------------- | -------------------------------------------------------------------------------------------- |
| 有字幕的 B 站、YouTube 视频 | 直接用字幕，最快                                                                             |
| 没有字幕的视频              | 下载音频，用语音转写，长音频自动按 10 分钟切段                                               |
| 本地音视频                  | 先把文件放进后端文件夹的 `uploads` 里，再在笔记里写 `local_file: '文件名.mp4'`（只写文件名） |
| 本地图片、PDF               | 同上放进 `uploads`；PDF 直接提取文字，图片用识图模型读                                       |
| 已经有文稿                  | 粘贴到侧栏的“粘贴文稿”，不经过下载和转写                                                     |

## 平台说明

- **B 站：** 优先使用。顺序是“UP 主上传的字幕 → B 站 AI 字幕 → 语音转写”。AI 字幕需要先完成第 4 步的扫码登录。
- **YouTube：** 在中国大陆需要代理。在后端的 `.env` 里填 `VS_HTTP_PROXY`（例如 `http://host.docker.internal:7890`），再运行一次启动脚本。
- **抖音、小红书、TikTok：** 尽力而为。平台经常改接口，失败时多半要更新下载器（运行 `./vs-backend.sh update`）或导入登录 cookie；实在不行，就把文案复制出来走“粘贴文稿”。

## 日常使用

在后端文件夹里运行（Windows 把 `./vs-backend.sh` 换成 `.\vs-backend.ps1`）：

| 命令                     | 作用                                                 |
| ------------------------ | ---------------------------------------------------- |
| `./vs-backend.sh`        | 启动；改过 `.env` 后也用它让设置生效                 |
| `./vs-backend.sh check`  | 检查模型、语音转写和 B 站登录是否可用                |
| `./vs-backend.sh code`   | 再显示一次连接码                                     |
| `./vs-backend.sh keys`   | 重新输入密钥                                         |
| `./vs-backend.sh logs`   | 看后端日志                                           |
| `./vs-backend.sh stop`   | 停止后端（数据保留）                                 |
| `./vs-backend.sh update` | 更新下载器和基础镜像；B 站、抖音突然下载失败时先试它 |

升级到新版本：下载新的后端压缩包，解压覆盖旧文件夹（`.env`、`uploads`、`cookies` 会保留），再运行 `./vs-backend.sh update`。

### 换模型

所有总结步骤共用一个模型，任何兼容 OpenAI 接口的服务都可以。改后端文件夹里的 `.env`，再运行一次启动脚本：

| 服务             | `VS_CHAT_BASE_URL`                                        | `VS_CHAT_MODEL`                   |
| ---------------- | --------------------------------------------------------- | --------------------------------- |
| DeepSeek（默认） | `https://api.deepseek.com`                                | `deepseek-flash`                  |
| 硅基流动         | `https://api.siliconflow.cn/v1`                           | `deepseek-ai/DeepSeek-V4.1-Flash` |
| 通义千问         | `https://dashscope.aliyuncs.com/compatible-mode/v1`       | `qwen-plus`                       |
| Kimi             | `https://api.moonshot.cn/v1`                              | 以 Kimi 控制台的模型列表为准      |
| Gemini（可选）   | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-flash-latest`             |

`VS_CHAT_API_KEY` 填对应服务的密钥。语音转写（`VS_SPEECH_*`）和识图（`VS_VISION_*`）同理，可以换成任何兼容 `/audio/transcriptions` 和 `/chat/completions` 的服务。

## 排错

先在 Obsidian 的“首次配置”里点“完整检查”，它会给出具体做法。常见情况：

| 现象                                                                                    | 原因                                            | 怎么办                                                        |
| --------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------- |
| 启动脚本说“没有找到 Docker”或“Docker 没有在运行”                                        | Docker 没装或没打开                             | 打开 Docker Desktop／OrbStack，等它显示运行中，再运行启动脚本 |
| macOS 提示“无法打开，因为它来自身份不明的开发者”                                        | 系统对下载文件的保护                            | 右键 `start-mac.command` →“打开”                              |
| 第一次构建卡在下载很久                                                                  | 网络慢                                          | 在 `.env` 设 `VS_MIRROR=cn` 强制用国内镜像，再运行启动脚本    |
| “端口 5678 已被占用，改用 5679”                                                         | 电脑上已有别的 n8n                              | 不用管，连接码里已经是新端口                                  |
| 检查显示“连不上后端”                                                                    | 后端没在运行                                    | 打开 Docker，再运行启动脚本                                   |
| 检查显示“后端还没准备好”                                                                | 刚启动，n8n 还在加载                            | 等一分钟再检查                                                |
| 检查显示“连接码不对”                                                                    | 重新生成过 `.env`，或复制不完整                 | 运行 `./vs-backend.sh code`，重新粘贴                         |
| 总结模型“服务商不认这个密钥”                                                            | 密钥填错或已删除                                | 运行 `./vs-backend.sh keys` 重新输入                          |
| 总结模型或语音转写“余额不足”“Payment required”                                          | 账户没钱了；硅基流动余额为 0 时免费模型也不能用 | 到服务商控制台充值一两元                                      |
| “服务商的模型列表里没有这个名字”                                                        | `VS_CHAT_MODEL` 写错                            | 按上面的换模型表核对                                          |
| “后端连不上 api.xxx.com”                                                                | 网络或代理问题                                  | 检查网络；需要代理时填 `VS_HTTP_PROXY`                        |
| B 站视频下载报 412                                                                      | B 站拦截了旧版下载器                            | 运行 `./vs-backend.sh update`；仍不行就在首次配置里扫码登录   |
| B 站视频没用字幕、走了语音转写                                                          | 没登录，或视频本身没有字幕                      | 扫码登录；没有字幕的视频只能转写                              |
| 本地文件报“must be a supported file name placed directly in the backend uploads folder” | 文件不在 `uploads` 里，或写了路径               | 把文件放进后端的 `uploads`，笔记里只写文件名                  |
| 笔记里出现“Error: 模型调用失败”                                                         | 模型密钥、余额或模型名有问题                    | 按错误后面的提示改 `.env`                                     |

还解决不了：运行 `./vs-backend.sh logs`，把最后几十行（先删掉看起来像密钥的内容）附在 [Issue](https://github.com/Rexxall/obsidian-video-summary/issues) 里。

## 安全说明

- 后端只在本机 `127.0.0.1` 上开放，局域网和外网访问不到。
- 密钥只存在后端文件夹的 `.env` 和后端自己的数据卷里，插件不保存模型密钥。
- B 站登录信息只交给你自己的后端，用于下载字幕，插件不保存。
- 不要把后端端口改成对外开放；确实需要远程访问时，见 [backend/SECURITY.md](backend/SECURITY.md)。

## 进阶

- **改用自己的 n8n：** 安装包里的工作流在 `workflows/` 文件夹，凭据由 `init/configure.mjs` 生成，可以参考。手动导入时要自己装 yt-dlp 和 ffmpeg，并设置 `NODES_EXCLUDE` 放行 Execute Command 节点。
- **换语音转写方案：** 见 [语音转写子流程约定](docs/ASR_SUBWORKFLOW_CONTRACT.md)。
- **从源码构建插件：** `npm install && npm run build`。
