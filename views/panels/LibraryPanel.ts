import { Notice, TFile, setIcon } from 'obsidian';
import { ViewContext, LibraryFilter } from '../context';
import { canLoadRemoteCover, VideoNoteEntry, platformLabel } from '../../core/NoteIndex';
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

import { fire } from '../../utils/fire';
import { tr } from '../../utils/i18n';
const PAGE_SIZE = 80;

/** 搜索框失焦问题：面板重建后按这个标记把焦点还回去 */
let searchHadFocus = false;
let visibleCount = PAGE_SIZE;
let coverObserver: IntersectionObserver | null = null;

export function resetLibraryPaging() {
  visibleCount = PAGE_SIZE;
}

export function disconnectLibraryCoverObserver() {
  coverObserver?.disconnect();
  coverObserver = null;
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
    attr: {
      type: 'text',
      placeholder: tr('搜索笔记名…', 'Search note names…'),
      value: state.librarySearch,
    },
  });

  iconButton(header, 'arrow-up-down', tr('排序方式', 'Sort by'), (event) => {
    showMenu(
      event,
      [
        { value: 'mtime-desc', title: tr('最近修改', 'Recently modified') },
        { value: 'ctime-desc', title: tr('最近创建', 'Recently created') },
        { value: 'name-asc', title: tr('名称 A→Z', 'Name A→Z') },
        { value: 'status', title: tr('按状态', 'By status') },
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
      ? tr(
          `进行 ${counts.active} · 中断 ${counts.interrupted}`,
          `Running ${counts.active} · interrupted ${counts.interrupted}`,
        )
      : counts.active > 0
        ? tr(`处理中 ${counts.active}`, `Processing ${counts.active}`)
        : counts.interrupted > 0
          ? tr(`已中断 ${counts.interrupted}`, `Interrupted ${counts.interrupted}`)
          : tr('处理中 0', 'Processing 0');
  const filters = container.createDiv({ cls: 'vs-filter-row' });
  (
    [
      ['all', tr(`全部 ${entries.length}`, `All ${entries.length}`), ''],
      ['pending', tr(`待处理 ${counts.pending}`, `Pending ${counts.pending}`), 'is-pending'],
      [
        'running',
        runningLabel,
        counts.active === 0 && counts.interrupted > 0 ? 'is-interrupted' : 'is-running',
      ],
      ['error', tr(`失败 ${counts.error}`, `Failed ${counts.error}`), 'is-error'],
      ['success', tr(`已完成 ${counts.success}`, `Done ${counts.success}`), 'is-success'],
    ] as Array<[LibraryFilter, string, string]>
  ).forEach(([value, label, tone]) => {
    const chip = filters.createEl('button', {
      text: label,
      cls: `vs-filter-chip ${tone}${state.libraryFilter === value ? ' is-active' : ''}`,
      attr: {
        type: 'button',
        title:
          value === 'running'
            ? tr(
                '查看本次会话中进行的任务和上次中断的笔记',
                'Jobs from this session and notes that were interrupted last time',
              )
            : label,
      },
    });
    chip.addEventListener(
      'click',
      fire(async () => {
        state.libraryFilter = value;
        plugin.settings.statusFilterValue = value;
        await plugin.saveSettings();
        resetLibraryPaging();
        ctx.renderPanels();
      }),
    );
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
    coverObserver?.disconnect();
    coverObserver = null;
    if (typeof IntersectionObserver !== 'undefined') {
      const observer = new IntersectionObserver(
        (observed) => {
          observed.forEach((item) => {
            if (!item.isIntersecting) return;
            const element = item.target as HTMLElement;
            observer.unobserve(element);
            const path = element.dataset.coverPath;
            if (path) plugin.noteIndex.ensureCover(path);
          });
        },
        { rootMargin: '96px 0px', threshold: 0.01 },
      );
      coverObserver = observer;
    }

    listEl.empty();
    if (filtered.length === 0) {
      if (plugin.noteIndex.isScanning()) {
        emptyState(
          listEl,
          'loader',
          tr('正在建立索引…', 'Building the index…'),
          tr(
            '第一次打开会扫一遍库，稍等几秒',
            'The first time scans the vault; wait a few seconds',
          ),
        );
      } else {
        emptyState(
          listEl,
          'file-search',
          tr('没有匹配的视频笔记', 'No matching video notes'),
          tr('换个关键词，或清掉状态筛选', 'Try another word, or clear the status filter'),
        );
      }
      return;
    }
    filtered
      .slice(0, visibleCount)
      .forEach((entry) => renderRow(listEl, ctx, entry, coverObserver));
    if (filtered.length > visibleCount) {
      const more = listEl.createEl('button', {
        text: tr(
          `显示更多 · 还有 ${filtered.length - visibleCount} 条`,
          `Show more · ${filtered.length - visibleCount} more`,
        ),
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
    container.createDiv({
      text: tr('仍在后台扫描历史笔记…', 'Still scanning older notes in the background…'),
      cls: 'vs-scan-hint',
    });
  }
}

function renderRow(
  listEl: HTMLElement,
  ctx: ViewContext,
  entry: VideoNoteEntry,
  observer: IntersectionObserver | null,
) {
  const row = listEl.createDiv({ cls: 'vs-row' });
  if (!entry.cover && canLoadRemoteCover(entry.link)) {
    row.dataset.coverPath = entry.path;
    if (observer) {
      observer.observe(row);
    } else {
      // 老版 WebView 不自动扫 80 行；用户真的碰到或聚焦这一行时再取。
      const loadCover = () => ctx.plugin.noteIndex.ensureCover(entry.path);
      row.addEventListener('pointerenter', loadCover, { once: true });
      row.addEventListener('focusin', loadCover, { once: true });
    }
  }
  const displayStatus = noteDisplayStatus(entry, ctx.plugin.jobs);
  const filterStatus = filterForDisplayStatus(displayStatus);
  thumbnail(row, { cover: entry.cover, duration: entry.duration, platform: entry.platform });

  const body = row.createDiv({ cls: 'vs-row-body' });
  body.createDiv({ text: entry.basename, cls: 'vs-row-title' });
  const sub = body.createDiv({ cls: 'vs-row-sub' });
  platformText(sub, entry.platform, platformLabel(entry.platform));
  sub.createSpan({ text: formatRelative(entry.mtime) });
  body.addEventListener(
    'click',
    fire(() => ctx.openNote(entry.path)),
  );
  body.tabIndex = 0;
  body.setAttribute('role', 'button');
  body.setAttribute(
    'aria-label',
    tr(`打开笔记：${entry.basename}`, `Open note: ${entry.basename}`),
  );
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
        ? tr('只看进行中或已中断', 'Only running or interrupted')
        : tr(
            `只看${displayStatus === 'success' ? '已完成' : displayStatus === 'error' ? '失败' : '待处理'}`,
            `Only ${displayStatus === 'success' ? 'done' : displayStatus === 'error' ? 'failed' : 'pending'}`,
          ),
  });
  statePill.addClass('vs-row-status');

  const actions = row.createDiv({ cls: 'vs-row-actions' });
  const liveJob = liveJobForNote(ctx.plugin.jobs, entry.path);
  if (displayStatus === 'queued' || displayStatus === 'running') {
    iconButton(
      actions,
      'x',
      tr('取消', 'Cancel'),
      fire(async () => {
        if (liveJob) await ctx.plugin.jobService.cancel(liveJob);
        ctx.renderPanels();
      }),
      'is-accent',
    );
  } else if (displayStatus === 'review' && liveJob) {
    iconButton(
      actions,
      'eye',
      tr('确认结果', 'Confirm result'),
      () => ctx.openDetail({ kind: 'job', id: liveJob.id }),
      'is-accent',
    );
  } else {
    iconButton(
      actions,
      displayStatus === 'interrupted' ? 'refresh-cw' : 'play',
      displayStatus === 'success' || displayStatus === 'interrupted'
        ? tr('重跑', 'Run again')
        : tr('处理', 'Process'),
      fire(async () => {
        const file = fileOf(ctx, entry);
        if (!file) return;
        await ctx.plugin.jobService.submitFile(file, ctx.submitOptions());
        ctx.state.tab = 'jobs';
        ctx.renderPanels();
      }),
      'is-accent',
    );
  }

  if (entry.artifactId) {
    iconButton(
      actions,
      'book-open',
      tr('打开同步陪读', 'Open synced read-along'),
      () =>
        ctx.openDetail({
          kind: 'note',
          path: entry.path,
          artifactId: entry.artifactId!,
        }),
      'is-accent',
    );
  }

  iconButton(actions, 'more-horizontal', tr('更多操作', 'More actions'), (event) => {
    const menuItems = [
      {
        title: tr('打开笔记', 'Open note'),
        icon: 'file-text',
        onClick: () => ctx.openNote(entry.path),
      },
      ...(entry.artifactId
        ? [
            {
              title: tr('同步陪读', 'Reader'),
              icon: 'book-open',
              onClick: () =>
                ctx.openDetail({
                  kind: 'note' as const,
                  path: entry.path,
                  artifactId: entry.artifactId!,
                }),
            },
          ]
        : []),
      {
        title: tr('重跑（跳过缓存）', 'Run again (skip cache)'),
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
        title: tr('复制链接', 'Copy link'),
        icon: 'clipboard',
        disabled: !entry.link,
        onClick: () => {
          void navigator.clipboard.writeText(entry.link || '');
          new Notice(tr('已复制链接', 'Link copied'));
        },
      },
      {
        title: tr('标记为待处理', 'Mark as pending'),
        icon: 'rotate-ccw',
        onClick: async () => {
          const file = fileOf(ctx, entry);
          if (file) await ctx.plugin.noteProcessor.setProcessingStatus(file, 'pending');
          ctx.renderPanels();
        },
      },
      {
        title: tr('删除笔记', 'Delete note'),
        icon: 'trash-2',
        onClick: () => confirmDelete(ctx, entry),
      },
    ];
    showMenu(event, menuItems);
  });
}

function confirmDelete(ctx: ViewContext, entry: VideoNoteEntry) {
  new ConfirmModal(
    ctx.plugin.app,
    tr('删除笔记', 'Delete note'),
    tr(
      `确定删除 "${entry.basename}"？会按 Obsidian 的“删除文件”设置移到回收站。`,
      `Delete "${entry.basename}"? It goes to the trash according to Obsidian's "Deleted files" setting.`,
    ),
    fire(async (confirmed: boolean) => {
      if (!confirmed) return;
      const file = fileOf(ctx, entry);
      if (!file) return;
      await ctx.plugin.app.fileManager.trashFile(file);
      new Notice(tr(`已删除 ${entry.basename}`, `Deleted ${entry.basename}`));
      ctx.renderPanels();
    }),
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
