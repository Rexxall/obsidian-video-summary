export interface PlaylistItem {
	bvid: string;
	title: string;
	author: string;
	duration?: string;
	url: string;
}

export interface PlaylistInfo {
	title: string;
	description?: string;
	itemCount: number;
	items: PlaylistItem[];
}

export class PlaylistProcessor {
	/**
	 * 统一的带 CORS 回退的 JSON 获取
	 */
	private static async fetchJsonWithCors(url: string): Promise<any> {
		// 尝试直接请求
		try {
			const res = await fetch(url, { headers: { Referer: 'https://www.bilibili.com/' } });
			if (res.ok) {
				const ct = res.headers.get('content-type') || '';
				if (ct.includes('application/json')) return await res.json();
				// 有些代理返回 text/json
				const txt = await res.text();
				return JSON.parse(txt);
			}
		} catch (_) {}

		// CORS 回退：使用 r.jina.ai 代理（仅返回文本，需要手动 JSON.parse）
		try {
			const proxyUrl = `https://r.jina.ai/http://${url.replace(/^https?:\/\//, '')}`;
			const proxied = await fetch(proxyUrl, { headers: { Referer: 'https://www.bilibili.com/' } });
			if (!proxied.ok) throw new Error(`代理请求失败: HTTP ${proxied.status}`);
			const body = await proxied.text();
			return JSON.parse(body);
		} catch (e) {
			throw e;
		}
	}
	/**
	 * 解析B站链接，判断是否为播放列表或收藏夹
	 */
	static isPlaylistUrl(url: string): boolean {
		const patterns = [
			/playlist\?sid=\d+/,
			/medialist\/play\/\d+/,
			/space\.bilibili\.com\/\d+\/channel\/collectiondetail\?sid=\d+/, 
			/favlist\?fid=\d+/,
			/space\.bilibili\.com\/\d+\/favlist\?fid=\d+/,
			/bilibili\.com\/.*[?&](sid|fid|media_id)=\d+/
		];
		return patterns.some(pattern => pattern.test(url));
	}

	/**
	 * 从播放列表或收藏夹URL中提取所有BV号
	 */
	static async extractBvIds(url: string): Promise<PlaylistInfo> {
		try {
			// 解析URL类型
			const urlInfo = this.parseUrl(url);
			if (urlInfo.type === 'favlist') {
				return await this.extractFavlist(urlInfo.id, urlInfo.idParam === 'fid' ? 'fid' : 'media_id');
			}
			if (urlInfo.type === 'playlist') {
				return await this.extractPlaylist(urlInfo.id, urlInfo.idParam === 'sid' ? 'sid' : 'media_id');
			}
			throw new Error('不支持的URL类型');
		} catch (error) {
			throw new Error(`解析播放列表失败: ${error.message}`);
		}
	}

	/**
	 * 解析URL类型和ID
	 */
	private static parseUrl(url: string): { type: 'favlist' | 'playlist'; id: string; idParam: 'fid' | 'sid' | 'media_id' } {
		// 收藏夹链接 - 支持多种格式
		const favlistMatch = url.match(/favlist\?fid=(\d+)/);
		if (favlistMatch) {
			return { type: 'favlist', id: favlistMatch[1], idParam: 'fid' };
		}

		// 播放列表链接 - 支持多种格式
		const playlistMatch = url.match(/playlist\?sid=(\d+)/);
		if (playlistMatch) {
			return { type: 'playlist', id: playlistMatch[1], idParam: 'sid' };
		}

		// 空间收藏夹链接
		const spaceFavlistMatch = url.match(/space\.bilibili\.com\/\d+\/favlist\?fid=(\d+)/);
		if (spaceFavlistMatch) {
			return { type: 'favlist', id: spaceFavlistMatch[1], idParam: 'fid' };
		}

		// 空间播放列表链接
		const spacePlaylistMatch = url.match(/space\.bilibili\.com\/\d+\/channel\/collectiondetail\?sid=(\d+)/);
		if (spacePlaylistMatch) {
			return { type: 'playlist', id: spacePlaylistMatch[1], idParam: 'sid' };
		}

		// 根据Python参考，支持medialist格式
		const medialistMatch = url.match(/medialist\/play\/(\d+)/);
		if (medialistMatch) {
			return { type: 'playlist', id: medialistMatch[1], idParam: 'sid' };
		}

		// 带有 media_id 参数的链接（可能是播放列表或收藏夹）
		const mediaIdMatch = url.match(/[?&]media_id=(\d+)/);
		if (mediaIdMatch) {
			// 如果URL中包含 "fav" 关键词，归为收藏夹；否则视为播放列表
			const looksLikeFav = /fav/i.test(url);
			return { type: looksLikeFav ? 'favlist' : 'playlist', id: mediaIdMatch[1], idParam: 'media_id' };
		}

		throw new Error('无法解析URL类型，请检查链接格式');
	}

