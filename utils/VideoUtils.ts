import { SUPPORTED_PLATFORMS } from '../constants';
import { normalizeStatus as sharedNormalizeStatus, canonicalizeVideoUrl } from '../shared';

const VIDEO_STATUS_FIELDS = [
  'video_summary_status',
  'video_processing_status',
  'video_status',
] as const;
const YAML_BLOCK_MARKERS = new Set(['|', '|-', '|+', '>', '>-', '>+']);
const EMPTY_OUTPUT_VALUES = new Set([
  '',
  'null',
  'undefined',
  'n/a',
  'none',
  '（无）',
  '暂无',
  '待生成',
]);

/**
 * 视频处理工具类
 * 包含通用的视频URL处理、状态解析等逻辑
 */
export class VideoUtils {
  /**
   * 验证是否为有效的视频URL
   * 平台列表统一来自 constants.ts（单一数据源），避免检测与处理逻辑漂移
   * （此前这里只有 5 个平台，而 constants 里有 14 个，导致短链/小红书识别不一致）。
   */
  static isValidVideoUrl(url: string): boolean {
    return SUPPORTED_PLATFORMS.some((platform) => url.includes(platform));
  }

  /**
   * 从内容中提取视频URL
   */
  static extractVideoUrl(content: string): string | null {
    // 从frontmatter中提取
    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (fmMatch) {
      const fmText = fmMatch[1];

      // 尝试匹配数组格式的link字段
      const arrayLinkMatch = fmText.match(/^link:\s*\n((?:\s*-\s*https?:\/\/[^\n]+\n?)+)/m);
      if (arrayLinkMatch) {
        const arrayContent = arrayLinkMatch[1];
        // 提取数组中的所有URL
        const urlMatches = arrayContent.match(/https?:\/\/[^\s\n]+/g);
        if (urlMatches) {
          for (const rawUrl of urlMatches) {
            const url = this.trimExtractedUrl(rawUrl);
            if (this.isValidVideoUrl(url)) {
              return url;
            }
          }
        }
      }

      // 尝试匹配单行格式的link字段
      const linkMatch = fmText.match(/^link:\s*(.+)$/m);
      if (linkMatch) {
        // 浏览器扩展写入的 link 可能是带引号的 YAML 标量（link: "https://..."），先剥掉引号
        const link = this.stripYamlQuotes(linkMatch[1].trim());
        if (this.isValidVideoUrl(link)) {
          return link;
        }
      }
    }

    // 从正文中提取
    const urlRegex = /https?:\/\/[^\s<>"{}|\\^`[\]]+/g;
    const urls = content.match(urlRegex);
    if (urls) {
      for (const rawUrl of urls) {
        const url = this.trimExtractedUrl(rawUrl);
        if (this.isValidVideoUrl(url)) {
          return url;
        }
      }
    }

    return null;
  }

  /**
   * 提取正文中的所有视频链接，供旧笔记兜底索引判断是否是多链接聚合页。
   * 同一视频的时间戳链接会折叠，但 B 站分 P 会保留为不同链接。
   */
  static extractVideoUrls(content: string): string[] {
    const urlRegex = /https?:\/\/[^\s<>"{}|\\^`[\]]+/g;
    const urls = content.match(urlRegex) ?? [];
    const unique = new Map<string, string>();
    for (const rawUrl of urls) {
      const url = this.trimExtractedUrl(rawUrl);
      if (!this.isValidVideoUrl(url)) continue;
      const canonical = this.cleanVideoUrlKeepP(url);
      if (!unique.has(canonical)) unique.set(canonical, url);
    }
    return Array.from(unique.values());
  }

  private static trimExtractedUrl(value: string): string {
    return value.replace(/[),.;:!?，。；：！？）】》]+$/g, '');
  }

  /**
   * 剥掉 YAML 标量外层的成对引号（link: "https://..." / link: 'https://...'）
   */
  private static stripYamlQuotes(value: string): string {
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      return value.slice(1, -1).trim();
    }
    return value;
  }

  /**
   * 从内容中提取处理状态
   */
  static getProcessingStatus(content: string): string | null {
    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fmMatch) return 'pending';

