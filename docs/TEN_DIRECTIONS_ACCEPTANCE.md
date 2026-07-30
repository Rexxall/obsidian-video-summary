# Video Summary 2.4.1 十项方向验收

日期：2026-07-29

公开版复核：2026-07-31

## 结论

十项方向均有可运行的数据层、交互入口、持久化结果和自动化证据，不是仅展示 UI。
插件自动化、生产构建、TypeScript、ESLint、目标文件格式检查和 Git 空白检查通过；
本地 Obsidian 1.12.7 的离线 UI 验收通过。

这不等于所有线上集成都已验收。依赖真实平台播放器、在线 n8n、外部 Worker、
视觉模型或真实播放列表的路径继续列为集成项，不把合成 fixture 当成在线结果。

## 1. 多模态证据地图

- schema v3 保存时间化文稿段、主张、视觉证据、来源类型、时间质量与 provenance。
- Markdown 只更新受管区块，不覆盖用户自由正文。
- 缺失证据、推断内容、越界时间和未声明的数值时间都会显式降级。
- 用户重点和人工确认关系独立持久化；重处理不会静默覆盖用户状态。

证据：`ArtifactStore`、`KnowledgeModel`、`KnowledgeMarkdown` 及对应测试。

## 2. 同步视频阅读器

- 本地媒体使用 HTML5 播放器，YouTube 使用 iframe API。
- 支持时间跟随、文稿跳转和持久化重点；重点控件可用鼠标、Enter 和空格操作。
- Bilibili 只声明点击文稿跳转，不声明自动播放时间跟随。
- 不支持的来源降级为外部时间链接，不丢失文稿或重点。

证据：`ReaderPanel`、`ArtifactStore.updateHighlights` 及自动化测试；离线实机验收覆盖
外部播放器降级、分段阅读器和重点写入。

## 3. 视觉理解

- 插件支持接收兼容外部 Worker 生成的真实关键帧、OCR 和视觉描述。
- 仅接受 loopback 资产来源、受支持图片类型与哈希匹配文件，并本地化到受管目录。
- n8n 不支持深度视觉时会降级到 `evidence`，provenance 和设置界面记录实际深度。

边界：Worker 服务不在此仓库或 Release 中。深度视觉要求外部 Worker、ffmpeg 和已配置
视觉模型；本轮没有执行线上视觉模型调用。

## 4. 自动内容类型路由

- 支持 course、interview、tutorial、news、meeting、review、general。
- 优先级为：用户手选 > 带显式置信度的后端结果 > 本地证据 > general。
- 每类有独立输出合同和证据约束，n8n 工作流携带同一机器可读合同。

证据：`ContentRouter` 与工作流合同测试。未执行在线 webhook 端到端验收。

## 5. 注意力评估

- 输出 watch / skim / skip，以及信息密度、原创性、可执行性、Vault 相关度和推广占比。
- 评分权重与阈值可测试；没有用户上下文时不会编造 Vault 相关度。
- 必看与可跳区间只能引用真实时间证据。

证据：`AttentionEngine` 的边界、语言、推广和缺证据测试。

## 6. 播放列表与课程编译

- 支持 YouTube 播放列表和 Bilibili 合集/收藏夹的分页、上限、去重与增量导入。
- 课程清单保存原顺序、推荐顺序、相邻课号依赖、缺失课号、删除项和逐课进度；不会推断
  语义层面的先修概念。
- 导入只创建 pending 笔记，不调用 AI；失败项可重试，已有笔记可恢复。
- 并发进度更新和课程索引不会覆盖自由正文。

证据：`PlaylistProcessor`、`CourseCompiler`、`CourseStore`、`CourseIndexWriter` 及测试。
未执行真实播放列表导入。

## 7. 多视频 Claim Lab

- 至少两个持久化工件才能生成主张矩阵。
- 支持 agreement、conflict、update、unique、unknown。
- 缺失真实文稿段的主张不会被判定为已证实冲突。
- 输出保存为受管 Markdown；跨视频关系必须人工确认后才写入。

