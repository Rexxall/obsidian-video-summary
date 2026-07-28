// agent: claude (2026-07-26)
import { Notice, TFile, setIcon } from 'obsidian';
import { ViewContext, LibraryFilter } from '../context';
import { VideoNoteEntry, platformLabel } from '../../core/NoteIndex';
import { ConfirmModal } from '../../modals';
import { liveJobForNote, noteDisplayStatus, NoteDisplayStatus } from '../noteStatus';
import {
  emptyState,
  formatRelative,
  iconButton,
  platformText,
  showMenu,
  statusPill,
  thumbnail,
} from '../ui';

const PAGE_SIZE = 80;

/** 搜索框失焦问题：面板重建后按这个标记把焦点还回去 */
let searchHadFocus = false;
let visibleCount = PAGE_SIZE;

export function resetLibraryPaging() {
  visibleCount = PAGE_SIZE;
}

/** 笔记库：索引驱动 + 分批渲染，库大了也不会一次铺几千个 DOM 节点 */
export function renderLibraryPanel(container: HTMLElement, ctx: ViewContext) {
  const { state, plugin } = ctx;
  const entries = plugin.noteIndex.getAll();

  const header = container.createDiv({ cls: 'vs-library-header' });
  const searchWrap = header.createDiv({ cls: 'vs-search' });
  const searchIcon = searchWrap.createDiv({ cls: 'vs-search-icon' });
  setIcon(searchIcon, 'search');
  const search = searchWrap.createEl('input', {
    cls: 'vs-search-input',
    attr: { type: 'text', placeholder: '搜索笔记名…', value: state.librarySearch },
  });

  iconButton(header, 'arrow-up-down', '排序方式', (event) => {
    showMenu(
      event,
      [
        { value: 'mtime-desc', title: '最近修改' },
        { value: 'ctime-desc', title: '最近创建' },
        { value: 'name-asc', title: '名称 A→Z' },
        { value: 'status', title: '按状态' },
      ].map((option) => ({
        title: option.title + (state.librarySort === option.value ? ' ✓' : ''),
        onClick: async () => {
          state.librarySort = option.value;
          plugin.settings.fileListSortBy = option.value;
          await plugin.saveSettings();
          ctx.renderPanels();
        },
      })),
    );
  });

  const counts = countByStatus(entries, ctx);
  const runningLabel =
    counts.active > 0 && counts.interrupted > 0
      ? `进行 ${counts.active} · 中断 ${counts.interrupted}`
      : counts.active > 0
        ? `处理中 ${counts.active}`
        : counts.interrupted > 0
          ? `已中断 ${counts.interrupted}`
          : '处理中 0';
  const filters = container.createDiv({ cls: 'vs-filter-row' });
  (
    [
      ['all', `全部 ${entries.length}`, ''],
      ['pending', `待处理 ${counts.pending}`, 'is-pending'],
      [
        'running',
        runningLabel,
        counts.active === 0 && counts.interrupted > 0 ? 'is-interrupted' : 'is-running',
      ],
      ['error', `失败 ${counts.error}`, 'is-error'],
      ['success', `已完成 ${counts.success}`, 'is-success'],
    ] as Array<[LibraryFilter, string, string]>
  ).forEach(([value, label, tone]) => {
    const chip = filters.createEl('button', {
      text: label,
      cls: `vs-filter-chip ${tone}${state.libraryFilter === value ? ' is-active' : ''}`,
      attr: {
        type: 'button',
        title: value === 'running' ? '查看本次会话中进行的任务和上次中断的笔记' : label,
      },
    });
    chip.addEventListener('click', async () => {
      state.libraryFilter = value;
      plugin.settings.statusFilterValue = value;
      await plugin.saveSettings();
      resetLibraryPaging();
      ctx.renderPanels();
    });
  });

  const listEl = container.createDiv({ cls: 'vs-list' });
  const filtered = filterAndSort(
    entries,
    state.librarySearch,
    state.libraryFilter,
    state.librarySort,
    ctx,
  );

  const renderList = () => {
    listEl.empty();
    if (filtered.length === 0) {
      if (plugin.noteIndex.isScanning()) {
        emptyState(listEl, 'loader', '正在建立索引…', '第一次打开会扫一遍库，稍等几秒');
      } else {
        emptyState(listEl, 'file-search', '没有匹配的视频笔记', '换个关键词，或清掉状态筛选');
      }
      return;
    }
    filtered.slice(0, visibleCount).forEach((entry) => renderRow(listEl, ctx, entry));
    if (filtered.length > visibleCount) {
      const more = listEl.createEl('button', {
        text: `显示更多 · 还有 ${filtered.length - visibleCount} 条`,
        cls: 'vs-more-btn',
        attr: { type: 'button' },
      });
      more.addEventListener('click', () => {
        visibleCount += PAGE_SIZE;
        renderList();
      });
    }
  };

  renderList();

  search.addEventListener('input', () => {
    state.librarySearch = search.value;
    resetLibraryPaging();
    const next = filterAndSort(
      entries,
      state.librarySearch,
      state.libraryFilter,
      state.librarySort,
      ctx,
    );
    filtered.length = 0;
    filtered.push(...next);
    renderList();
  });
  search.addEventListener('focus', () => {
    searchHadFocus = true;
  });
  search.addEventListener('blur', () => {
    searchHadFocus = false;
  });
  if (searchHadFocus) {
    search.focus();
    search.setSelectionRange(search.value.length, search.value.length);
  }

  if (plugin.noteIndex.isScanning() && filtered.length > 0) {
    container.createDiv({ text: '仍在后台扫描历史笔记…', cls: 'vs-scan-hint' });
  }
}