	/**
	 * 提取收藏夹内容
	 */
	private static async extractFavlist(id: string, idParam: 'fid' | 'media_id' = 'media_id'): Promise<PlaylistInfo> {
		try {
			// 首先获取收藏夹基本信息
			const infoParam = idParam === 'fid' ? `fid=${id}` : `media_id=${id}`;
			const infoApiUrl = `https://api.bilibili.com/x/v3/fav/folder/info?${infoParam}`;
			const infoData = await this.fetchJsonWithCors(infoApiUrl);
			if (infoData.code !== 0) {
				throw new Error(`获取收藏夹信息API错误: ${infoData.message}`);
			}

			const collectionName = infoData.data.title;

			// 获取收藏夹中的视频列表
			const listParam = idParam === 'fid' ? `fid=${id}` : `media_id=${id}`;
			const listApiUrl = `https://api.bilibili.com/x/v3/fav/resource/list?${listParam}&pn=1&ps=1000&order=mtime&type=0&tid=0`;
			const listData = await this.fetchJsonWithCors(listApiUrl);
			if (listData.code !== 0) {
				throw new Error(`获取视频列表API错误: ${listData.message}`);
			}

			const medias = listData.data.medias || [];

			const items: PlaylistItem[] = medias.map((media: any) => ({
				bvid: media.bvid,
				title: media.title,
				author: media.author.name,
				duration: this.formatDuration(media.duration),
				url: `https://www.bilibili.com/video/${media.bvid}`
			}));

			return {
				title: collectionName,
				description: infoData.data.intro || '',
				itemCount: medias.length,
				items
			};

		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			console.error('收藏夹API请求失败:', reason);
			throw new Error(`解析收藏夹失败: ${reason}`);
		}
	}

	/**
	 * 提取播放列表内容
	 */
	private static async extractPlaylist(id: string, idParam: 'sid' | 'media_id' = 'sid'): Promise<PlaylistInfo> {
		try {
			// 首先获取播放列表基本信息
			const infoParam = idParam === 'sid' ? `sid=${id}` : `media_id=${id}`;
			// 新接口对 sid/media_id 兼容
			const infoApiUrl = `https://api.bilibili.com/x/v1/medialist/info?${infoParam}`;
			const infoData = await this.fetchJsonWithCors(infoApiUrl);
			if (infoData.code !== 0) {
				throw new Error(`获取播放列表信息API错误: ${infoData.message}`);
			}

			const collectionName = infoData.data.title;

			// 根据参考，使用正确的API获取视频列表（biz_id 为 sid 或 media_id 均可）
			const listApiUrl = `https://api.bilibili.com/x/v1/medialist/resource/list?type=3&biz_id=${id}&offset_index=0&from=web&first_page=true&ps=1000`;
			const listData = await this.fetchJsonWithCors(listApiUrl);
			if (listData.code !== 0) {
				throw new Error(`获取视频列表API错误: ${listData.message}`);
			}

			const videoList = listData.data.mediaList || [];

			const items: PlaylistItem[] = videoList.map((video: any) => ({
				bvid: video.bvid,
				title: video.title,
				author: video.owner.name,
				duration: this.formatDuration(video.duration),
				url: video.short_link || `https://www.bilibili.com/video/${video.bvid}`
			}));

			return {
				title: collectionName,
				description: infoData.data.intro || '',
				itemCount: videoList.length,
				items
			};

		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			console.error('播放列表API请求失败:', reason);
			throw new Error(`解析播放列表失败: ${reason}`);
		}
	}

	/**
	 * 格式化时长
	 */
	private static formatDuration(seconds: number): string {
		const hours = Math.floor(seconds / 3600);
		const minutes = Math.floor((seconds % 3600) / 60);
		const secs = seconds % 60;

		if (hours > 0) {
			return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
		} else {
			return `${minutes}:${secs.toString().padStart(2, '0')}`;
		}
	}

	/**
	 * 验证BV号格式
	 */
	static isValidBvid(bvid: string): boolean {
		return /^BV[a-zA-Z0-9]{10}$/.test(bvid);
	}

	/**
	 * 从文本中提取BV号
	 */
	static extractBvIdsFromText(text: string): string[] {
		const bvidPattern = /BV[a-zA-Z0-9]{10}/g;
		const matches = text.match(bvidPattern);
		return matches ? [...new Set(matches)] : [];
	}

	/**
	 * 生成视频URL
	 */
	static generateVideoUrl(bvid: string): string {
		return `https://www.bilibili.com/video/${bvid}`;
	}
} 