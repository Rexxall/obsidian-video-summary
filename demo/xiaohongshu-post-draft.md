# Xiaohongshu Post Draft

标题：

我把视频整理成 Obsidian 笔记的流程做成了插件

正文：

我平时会看很多课程、讲座和短视频资料，但手动整理笔记太慢，所以做了一个 Obsidian 插件：Video Summary。

它可以把视频链接、本地音频/视频，或者你已经粘贴好的文稿，发送到自己的 n8n 工作流，然后把结果写回 Obsidian 笔记。

这次公开前我重点优化了新手安装：

- 设置页内置安装检查
- 一键测试 webhook 连接
- 显示推荐 workflow 版本和 path
- 提醒本地文件要放进 `docker/uploads`
- README 里写了 Docker、n8n、cookies 和常见报错

适合：

- 看课程视频后整理结构化笔记
- 把会议录音变成纪要
- 把讲座内容归档到 Obsidian
- 给自己的知识库做视频输入入口

需要注意：

- 需要自己跑 n8n
- Docker 版本更推荐，因为里面带 `yt-dlp` 和 `ffmpeg`
- 抖音、TikTok、小红书这类平台经常需要 cookies
- 本地音频/视频和已粘贴文稿最稳定

GitHub：

https://github.com/Rexxall/obsidian-video-summary-plugin

标签：

#Obsidian #Obsidian插件 #n8n #知识管理 #视频笔记 #自动化工作流
