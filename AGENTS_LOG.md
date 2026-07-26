---
agent: claude
agent_updated: 2026-07-03
---

- 2026-07-26 claude - v2.3.0 侧栏重构。新增 `core/`（JobStore / JobService / NoteIndex / NoteFactory /
  InputParser）与 `views/panels/`（ActionBar / JobsPanel / LibraryPanel / DetailPanel），旧的 3482 行
  `views/VideoSummaryView.ts` 缩到约 190 行只做外壳。要点：(1) 任务挂在插件上，关掉侧栏不丢；
  (2) 命令与批量处理统一走队列，历史只由 JobService 写一次（main.ts 批量循环里的重复 addToHistory 已删）；
  (3) `processVideo` 新增可选 `onProgress`，只有 codex-worker 轮询能上报阶段，n8n 界面如实显示"不报阶段"；
  (4) 笔记库改索引 + metadataCache 增量事件，不再每次渲染全库扫；(5) 删除孤儿文件 `VideoSummaryModal.ts`
  （无人 import）；(6) styles.css 剪掉 277 条无引用规则，硬编码色与 !important 清零。
  未验证项：没有在真实 Obsidian 里跑过（无法在此环境启动），只做了 tsc + eslint + esbuild。
- 2026-06-09 codex - switched `data.json` activeBackend to `codex-worker` so the Obsidian main entry routes through the local dashboard worker.
- 2026-07-03 claude - v2.2.0: (1) history/webhookHistory 拆分到插件目录 `history.json`（data.json 不再膨胀，历史限容可配，默认 300）；(2) 处理前后端 preflight 自检（60s 缓存，失败时探测另一后端并提议切换）；(3) 设置页新增 Cookies 管理（打开目录 + 检测 *_cookies.txt 新鲜度）；(4) 注册 `obsidian://video-summary` 协议，浏览器扩展可一键"建笔记+触发处理"（capture-extension 同步加 `process-via-plugin` 模式，v0.2.0）；(5) 短链自动展开（b23.tv / v.douyin.com / xhslink 等，fail-open）；(6) VideoUtils 修复带引号 YAML link 提取。注意：`data.json` 的 activeBackend 现为 `n8n`，与 2026-06-09 的记录不一致，待 Rex 确认 codex-worker 状态。
