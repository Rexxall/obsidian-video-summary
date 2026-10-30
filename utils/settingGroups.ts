/**
 * Marks the first and last row of each settings group, so the stylesheet can round the group's
 * corners and drop the hairline above its first row without a parent selector. Empty or hidden helpers between
 * rows (status lines, QR boxes) do not split a group. From Obsidian 1.13 the page sits inside a
 * settings row of its own; that wrapper is marked too, so its card can be dropped.
 */
export function markSettingGroups(root: HTMLElement): void {
  root.parentElement?.toggleClass('ap-settings-host', root.parentElement.hasClass('setting-items'));
  const isRow = (el: Element | null) =>
    !!el && el.hasClass('setting-item') && !el.hasClass('setting-item-heading');
  const isSkipped = (el: Element) =>
    !el.hasChildNodes() || (el.instanceOf(HTMLElement) && el.style.display === 'none');
  const neighbour = (el: Element, step: 'previousElementSibling' | 'nextElementSibling') => {
    let next = el[step];
    while (next && isSkipped(next)) next = next[step];
    return next;
  };
  root.querySelectorAll('.setting-item:not(.setting-item-heading)').forEach((row) => {
    row.toggleClass('ap-group-first', !isRow(neighbour(row, 'previousElementSibling')));
    row.toggleClass('ap-group-last', !isRow(neighbour(row, 'nextElementSibling')));
  });
}

/** Keeps the marks current while rows are added, removed, shown or hidden. Returns a stop function. */
export function watchSettingGroups(root: HTMLElement): () => void {
  markSettingGroups(root);
  let frame = 0;
  const observer = new MutationObserver(() => {
    if (frame) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      markSettingGroups(root);
    });
  });
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['style'],
  });
  return () => {
    observer.disconnect();
    window.cancelAnimationFrame(frame);
  };
}