function renderRow(listEl: HTMLElement, ctx: ViewContext, entry: VideoNoteEntry) {
  const row = listEl.createDiv({ cls: 'vs-row' });
  const displayStatus = noteDisplayStatus(entry, ctx.plugin.jobs);
  const filterStatus = filterForDisplayStatus(displayStatus);
  thumbnail(row, { cover: entry.cover, duration: entry.duration, platform: entry.platform });

  const body = row.createDiv({ cls: 'vs-row-body' });
  body.createDiv({ text: entry.basename, cls: 'vs-row-title' });
  const sub = body.createDiv({ cls: 'vs-row-sub' });
  platformText(sub, entry.platform, platformLabel(entry.platform));
  sub.createSpan({ text: formatRelative(entry.mtime) });
  body.addEventListener('click', () => ctx.openNote(entry.path));
  body.tabIndex = 0;
  body.setAttribute('role', 'button');
  body.setAttribute('aria-label', `打开笔记：${entry.basename}`);
  body.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    body.click();
  });

  // 状态胶囊即筛选：点一下就把列表收敛到同状态
  const statePill = statusPill(row, displayStatus, {
    onClick: async () => {
      ctx.state.libraryFilter = filterStatus;
      ctx.plugin.settings.statusFilterValue = filterStatus;
      await ctx.plugin.saveSettings();
      resetLibraryPaging();
      ctx.renderPanels();
    },
    title:
      entry.status === 'running'
        ? '只看进行中或已中断'
        : `只看${displayStatus === 'success' ? '已完成' : displayStatus === 'error' ? '失败' : '待处理'}`,
  });
  statePill.addClass('vs-row-status');

  const actions = row.createDiv({ cls: 'vs-row-actions' });
  const liveJob = liveJobForNote(ctx.plugin.jobs, entry.path);
  if (displayStatus === 'queued' || displayStatus === 'running') {
    iconButton(
      actions,
      'x',
      '取消',
      async () => {
        if (liveJob) await ctx.plugin.jobService.cancel(liveJob);
        ctx.renderPanels();
      },
      'is-accent',
    );
  } else if (displayStatus === 'review' && liveJob) {
    iconButton(
      actions,
      'eye',
      '确认结果',
      () => ctx.openDetail({ kind: 'job', id: liveJob.id }),
      'is-accent',
    );
  } else {
    iconButton(
      actions,
      displayStatus === 'interrupted' ? 'refresh-cw' : 'play',
      displayStatus === 'success' || displayStatus === 'interrupted' ? '重跑' : '处理',
      async () => {
        const file = fileOf(ctx, entry);
        if (!file) return;
        await ctx.plugin.jobService.submitFile(file, ctx.submitOptions());
        ctx.state.tab = 'jobs';
        ctx.renderPanels();
      },
      'is-accent',
    );
  }

  iconButton(actions, 'more-horizontal', '更多操作', (event) => {
    showMenu(event, [
      { title: '打开笔记', icon: 'file-text', onClick: () => ctx.openNote(entry.path) },
      {
        title: '重跑（跳过缓存）',
        icon: 'refresh-cw',
        onClick: async () => {
          const file = fileOf(ctx, entry);
          if (!file) return;
          await ctx.plugin.jobService.submitFile(file, { ...ctx.submitOptions(), useCache: false });
          ctx.state.tab = 'jobs';
          ctx.renderPanels();
        },
      },
      {
        title: '复制链接',
        icon: 'clipboard',
        disabled: !entry.link,
        onClick: () => {
          void navigator.clipboard.writeText(entry.link || '');
          new Notice('已复制链接');
        },
      },
      {
        title: '标记为待处理',
        icon: 'rotate-ccw',
        onClick: async () => {
          const file = fileOf(ctx, entry);
          if (file) await ctx.plugin.noteProcessor.setProcessingStatus(file, 'pending');
          ctx.renderPanels();
        },
      },
      { title: '删除笔记', icon: 'trash-2', onClick: () => confirmDelete(ctx, entry) },
    ]);
  });
}

