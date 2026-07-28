// agent: claude (2026-07-26)
import { Menu, setIcon } from 'obsidian';

export interface MenuItemSpec {
  title: string;
  icon?: string;
  disabled?: boolean;
  onClick: () => void;
}

/** 图标按钮，统一走 lucide，不再用 emoji 当图标 */
export function iconButton(
  parent: HTMLElement,
  icon: string,
  label: string,
  onClick: (event: MouseEvent) => void,
  extraCls?: string,
): HTMLButtonElement {
  const button = parent.createEl('button', {
    cls: `vs-icon-btn${extraCls ? ` ${extraCls}` : ''}`,
    attr: { type: 'button', 'aria-label': label, title: label },
  });
  setIcon(button, icon);
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick(event);
  });
  return button;
}

/** 文本按钮（次要操作） */
export function textButton(
  parent: HTMLElement,
  label: string,
  onClick: () => void,
  extraCls?: string,
): HTMLButtonElement {
  const button = parent.createEl('button', {
    text: label,
    cls: `vs-text-btn${extraCls ? ` ${extraCls}` : ''}`,
    attr: { type: 'button' },
  });
  button.addEventListener('click', (event) => {
    event.preventDefault();
    onClick();
  });
  return button;
}

/** 配置 chip：一行显示当前值，点开是菜单，省掉一排 select */
export function configChip(
  parent: HTMLElement,
  label: string,
  value: string,
  items: MenuItemSpec[],
): HTMLElement {
  const chip = parent.createEl('button', {
    cls: 'vs-chip',
    attr: { type: 'button', 'aria-label': label, title: `${label}：${value}` },
  });
  chip.createSpan({ text: value, cls: 'vs-chip-value' });
  const caret = chip.createSpan({ cls: 'vs-chip-caret' });
  setIcon(caret, 'chevron-down');
  chip.addEventListener('click', (event) => {
    event.preventDefault();
    showMenu(event, items);
  });
  return chip;
}

export function showMenu(event: MouseEvent, items: MenuItemSpec[]) {
  const menu = new Menu();
  items.forEach((spec) => {
    menu.addItem((item) => {
      item.setTitle(spec.title);
      if (spec.icon) item.setIcon(spec.icon);
      if (spec.disabled) item.setDisabled(true);
      item.onClick(() => spec.onClick());
    });
  });
  menu.showAtMouseEvent(event);
}

/** 状态点 + 文案 */
export function statusMeta(status: string): { label: string; cls: string } {
  switch (status) {
    case 'success':
      return { label: '已完成', cls: 'is-success' };
    case 'running':
      return { label: '处理中', cls: 'is-running' };
    case 'interrupted':
      return { label: '已中断', cls: 'is-interrupted' };
    case 'error':
      return { label: '失败', cls: 'is-error' };
    case 'review':
      return { label: '待确认', cls: 'is-review' };
    case 'cancelled':
      return { label: '已取消', cls: 'is-muted' };
    case 'queued':
      return { label: '排队中', cls: 'is-queued' };
    default:
      return { label: '待处理', cls: 'is-pending' };
  }
}

/** 状态胶囊：彩字 + 同色淡底。可点击时（例如失败行的"重试"）传 onClick */
export function statusPill(
  parent: HTMLElement,
  status: string,
  options: { label?: string; onClick?: () => void; title?: string } = {},
): HTMLElement {
  const meta = statusMeta(status);
  const cls = `vs-pill ${meta.cls}${options.onClick ? ' is-clickable' : ''}`;
  const pill = options.onClick
    ? parent.createEl('button', {
        text: options.label ?? meta.label,
        cls,
        attr: { type: 'button', title: options.title ?? options.label ?? meta.label },
      })
    : parent.createSpan({ text: options.label ?? meta.label, cls });
  if (options.onClick) {
    pill.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      options.onClick?.();
    });
  }
  return pill;
}

/** 分段控件（tab / 模式切换共用） */
export function segmented<T extends string>(
  parent: HTMLElement,
  items: Array<{ value: T; label: string; count?: string; icon?: string }>,
  active: T,
  onSelect: (value: T) => void,
): HTMLElement {
  const row = parent.createDiv({ cls: 'vs-seg', attr: { role: 'tablist' } });
  items.forEach((item) => {
    const seg = row.createEl('button', {
      cls: `vs-seg-item${item.value === active ? ' is-active' : ''}`,
      attr: {
        type: 'button',
        role: 'tab',
        'aria-selected': item.value === active ? 'true' : 'false',
      },
    });
    if (item.icon) {
      const icon = seg.createSpan({ cls: 'vs-seg-icon' });
      setIcon(icon, item.icon);
    }
    seg.createSpan({ text: item.label });
    if (item.count) seg.createSpan({ text: item.count, cls: 'vs-seg-count' });
    seg.addEventListener('click', (event) => {
      event.preventDefault();
      if (item.value !== active) onSelect(item.value);
    });
  });
  return row;
}

