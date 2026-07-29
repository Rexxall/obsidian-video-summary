# Video Summary 十项方向开发与验收

日期：2026-07-29

分支：`codex/design-fidelity-v4`

基线备份：`backup/pre-ten-directions-20260729`（`174df15`）

## 验收结论

十项方向均已有可运行实现，不再只是 UI 占位。插件侧自动化验收为
`140/140`，生产构建、TypeScript、ESLint、Prettier 和 `git diff --check`
均通过。正式安装版已在 Obsidian 1.12.7 中完成本地离线 UI 实机验收；
这不等于线上端到端验收。需要平台播放器、在线后端、视觉模型或真实播放
列表的路径按“诚实边界”保留为集成验收项，不把离线 fixture 冒充在线结果。

## 1. 多模态证据地图

- 工件 schema v3 保存文稿段、主张、视觉证据、来源类型、时间质量与 provenance。
- Markdown 只更新受管区块，用户正文不被重处理覆盖。
- 缺失证据、推断内容、越界时间和未声明的数值时间均显式降级，不伪装为精确引用。
- 用户重点与人工确认关系是用户所有状态；并发重处理不会覆盖。分段 ID 改变时重点保留并标记待复核。

证据：`ArtifactStore`、`KnowledgeModel`、`KnowledgeMarkdown` 及对应测试。

## 2. 同步视频阅读器

- 本地媒体使用 HTML5 播放器，播放时间驱动当前文稿段。
- YouTube 使用 iframe API，支持时间跟随、点击文稿跳转与重点标记。
- Bilibili 支持点击文稿跳转；播放器没有稳定时间事件时明确提示，暂不声称自动跟随。
- 重点写入工件 sidecar，重启后仍在。
- 重点控件向辅助功能树暴露独立名称与按下状态，并支持鼠标、Enter 和空格触发。
- 本轮只实机验证了外部播放器降级、3 段阅读器和重点写入；YouTube 自动跟随、本地媒体播放和 Bilibili 实际跳转仍是在线/媒体集成验收项。

证据：`ReaderPanel`、`ArtifactStore.updateHighlights`。

## 3. 真正的视觉理解

- 外部本地组件 `Extensions/codex-video-worker` 用 ffmpeg 抽取真实帧，支持场景/等距采样和视觉模型提供方。
- 插件只接收 loopback 来源、受支持图片类型与哈希匹配的资产，并本地化到受管目录。
- n8n 不支持深度视觉时自动降级为 evidence，provenance 和设置 UI 都记录真实深度。

证据：Worker 视觉专项 `6/6`（含真实 ffmpeg fixture）、`MediaAssetLocalizer`、
API 深度降级测试。Worker 完整套件本轮为 `31/32`：唯一失败是沙箱禁止
`127.0.0.1` 监听的 `EPERM`，不是把在线服务伪报为已启动。

## 4. 自动内容类型路由

- 支持 course、interview、tutorial、news、meeting、review、general 七类。
- 优先级固定为：用户手选 > 有显式置信度的后端结果 > 本地证据 > general。
- 每类有独立 prompt profile、输出结构和证据约束；n8n 工作流携带同一机器可读契约。

证据：`ContentRouter`、工作流结构测试。本轮 n8n 离线，未做在线 webhook
端到端验收。

## 5. 注意力评估

- 输出 watch / skim / skip 及信息密度、原创性、可执行性、Vault 相关度、推广占比。
- 评分权重和阈值公开、可测试；没有用户上下文时不编造 Vault 相关度。
- 必看/可跳区间只能落在真实时间证据上。

证据：`AttentionEngine` 的边界、语言、广告和缺证据测试。

## 6. 播放列表 / 频道课程编译器

- YouTube 播放列表与 Bilibili 合集/收藏夹支持分页、上限、去重和增量导入。
- 课程清单保存原顺序、推荐顺序、前置关系、缺失概念、删除项和逐课进度。
- 导入只建 pending 笔记，不调用 AI；失败项可重试，已存在笔记可恢复。
- CourseStore 对并发进度、旧预览回写和结构删除做原子合并；课程索引用最新 manifest + `Vault.process`，不覆盖自由正文。