function confirmDelete(ctx: ViewContext, entry: VideoNoteEntry) {
  new ConfirmModal(
    ctx.plugin.app,
    '删除笔记',
    `确定把 "${entry.basename}" 移到系统回收站？`,
    async (confirmed: boolean) => {
      if (!confirmed) return;
      const file = fileOf(ctx, entry);
      if (!file) return;
      await ctx.plugin.app.vault.trash(file, true);
      new Notice(`已删除 ${entry.basename}`);
      ctx.renderPanels();
    },
  ).open();
}

function fileOf(ctx: ViewContext, entry: VideoNoteEntry): TFile | null {
  const file = ctx.plugin.app.vault.getAbstractFileByPath(entry.path);
  return file instanceof TFile ? file : null;
}

function countByStatus(entries: VideoNoteEntry[], ctx: ViewContext) {
  const counts = { pending: 0, active: 0, interrupted: 0, success: 0, error: 0 };
  entries.forEach((entry) => {
    const displayStatus = noteDisplayStatus(entry, ctx.plugin.jobs);
    if (displayStatus === 'queued' || displayStatus === 'running' || displayStatus === 'review') {
      counts.active += 1;
    } else if (displayStatus === 'interrupted') {
      counts.interrupted += 1;
    } else if (displayStatus === 'success') {
      counts.success += 1;
    } else if (displayStatus === 'error') {
      counts.error += 1;
    } else {
      counts.pending += 1;
    }
  });
  return counts;
}

function filterAndSort(
  entries: VideoNoteEntry[],
  keyword: string,
  filter: LibraryFilter,
  sort: string,
  ctx: ViewContext,
): VideoNoteEntry[] {
  const lowered = keyword.trim().toLowerCase();
  const filtered = entries.filter((entry) => {
    const nameMatch = !lowered || entry.basename.toLowerCase().includes(lowered);
    const statusMatch =
      filter === 'all' ||
      filterForDisplayStatus(noteDisplayStatus(entry, ctx.plugin.jobs)) === filter;
    return nameMatch && statusMatch;
  });

  const statusOrder: Record<NoteDisplayStatus, number> = {
    error: 0,
    interrupted: 1,
    pending: 2,
    queued: 3,
    running: 3,
    review: 3,
    success: 4,
  };
  switch (sort) {
    case 'name-asc':
      return filtered.sort((a, b) => a.basename.localeCompare(b.basename));
    case 'ctime-desc':
      return filtered.sort((a, b) => b.ctime - a.ctime);
    case 'status':
      return filtered.sort(
        (a, b) =>
          statusOrder[noteDisplayStatus(a, ctx.plugin.jobs)] -
            statusOrder[noteDisplayStatus(b, ctx.plugin.jobs)] || b.mtime - a.mtime,
      );
    default:
      return filtered.sort((a, b) => b.mtime - a.mtime);
  }
}

function filterForDisplayStatus(status: NoteDisplayStatus): LibraryFilter {
  if (
    status === 'queued' ||
    status === 'running' ||
    status === 'review' ||
    status === 'interrupted'
  ) {
    return 'running';
  }
  return status;
}