export interface ThumbOptions {
  cover?: string;
  platform?: string;
  duration?: string;
  /** sm = 44×26 列表行用；lg = 76×44 任务卡用 */
  size?: 'sm' | 'lg';
}

/**
 * 视频缩略图：有封面用封面，没有就用斜纹占位；左缘一道平台色条，右下角时长。
 * 封面来源是笔记 frontmatter 的 cover/image，拿不到很正常，不当错误处理。
 */
export function thumbnail(parent: HTMLElement, options: ThumbOptions = {}): HTMLElement {
  const thumb = parent.createDiv({
    cls: `vs-thumb${options.size === 'lg' ? ' is-lg' : ''} ${platformClass(options.platform)}`,
  });

  // 封面缺失或加载失败时，保留一个低对比的平台占位。它完全在本地生成，
  // 不会为了填满列表而额外请求第三方元数据，也不会伪装成真实视频截图。
  const placeholder = thumb.createSpan({
    cls: 'vs-thumb-placeholder',
    attr: { 'aria-hidden': 'true' },
  });
  setIcon(placeholder, platformIcon(options.platform));

  if (options.cover) {
    const img = thumb.createEl('img', {
      cls: 'vs-thumb-img',
      attr: {
        src: options.cover,
        alt: '',
        loading: 'lazy',
        decoding: 'async',
        referrerpolicy: 'no-referrer',
      },
    });
    img.addEventListener('error', () => img.remove());
  }
  thumb.createSpan({ cls: 'vs-thumb-bar' });
  if (options.duration) {
    thumb.createSpan({ text: options.duration, cls: 'vs-thumb-time' });
  }
  return thumb;
}

export function platformClass(platform?: string): string {
  switch (platform) {
    case 'youtube':
    case 'bilibili':
    case 'douyin':
    case 'tiktok':
    case 'xiaohongshu':
      return `is-${platform}`;
    default:
      return 'is-generic';
  }
}

/** 平台名，带平台色 */
export function platformText(parent: HTMLElement, platform: string | undefined, label: string) {
  return parent.createSpan({ text: label, cls: `vs-platform ${platformClass(platform)}` });
}

/** mm:ss，用于"已用 01:24" */
export function formatClock(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '00:00';
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function platformIcon(platform?: string): string {
  switch (platform) {
    case 'youtube':
      return 'youtube';
    case 'bilibili':
      return 'tv';
    case 'douyin':
    case 'tiktok':
      return 'music';
    case 'xiaohongshu':
      return 'book-open';
    case 'local':
      return 'file-video';
    default:
      return 'link';
  }
}

export function modeLabel(mode: string): string {
  switch (mode) {
    case 'transcript-only':
      return '仅文稿';
    case 'info-only':
      return '仅信息';
    default:
      return '完整总结';
  }
}

export function languageLabel(language: string): string {
  switch (language) {
    case 'en':
      return 'English';
    case 'ja':
      return '日本語';
    default:
      return '中文';
  }
}

export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

export function formatRelative(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  const days = Math.floor(diff / 86_400_000);
  if (days < 30) return `${days} 天前`;
  return new Date(timestamp).toLocaleDateString('zh-CN');
}

/** 解析 "2026/7/26 10:20:31" 这类本地化时间串，失败返回 null */
export function parseLocaleTime(value: string): number | null {
  const parsed = Date.parse(value);
  if (!Number.isNaN(parsed)) return parsed;
  const match = value.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})\D+(\d{1,2}):(\d{2}):?(\d{2})?/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  return new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second || '0'),
  ).getTime();
}

export function emptyState(parent: HTMLElement, icon: string, title: string, hint?: string) {
  const wrapper = parent.createDiv({ cls: 'vs-empty' });
  const iconEl = wrapper.createDiv({ cls: 'vs-empty-icon' });
  setIcon(iconEl, icon);
  wrapper.createDiv({ text: title, cls: 'vs-empty-title' });
  if (hint) wrapper.createDiv({ text: hint, cls: 'vs-empty-hint' });
}