    const fmText = fmMatch[1];
    const hasGeneratedOutput =
      this.hasMeaningfulYamlField(fmText, 'summary') ||
      this.hasMeaningfulYamlField(fmText, 'video_transcript');
    return this.resolveProcessingStatus(
      (field) => this.readYamlScalar(fmText, field),
      hasGeneratedOutput,
    );
  }

  /**
   * 检查是否为视频笔记
   * 如果status中有 '⛔️' 标志，则排除
   */
  static isVideoNote(content: string): boolean {
    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (fmMatch) {
      const fmText = fmMatch[1];

      if (this.isExplicitlyNonVideoFromRawFrontmatter(fmText)) return false;
      if (this.hasExplicitVideoMarkerFromRawFrontmatter(fmText)) return true;

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
      const transcriptMatch = fmText.match(
        /^provided_transcript:\s*(?:[|>][+-]?)?[ \t]*\n((?:^[ \t]*(?:\n|$)|^[ \t]+.*(?:\n|$))*)/m,
      );

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
        const strippedLines = lines.map((line) => {
          if (line.trim().length === 0) return '';
          return minIndent !== null ? line.substring(minIndent) : line;
        });

        return strippedLines.join('\n').trim();
      }

      // 然后尝试匹配单行格式（不带|的），并排除单独的 |- 符号等
      const singleLineMatch = fmText.match(/^provided_transcript:\s*(.+)$/m);
      if (singleLineMatch) {
        const val = singleLineMatch[1].trim();
        // 防止单行格式把 multiline 的标记符号当做内容提取
        if (
          val !== '|' &&
          val !== '|-' &&
          val !== '|+' &&
          val !== '>' &&
          val !== '>-' &&
          val !== '>+'
        ) {
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
      const fileNameMatch = fmText.match(/^(local_file|localFileName|localFile):\s*(.+)$/m);
      if (fileNameMatch) {
        return fileNameMatch[2].trim();
      }
    }
    return null;
  }

  /**
   * 基于 frontmatter 判断是否为视频笔记（无需读取正文）
   */
  static isVideoNoteFromFrontmatter(frontmatter: any): boolean {
    if (!frontmatter || typeof frontmatter !== 'object') return false;

    if (this.isExplicitlyNonVideoFromFrontmatter(frontmatter)) return false;
    if (this.hasExplicitVideoMarker(frontmatter)) return true;

    // 链接字段可能为字符串或数组
    const linkField = (frontmatter as any).link;
    if (Array.isArray(linkField)) {
      const videoLinks = new Set<string>();
      for (const l of linkField) {
        if (typeof l === 'string' && this.isValidVideoUrl(l)) {
          videoLinks.add(this.cleanVideoUrlKeepP(l));
        }
      }
      // 多个不同视频的 link 数组更像聚合页；若同时有文稿/产物，下面仍会纳入。
      if (videoLinks.size === 1) return true;
    } else if (typeof linkField === 'string') {
      if (this.isValidVideoUrl(linkField)) return true;
    }

    // 其他视频相关元数据
    if (
      typeof (frontmatter as any).provided_transcript === 'string' &&
      (frontmatter as any).provided_transcript.trim()
    )
      return true;
    if (
      typeof (
        (frontmatter as any).local_file ??
        (frontmatter as any).localFileName ??
        (frontmatter as any).localFile
      ) === 'string' &&
      (
        (frontmatter as any).local_file ??
        (frontmatter as any).localFileName ??
        (frontmatter as any).localFile
      ).trim()
    )
      return true;
    if (
      typeof (frontmatter as any).video_transcript === 'string' &&
      this.isMeaningfulOutputValue((frontmatter as any).video_transcript)
    )
      return true;
    if (
      typeof (frontmatter as any).video_title === 'string' &&
      (frontmatter as any).video_title.trim() &&
      this.isMeaningfulOutputValue((frontmatter as any).summary)
    )
      return true;

    return false;
  }

  /**
   * 明确声明为非视频的来源优先于链接/正文兜底，避免图片和文章采集笔记混入媒体库。
   */
  static isExplicitlyNonVideoFromFrontmatter(frontmatter: any): boolean {
    if (!frontmatter || typeof frontmatter !== 'object') return false;

    const pluginStatus = this.readPluginStatusFromFrontmatter(frontmatter);
    if (pluginStatus.present && pluginStatus.normalized === 'excluded') return true;

    if (!pluginStatus.present) {
      const genericStatus = this.normalizeStatus(String(frontmatter.status ?? '').trim());
      if (genericStatus === 'excluded') return true;
    }

    const marker = (frontmatter as any).video_summary;
    if (
      marker === false ||
      String(marker ?? '')
        .trim()
        .toLowerCase() === 'false'
    )
      return true;

    const sourceType = String((frontmatter as any).source_type ?? '')
      .trim()
      .toLowerCase();
    if (
      ['image', 'images', 'article', 'text', 'note', 'document', 'pdf', 'webpage'].includes(
        sourceType,
      )
    ) {
      return true;
    }

    const transcriptStatus = String((frontmatter as any).video_transcript_status ?? '')
      .trim()
      .toLowerCase();
    return transcriptStatus === 'not-applicable' || transcriptStatus === 'not_applicable';
  }

  /**
   * 基于 frontmatter 获取处理状态
   */
  static getProcessingStatusFromFrontmatter(frontmatter: any): string | null {
    if (!frontmatter || typeof frontmatter !== 'object') return 'pending';
    const hasGeneratedOutput =
      this.isMeaningfulOutputValue((frontmatter as any).summary) ||
      this.isMeaningfulOutputValue((frontmatter as any).video_transcript);
    return this.resolveProcessingStatus((field) => {
      if (!Object.prototype.hasOwnProperty.call(frontmatter, field)) {
        return { present: false, value: '' };
      }
      return { present: true, value: String((frontmatter as any)[field] ?? '').trim() };
    }, hasGeneratedOutput);
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
    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (fmMatch) {
      const fmText = fmMatch[1];
      if (this.hasMeaningfulYamlField(fmText, 'video_transcript')) {
        return true;
      }
    }

    return false;
  }

  private static resolveProcessingStatus(
    readField: (field: string) => { present: boolean; value: string },
    hasGeneratedOutput: boolean,
  ): 'pending' | 'running' | 'success' | 'error' | 'excluded' {
    for (const field of VIDEO_STATUS_FIELDS) {
      const dedicated = readField(field);
      if (!dedicated.present) continue;
      const normalized = this.normalizeStatus(dedicated.value);
      if (normalized !== 'other') return normalized;
      // 专用字段存在时不再借用通用 status；未知/空值只能由真实产物推断。
      return hasGeneratedOutput ? 'success' : 'pending';
    }

    const generic = readField('status');
    if (generic.present) {
      const normalized = this.normalizeStatus(generic.value);
      if (normalized !== 'other') return normalized;
    }

    return hasGeneratedOutput ? 'success' : 'pending';
  }

  private static readPluginStatusFromFrontmatter(frontmatter: any): {
    present: boolean;
    normalized: ReturnType<typeof VideoUtils.normalizeStatus>;
  } {
    for (const field of VIDEO_STATUS_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(frontmatter, field)) continue;
      return {
        present: true,
        normalized: this.normalizeStatus(String((frontmatter as any)[field] ?? '').trim()),
      };
    }
    return { present: false, normalized: 'other' };
  }

  private static hasExplicitVideoMarker(frontmatter: any): boolean {
    const pluginStatus = this.readPluginStatusFromFrontmatter(frontmatter);
    if (pluginStatus.present) return true;

    const markerValues = [
      (frontmatter as any).video_summary,
      (frontmatter as any).video_summary_plugin,
      (frontmatter as any).video_summary_managed,
    ];
    if (
      markerValues.some(
        (value) =>
          value === true ||
          ['true', 'yes', 'managed', 'video'].includes(
            String(value ?? '')
              .trim()
              .toLowerCase(),
          ),
      )
    ) {
      return true;
    }

    const source = String((frontmatter as any).source ?? '')
      .trim()
      .toLowerCase();
    const sourceType = String((frontmatter as any).source_type ?? '')
      .trim()
      .toLowerCase();
    return (
      ['video-summary', 'video_summary', 'obsidian-video-summary'].includes(source) ||
      ['video', 'audio', 'media'].includes(sourceType)
    );
  }

  private static hasExplicitVideoMarkerFromRawFrontmatter(fmText: string): boolean {
    if (
      VIDEO_STATUS_FIELDS.some((field) => {
        return this.readYamlScalar(fmText, field).present;
      })
    ) {
      return true;
    }

    for (const field of ['video_summary', 'video_summary_plugin', 'video_summary_managed']) {
      const marker = this.readYamlScalar(fmText, field);
      if (
        marker.present &&
        ['true', 'yes', 'managed', 'video'].includes(marker.value.toLowerCase())
      ) {
        return true;
      }
    }

    const source = this.readYamlScalar(fmText, 'source');
    const sourceType = this.readYamlScalar(fmText, 'source_type');
    return (
      (source.present &&
        ['video-summary', 'video_summary', 'obsidian-video-summary'].includes(
          source.value.toLowerCase(),
        )) ||
      (sourceType.present && ['video', 'audio', 'media'].includes(sourceType.value.toLowerCase()))
    );
  }

  private static isExplicitlyNonVideoFromRawFrontmatter(fmText: string): boolean {
    const pluginStatus = VIDEO_STATUS_FIELDS.map((field) =>
      this.readYamlScalar(fmText, field),
    ).find((value) => value.present);
    if (pluginStatus && this.normalizeStatus(pluginStatus.value) === 'excluded') return true;

    if (!pluginStatus) {
      const status = this.readYamlScalar(fmText, 'status');
      if (status.present && this.normalizeStatus(status.value) === 'excluded') return true;
    }

    const marker = this.readYamlScalar(fmText, 'video_summary');
    if (marker.present && marker.value.toLowerCase() === 'false') return true;

    const sourceType = this.readYamlScalar(fmText, 'source_type');
    if (
      sourceType.present &&
      ['image', 'images', 'article', 'text', 'note', 'document', 'pdf', 'webpage'].includes(
        sourceType.value.toLowerCase(),
      )
    ) {
      return true;
    }

    const transcriptStatus = this.readYamlScalar(fmText, 'video_transcript_status');
    if (!transcriptStatus.present) return false;
    const normalized = transcriptStatus.value.toLowerCase();
    return normalized === 'not-applicable' || normalized === 'not_applicable';
  }

  private static readYamlScalar(
    fmText: string,
    field: string,
  ): { present: boolean; value: string } {
    const escapedField = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = fmText.match(new RegExp(`^${escapedField}:\\s*(.*)$`, 'm'));
    if (!match) return { present: false, value: '' };
    return { present: true, value: this.stripYamlQuotes(match[1].trim()) };
  }

  private static hasMeaningfulYamlField(fmText: string, field: string): boolean {
    const escapedField = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = fmText.match(new RegExp(`^${escapedField}:\\s*(.*)$`, 'm'));
    if (!match) return false;

    const inlineValue = this.stripYamlQuotes(match[1].trim());
    if (!YAML_BLOCK_MARKERS.has(inlineValue)) {
      return this.isMeaningfulOutputValue(inlineValue);
    }

    const fieldLineEnd = (match.index ?? 0) + match[0].length;
    const followingLines = fmText
      .slice(fieldLineEnd)
      .replace(/^\r?\n/, '')
      .split(/\r?\n/);
    const blockLines: string[] = [];
    for (const line of followingLines) {
      if (!line.trim() || /^[ \t]+/.test(line)) {
        blockLines.push(line);
        continue;
      }
      break;
    }
    return this.isMeaningfulOutputValue(blockLines.join('\n'));
  }

  private static isMeaningfulOutputValue(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    const normalized = value.trim();
    if (EMPTY_OUTPUT_VALUES.has(normalized.toLowerCase())) return false;
    return !/^<!--[\s\S]*-->$/.test(normalized);
  }

  /**
   * 清理视频URL，去除多余参数
   */
  static cleanVideoUrl(url: string): string {
    // 统一委托给共享单一来源（默认丢弃查询参数，等价于旧实现）
    return canonicalizeVideoUrl(url);
  }

  /**
   * 清理视频URL，但保留p参数（用于单个链接模式）
   */
  static cleanVideoUrlKeepP(url: string): string {
    // 保留 B 站分 P (?p=) / YouTube index 参数，统一委托给共享单一来源
    return canonicalizeVideoUrl(url, { keepP: true });
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
      case 'pending':
        return '待处理';
      case 'running':
        return '处理中';
      case 'success':
        return '已处理';
      case 'error':
        return '处理失败';
      case 'excluded':
        return '非视频笔记';
      default:
        return '已处理';
    }
  }

  /**
   * 获取状态CSS类名
   */
  static getStatusClass(status: string): string {
    const normalized = this.normalizeStatus(status);
    switch (normalized) {
      case 'pending':
        return 'pending';
      case 'running':
        return 'running';
      case 'success':
        return 'success';
      case 'error':
        return 'error';
      case 'excluded':
        return 'excluded';
      default:
        return 'success';
    }
  }

  static normalizeStatus(
    status: string,
  ): 'pending' | 'running' | 'success' | 'error' | 'excluded' | 'other' {
    // 统一委托给共享单一来源（含 ❌->error 的修复）
    return sharedNormalizeStatus(status);
  }
}
