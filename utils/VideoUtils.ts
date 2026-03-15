import { TFile } from 'obsidian';

/**
 * 视频处理工具类
 * 包含通用的视频URL处理、状态解析等逻辑
 */
export class VideoUtils {
	/**
	 * 支持的视频平台
	 */
	private static readonly SUPPORTED_PLATFORMS = [
		'bilibili.com',
		'youtube.com',
		'youtu.be',
		'douyin.com',
		'tiktok.com'
	];

	/**
	 * 验证是否为有效的视频URL
	 */
	static isValidVideoUrl(url: string): boolean {
		return this.SUPPORTED_PLATFORMS.some(platform => url.includes(platform));
	}

	/**
	 * 从内容中提取视频URL
	 */
	static extractVideoUrl(content: string): string | null {
		// 从frontmatter中提取
		const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
		if (fmMatch) {
			const fmText = fmMatch[1];

			// 尝试匹配数组格式的link字段
			const arrayLinkMatch = fmText.match(/^link:\s*\n((?:\s*-\s*https?:\/\/[^\n]+\n?)+)/m);
			if (arrayLinkMatch) {
				const arrayContent = arrayLinkMatch[1];
				// 提取数组中的所有URL
				const urlMatches = arrayContent.match(/https?:\/\/[^\s\n]+/g);
				if (urlMatches) {
					for (const url of urlMatches) {
						if (this.isValidVideoUrl(url)) {
							return url;
						}
					}
				}
			}

			// 尝试匹配单行格式的link字段
			const linkMatch = fmText.match(/^link:\s*(.+)$/m);
			if (linkMatch) {
				const link = linkMatch[1].trim();
				if (this.isValidVideoUrl(link)) {
					return link;
				}
			}
		}

		// 从正文中提取
		const urlRegex = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g;
		const urls = content.match(urlRegex);
		if (urls) {
			for (const url of urls) {
				if (this.isValidVideoUrl(url)) {
					return url;
				}
			}
		}

		return null;
	}

	/**
	 * 从内容中提取处理状态
	 */
	static getProcessingStatus(content: string): string | null {
		const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
		if (fmMatch) {
			const fmText = fmMatch[1];
			// 按行分割，然后查找status行
			const lines = fmText.split('\n');
			for (const line of lines) {
				if (line.startsWith('status:')) {
					const status = line.substring(7).trim(); // 去掉'status: '（包括冒号和空格）
					// 如果status为空或只包含空格，返回'pending'
					if (!status || status === '') {
						return 'pending';
					}
					return status;
				}
			}
		}
		// 如果没有找到status字段，返回'pending'
		return 'pending';
	}

	/**
	 * 检查是否为视频笔记
	 * 如果status中有 '⛔️' 标志，则排除
	 */
	static isVideoNote(content: string): boolean {
		const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
		if (fmMatch) {
			const fmText = fmMatch[1];

			// 检查status字段是否为排除
			const statusMatch = fmText.match(/^status:\s*(.+)$/m);
			if (statusMatch) {
				const status = statusMatch[1].trim();
				const normalized = this.normalizeStatus(status);
				if (normalized === 'excluded') {
					return false;
				}
			}

			// 检查是否有视频相关字段
			const videoUrl = this.extractVideoUrl(content);
			const hasVideoUrl = !!videoUrl;
			const hasVideoMetadata = this.hasVideoMetadata(content);

			return hasVideoUrl || hasVideoMetadata;
		}

		// 如果没有frontmatter，检查正文中是否有视频链接
		const videoUrl = this.extractVideoUrl(content);
		return !!videoUrl;
	}