证据：`PlaylistProcessor`、`CourseCompiler`、`CourseStore`、`CourseIndexWriter`
及自动化测试。本轮没有导入真实播放列表。

## 7. 多视频主张实验室

- 至少选择两个持久化工件后生成主张矩阵。
- 支持 agreement、conflict、update、unique、unknown；缺失真实 segment 的主张不会被判成冲突。
- 输出受管区块，重跑保留用户正文；跨视频关系必须人工确认后才写入。

证据：`ClaimLab`、`KnowledgeLabModal`、review-gate 测试。实机只验证了
单工件时的安全拒绝；双工件矩阵生成由自动化覆盖。

## 8. 跨模态视频记忆搜索

- 索引标题、作者、文稿、OCR、屏幕文字、视觉描述和主张。
- 支持作者、平台、日期、内容类型和课程过滤；结果展示实际命中字段与可解释分数。
- 新工件、课程关联和手工重命名会实时 upsert；重启从 sidecar 重建。

证据：`CrossModalMemory` 的搜索、过滤、长文覆盖和重建测试。

## 9. 学习与复习闭环

- 从闪卡和自测题生成稳定的本地内容 ID；后端随机 ID 只作 provenance。
- 字母、全角字母和数字选项答案会解析为实际选项。
- 本地 sidecar 保存尝试、正确率、把握程度、间隔、到期时间、掌握和暂停状态。
- 提供当前视频复习与跨视频到期队列；最早到期时间同步到笔记 Properties，Base 用 `now()` 比较完整时间戳，只显示真正到期项。

证据：`LearningProgressStore`、`LearningReviewModal`、稳定 ID 与调度测试。

## 10. 任意入口收件箱、Base 与可复现工件

- `obsidian://video-summary` 默认离线 capture-only；来源身份并发去重，冷启动 metadata cache 未就绪时回读笔记。
- 通用 URL 可收藏但不会误报开始处理；外部协议处理本地文件需媒体扩展校验和用户确认。
- 自动生成五视图 Base：Inbox、Processing、Ready、Error、Review；只覆盖未修改的受管 Base。
- 可复现清单保存并校验文稿、segments、claims、visual evidence、后端、模型、prompt、版本和深度。
- 无源重处理不发送 `link`、`local_file` 或 `local_files`；旧证据随请求提交并在后端缺字段时回退。
- 无源重处理始终以校验过的本地文稿为来源身份；后端只回摘要或改写文稿都不会拆出重复工件。
- Codex Worker 请求、轮询和等待均可取消，并受同一个总截止时间约束，不会永久占住任务队列。
- 普通 Vault rename/delete 会同步工件、可复现清单、人工关系、课程、捕获缓存和当前内存索引。

证据：`CaptureInbox`、`BasesGenerator`、`ReproducibilityManifest/Store`、API 出站测试。

## 自动验收

```text
npm test            140/140 passed
npm run build       passed
npm run lint        passed
targeted Prettier   passed
git diff --check    passed
Worker visual tests 6/6 passed
Worker full suite   31/32; server listen blocked by sandbox EPERM
```

## 诚实边界

- Bilibili 嵌入播放器当前是“点击文稿跳转”，不是播放时间自动跟随。
- 深度视觉依赖本地 Codex Worker、ffmpeg 和已配置视觉模型；n8n 路径只到 evidence。
- capture-only 必须离线工作，因此短链在展开前无法与最终长链做绝对去重；显式处理时才会尝试展开。
- “无源重处理”保证不重新下载并校验本地快照，但新结果仍使用当前后端/模型，不宣称位级或随机采样完全复现。
- 只有文稿/证据足够形成无源输入时才生成可复现清单；纯视觉、无文稿结果不会伪称可无源重跑。