证据：`ClaimLab`、`KnowledgeLabModal` 与 review-gate 测试。正向双工件生成由自动化覆盖。

## 8. 跨模态视频记忆

- 索引标题、作者、文稿、OCR、屏幕文字、视觉描述和主张。
- 支持作者、平台、日期、内容类型和课程过滤。
- 结果展示真实命中字段和可解释分数组成。
- 新工件、课程关联和重命名会实时更新；重启后从 sidecar 重建。

证据：`CrossModalMemory` 的搜索、过滤、长文覆盖和重建测试。

## 9. 学习与复习

- 从闪卡和自测题生成稳定的本地内容 ID。
- 本地 sidecar 保存尝试、正确率、把握度、间隔、到期时间、掌握和暂停状态。
- 提供当前视频复习与跨视频到期队列；错误答案可回到来源证据。
- 最早到期时间写入 Properties，Base 使用完整时间戳判断到期。

证据：`LearningProgressStore`、`LearningReviewModal`、稳定 ID 与调度测试。

## 10. 收件箱、Base 与可复现工件

- `obsidian://video-summary` 默认离线 `capture-only`，并按来源身份并发去重。
- 通用 URL 可以先收藏；外部协议处理本地文件要求媒体扩展校验和用户确认。URI 使用绝对
  路径做去重，bundled n8n 无法读取该主机路径，因此只允许离线收件；自动处理需使用可
  访问同一路径的 Worker，或先复制到 `docker/uploads/` 后用相对名称提交。
- 自动生成 Inbox、Processing、Ready、Error、Review 五个 Base 视图，只更新未被用户
  修改的受管 Base。
- 可复现清单保存并校验文稿、segments、claims、visual evidence、后端、模型、prompt、
  版本和处理深度。
- 无源重处理不会重新下载来源；使用当前后端/模型，不声明位级完全复现。
- Vault rename/delete 会同步工件、可复现清单、课程、捕获缓存和内存索引。

证据：`CaptureInbox`、`BasesGenerator`、`ReproducibilityManifest/Store` 与 API 出站测试。

## 自动验收

```text
npm test                 143/143 passed
npm run build            passed
npm run lint             passed
Prettier                 passed
git diff --check         passed
```

## 验收分层

| 层级                               | 状态         | 证据与边界                                                      |
| ---------------------------------- | ------------ | --------------------------------------------------------------- |
| 插件自动化                         | 通过         | 143/143；构建、Lint、格式和空白检查通过                         |
| Obsidian 离线 UI                   | 通过         | 重载、侧栏、详情六标签、分段陪读、证据、重点、复习、搜索和 Base |
| 外部 Worker                        | 仓库外未复验 | Worker 源码、fixture 与测试命令不在本仓库或本次 Release 中      |
| Claim Lab 正向生成                 | 自动化通过   | 双工件矩阵由自动化覆盖；离线 UI 验证安全门                      |
| 课程编译与索引                     | 自动化通过   | 顺序、增量、并发进度和自由正文保留已测；未导入真实列表          |
| YouTube / 本地媒体 / Bilibili 播放 | 待在线集成   | 离线验收只覆盖明确的播放器降级                                  |
| n8n 在线端到端                     | 未执行       | 不声称在线下载、ASR 或 AI 已成功                                |
| GitHub Release                     | 独立门禁     | 由发布工作流重新校验版本、测试、构建、安装包和校验和            |

## 公开数据边界

- 公开 n8n 工作流已移除私人用户画像，并有回归测试阻止其再次进入发布文件。
- 公开 n8n 工作流不含实例专属 ASR ID；无字幕与本地音频回退必须按公开合同显式配置。
- 仓库不跟踪 `data.json`、`history.json`、插件 `data/`、Cookie、凭据或真实 Vault 笔记。
- 离线 UI 使用合成隔离 fixture，并明确标记没有调用后端。
- 源码构建产物与安装运行文件已做哈希一致性核对；个人运行数据不属于发布资产。