	/**
	 * 从内容中提取提供的文稿
	 */
	static extractProvidedTranscript(content: string): string | null {
		const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
		if (fmMatch) {
			const fmText = fmMatch[1];

			// 首先尝试匹配多行格式（支持 |, |-, > 等）
			// 多行文本块持续的条件：空行 或者 以缩进（至少一个空格/Tab）开头的行
			const transcriptMatch = fmText.match(/^provided_transcript:\s*(?:[|>][+-]?)?[ \t]*\n((?:^[ \t]*(?:\n|$)|^[ \t]+.*(?:\n|$))*)/m);

			if (transcriptMatch && transcriptMatch[1].trim()) {
				const rawBlock = transcriptMatch[1];
				const lines = rawBlock.split(/\r?\n/);

				// 寻找非空行的最小缩进
				let minIndent: number | null = null;
				for (const line of lines) {
					if (line.trim().length > 0) {
						const indentMatch = line.match(/^([ \t]+)/);
						if (indentMatch) {
							const indent = indentMatch[1].length;
							if (minIndent === null || indent < minIndent) {
								minIndent = indent;
							}
						}
					}
				}

				// 根据最小缩进进行剥离，保持原有的 Markdown 相对缩进（如列表）
				const strippedLines = lines.map(line => {
					if (line.trim().length === 0) return "";
					return minIndent !== null ? line.substring(minIndent) : line;
				});

				return strippedLines.join('\n').trim();
			}

			// 然后尝试匹配单行格式（不带|的），并排除单独的 |- 符号等
			const singleLineMatch = fmText.match(/^provided_transcript:\s*(.+)$/m);
			if (singleLineMatch) {
				const val = singleLineMatch[1].trim();
				// 防止单行格式把 multiline 的标记符号当做内容提取
				if (val !== '|' && val !== '|-' && val !== '|+' && val !== '>' && val !== '>-' && val !== '>+') {
					return val;
				}
			}
		}
		return null;
	}

	/**
	 * 从内容中提取本地文件名
	 */
	static extractLocalFileName(content: string): string | null {
		const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
		if (fmMatch) {
			const fmText = fmMatch[1];
			const fileNameMatch = fmText.match(/^local_file:\s*(.+)$/m);
			if (fileNameMatch) {
				return fileNameMatch[1].trim();
			}
		}
		return null;
	}

	/**
	 * 基于 frontmatter 判断是否为视频笔记（无需读取正文）
	 */
	static isVideoNoteFromFrontmatter(frontmatter: any): boolean {
		if (!frontmatter || typeof frontmatter !== 'object') return false;

		// 排除状态
		const status = String(frontmatter.status ?? '').trim();
		if (this.normalizeStatus(status) === 'excluded') return false;

		// 链接字段可能为字符串或数组
		const linkField = (frontmatter as any).link;
		if (Array.isArray(linkField)) {
			for (const l of linkField) {
				if (typeof l === 'string' && this.isValidVideoUrl(l)) return true;
			}
		} else if (typeof linkField === 'string') {
			if (this.isValidVideoUrl(linkField)) return true;
		}

		// 其他视频相关元数据
		if (typeof (frontmatter as any).provided_transcript === 'string' && (frontmatter as any).provided_transcript.trim()) return true;
		if (typeof (frontmatter as any).local_file === 'string' && (frontmatter as any).local_file.trim()) return true;
		if (typeof (frontmatter as any).video_transcript === 'string' && (frontmatter as any).video_transcript.trim()) return true;

		return false;
	}

	/**
	 * 基于 frontmatter 获取处理状态
	 */
	static getProcessingStatusFromFrontmatter(frontmatter: any): string | null {
		if (!frontmatter || typeof frontmatter !== 'object') return 'pending';
		const status = String(frontmatter.status ?? '').trim();
		return status || 'pending';
	}

	/**
	 * 检查内容是否包含视频元数据
	 */
	static hasVideoMetadata(content: string): boolean {
		// 检查视频链接
		if (this.extractVideoUrl(content)) {
			return true;
		}

		// 检查提供的文稿
		if (this.extractProvidedTranscript(content)) {
			return true;
		}

		// 检查本地文件
		if (this.extractLocalFileName(content)) {
			return true;
		}

		// 检查视频文稿（处理后的）
		const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
		if (fmMatch) {
			const fmText = fmMatch[1];
			if (fmText.match(/^video_transcript:/m)) {
				return true;
			}
		}

		return false;
	}

	/**
	 * 清理视频URL，去除多余参数
	 */
	static cleanVideoUrl(url: string): string {
		try {
			// 处理B站链接
			if (url.includes('bilibili.com')) {
				// 处理收藏夹链接
				if (url.includes('/list/watchlater')) {
					const bvidMatch = url.match(/bvid=([^&]+)/);
					if (bvidMatch) {
						return `https://www.bilibili.com/video/${bvidMatch[1]}`;
					}
				}

				// 处理普通B站链接，去除多余参数
				const cleanUrl = url.split('?')[0];
				return cleanUrl;
			}

			// 处理YouTube链接
			if (url.includes('youtube.com') || url.includes('youtu.be')) {
				// 提取视频ID
				let videoId = '';
				if (url.includes('youtube.com/watch')) {
					const match = url.match(/[?&]v=([^&]+)/);
					if (match) videoId = match[1];
				} else if (url.includes('youtu.be/')) {
					const match = url.match(/youtu\.be\/([^?&]+)/);
					if (match) videoId = match[1];
				}

				if (videoId) {
					return `https://www.youtube.com/watch?v=${videoId}`;
				}
			}

			// 其他平台保持原样
			return url;
		} catch (error) {
			console.error('清理视频URL时出错:', error);
			return url;
		}
	}

