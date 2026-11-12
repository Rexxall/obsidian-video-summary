import { MarkdownView, type App, type WorkspaceLeaf } from 'obsidian';

import { wantsReadingView } from './ReadingViewRule';

/**
 * Switches tabs that show a finished video note to reading view, once per note per tab.
 * Obsidian tells about a newly opened file only for the active tab (file-open), and a note
 * opened from the side panel or in the background is not always that tab, so every change of
 * layout or active tab looks at all open tabs.
 */
export class ReadingViewOpener {
  private readonly seen = new WeakMap<WorkspaceLeaf, string>();
  private pending = false;

  constructor(
    private readonly app: App,
    private readonly enabled: () => boolean,
  ) {}

  /** Coalesces bursts of workspace events into one look a moment later. */
  schedule() {
    if (this.pending) return;
    this.pending = true;
    window.setTimeout(() => {
      this.pending = false;
      void this.scan();
    }, 80);
  }

  private async scan() {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView) || !view.file) continue;
      const path = view.file.path;
      if (this.seen.get(leaf) === path) continue;
      const frontmatter = this.app.metadataCache.getFileCache(view.file)?.frontmatter;
      // Not read yet: look again on the next event instead of deciding without it.
      if (frontmatter === undefined && !this.app.metadataCache.getFileCache(view.file)) continue;
      this.seen.set(leaf, path);
      if (!wantsReadingView(this.enabled(), frontmatter, false)) continue;
      if (view.getMode() === 'preview') continue;
      await view.setState({ ...view.getState(), mode: 'preview' }, { history: false });
    }
  }
}