## 验收分层

| 层级                               | 状态       | 本轮证据与边界                                                                |
| ---------------------------------- | ---------- | ----------------------------------------------------------------------------- |
| 插件自动化                         | 通过       | `140/140`，构建、Lint、格式和 diff 检查通过                                   |
| Obsidian 离线 UI                   | 通过       | 重载、侧栏、198 条笔记库、详情六标签、3 段陪读、证据、重点、复习、搜索和 Base |
| Worker 视觉专项                    | 通过       | `6/6`，含真实 ffmpeg fixture；未做线上视觉模型调用                            |
| Worker 完整套件                    | 环境受限   | `31/32`；server test 因沙箱禁止 loopback listen 返回 `EPERM`                  |
| Claim Lab 正向生成                 | 自动化通过 | 实机只有 1 个工件，验证了安全门；双工件矩阵未做实机                           |
| 课程编译 / 索引                    | 自动化通过 | 顺序、增量、并发进度和自由正文保留已测；未导入真实播放列表                    |
| YouTube / 本地媒体 / Bilibili 播放 | 待在线集成 | 本轮 fixture 是通用 URL，只验证诚实的外部播放器降级                           |
| n8n 在线端到端                     | 未执行     | 实机明确显示 n8n 离线                                                         |
| 发布                               | 未执行     | 未 push、未发布                                                               |

## Obsidian 离线实机清单

- [x] 重载插件后侧栏、198 条笔记库、详情页和同步阅读器正常打开。
- [x] “搜索跨模态视频记忆”“生成多视频论点实验室”“复习当前视频的学习卡”“复习所有到期的视频学习卡”“生成或安全更新视频库 Base”命令可见并可打开。
- [x] 隔离测试笔记验证 3 段时间定位、证据地图、文稿、元数据、日志空态和重点 sidecar；星标在 UI 与 sidecar 中均为已选中。
- [x] 当前视频复习显示 2 张学习卡和答案/评分控件；全局到期队列显示 1 个视频、2 张到期卡。
- [x] 跨模态检索从 10 条本地证据记录中以 `Synchronized reader` 命中 2 条 0:15 证据。
- [x] 多视频论点实验室在只有 1 个持久化工件时明确拒绝生成。
- [x] `Video Summary Library.base` 已存在且受管签名为最新，Review 视图使用完整时间戳 `now()`。
- [x] 安装同步目标严格限定为 `main.js`、`styles.css`、`manifest.json`；安装 Git 最终只提交前两者，`manifest.json` 内容未变。同步后、QA 前已核对运行数据哈希未变；QA 随后正常写入测试历史、工件、可复现清单和重点，故不声称最终 `data.json`、`history.json` 或 `data/` 字节不变。
- [x] 安装前备份分支为 `backup/pre-ten-directions-runtime-20260729`（`af4cb91`），安装提交为 `607786b`；未 push、未发布。

## 实机验收工件

- 笔记：`90 - Sandbox/Video Summary E2E/Codex 十项功能实机验收 2026-07-29_1785341045380.md`
- 工件：`vka-96174a178e9610b81a9c96167cfb36c0`
- 重点：`highlight-qa-seg-1` → `qa-seg-1`
- Base：`90 - Sandbox/Video Summary E2E/Video Summary Library.base`
- 边界提示：fixture 明示 `Synthetic local QA fixture; no backend was called.`；实机同时显示 n8n 离线，没有声称在线 AI 或深度视觉成功。

## Git 与安装记录

- 十项主体实现：`81bfa18`
- 重点无障碍修复：`260c58e`
- 安装版提交：`607786b`
- 源码基线备份：`backup/pre-ten-directions-20260729`
- 完整功能备份：`backup/ten-directions-complete-20260729`
- 运行文件临时备份：`/private/tmp/video-summary-runtime-backup-20260729-ND4ASY/`
- 重点修复前运行文件备份：`/private/tmp/video-summary-accessibility-presync-20260729-jNZzf1/`