	/**
	 * 清理视频URL，但保留p参数（用于单个链接模式）
	 */
	static cleanVideoUrlKeepP(url: string): string {
		try {
			// 处理B站链接
			if (url.includes('bilibili.com')) {
				// 处理收藏夹链接
				if (url.includes('/list/watchlater')) {
					const bvidMatch = url.match(/bvid=([^&]+)/);
					if (bvidMatch) {
						return `https://www.bilibili.com/video/${bvidMatch[1]}`;
					}
				}

				// 提取基础URL和p参数
				const urlObj = new URL(url);
				const baseUrl = urlObj.origin + urlObj.pathname;
				const pParam = urlObj.searchParams.get('p');

				// 如果有p参数，保留它；否则返回基础URL
				if (pParam) {
					return `${baseUrl}?p=${pParam}`;
				}
				return baseUrl;
			}

			// 处理YouTube链接
			if (url.includes('youtube.com') || url.includes('youtu.be')) {
				// 提取视频ID
				let videoId = '';
				if (url.includes('youtube.com/watch')) {
					const match = url.match(/[?&]v=([^&]+)/);
					if (match) videoId = match[1];
				} else if (url.includes('youtu.be/')) {
					const match = url.match(/youtu\.be\/([^?&]+)/);
					if (match) videoId = match[1];
				}

				if (videoId) {
					const urlObj = new URL(url);
					const indexParam = urlObj.searchParams.get('index');
					if (indexParam) {
						return `https://www.youtube.com/watch?v=${videoId}&index=${indexParam}`;
					}
					return `https://www.youtube.com/watch?v=${videoId}`;
				}
			}

			// 其他平台保持原样
			return url;
		} catch (error) {
			console.error('清理视频URL时出错:', error);
			return url;
		}
	}

	/**
	 * 从B站URL中提取视频ID
	 */
	static extractBilibiliVideoId(url: string): string | null {
		// 匹配BV号
		const bvMatch = url.match(/BV[a-zA-Z0-9]+/);
		if (bvMatch) {
			return bvMatch[0];
		}

		// 匹配AV号
		const avMatch = url.match(/av(\d+)/);
		if (avMatch) {
			return `av${avMatch[1]}`;
		}

		return null;
	}

	/**
	 * 从URL中提取当前P数
	 */
	static extractCurrentPFromUrl(url: string): number | null {
		const pMatch = url.match(/[?&]p=(\d+)/);
		if (pMatch) {
			return parseInt(pMatch[1]);
		}
		return null;
	}

	/**
	 * 生成分P链接
	 */
	static generatePartUrl(originalUrl: string, videoId: string, partIndex: number): string {
		if (originalUrl.includes('bilibili.com')) {
			return `https://www.bilibili.com/video/${videoId}?p=${partIndex}`;
		}
		// 其他平台可以在这里添加
		return originalUrl;
	}

	/**
	 * 获取状态文本描述
	 */
	static getStatusText(status: string): string {
		// 兼容旧状态值并统一映射
		const normalized = this.normalizeStatus(status);
		switch (normalized) {
			case 'pending': return '待处理';
			case 'running': return '处理中';
			case 'success': return '已处理';
			case 'error': return '处理失败';
			case 'excluded': return '非视频笔记';
			default: return '已处理';
		}
	}

	/**
	 * 获取状态CSS类名
	 */
	static getStatusClass(status: string): string {
		const normalized = this.normalizeStatus(status);
		switch (normalized) {
			case 'pending': return 'pending';
			case 'running': return 'running';
			case 'success': return 'success';
			case 'error': return 'error';
			case 'excluded': return 'excluded';
			default: return 'success';
		}
	}

	static normalizeStatus(status: string): 'pending' | 'running' | 'success' | 'error' | 'excluded' | 'other' {
		const s = (status || '').trim();
		if (s === 'pending') return 'pending';
		if (s === 'running' || s === '⏳') return 'running';
		if (s === 'success' || s === '✅' || s === '▶️' || s === '❌') return 'success';
		if (s === 'error') return 'error';
		if (s === 'excluded' || s.includes('⛔')) return 'excluded';
		return 'other';
	}
} 