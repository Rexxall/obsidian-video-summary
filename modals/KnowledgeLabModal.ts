import { App, Modal, Notice, TFile, TFolder, normalizePath } from 'obsidian';
import type VideoSummaryPlugin from '../main';
import type { VideoKnowledgeArtifact } from '../types';
import { buildClaimLabReport, stableTextHash, upsertClaimLabMarkdown } from '../core/ClaimLab';
import {
  CrossModalMemoryIndex,
  applyReviewedRelationSuggestion,
  suggestArtifactRelation,
  type ArtifactRelationSuggestion,
  type MemorySearchFilters,
  type MemorySearchResult,
  type TextHighlightRange,
} from '../core/CrossModalMemory';
import { safeExternalHttpUrl, safeManagedVaultImagePath } from '../utils/SafeExternalUrl';

import { errorMessage } from '../utils/errors';
import { tr } from '../utils/i18n';
export type KnowledgeLabMode = 'memory' | 'claim-lab';

/**
 * One artifact-first entry point for features 7 and 8.
 *
 * It never scans arbitrary Markdown notes. Both modes load the canonical
 * persisted artifacts, so a restart or renamed note cannot silently change the
 * underlying evidence set.
 */
export class KnowledgeLabModal extends Modal {
  private readonly plugin: VideoSummaryPlugin;
  private readonly mode: KnowledgeLabMode;
  private artifacts: VideoKnowledgeArtifact[] = [];
  private disposed = false;

  constructor(app: App, plugin: VideoSummaryPlugin, mode: KnowledgeLabMode) {
    super(app);
    this.plugin = plugin;
    this.mode = mode;
  }

  onOpen(): void {
    this.modalEl.addClass('ap', 'ap-modal');
    this.contentEl.empty();
    this.contentEl.addClass('vs-modal', 'vs-knowledge-lab');
    this.contentEl.createEl('h2', {
      text:
        this.mode === 'memory'
          ? tr('跨模态视频记忆搜索', 'Search video memory across media')
          : tr('多视频论点实验室', 'Multi-video claim lab'),
    });
    this.contentEl.createEl('p', {
      cls: 'vs-knowledge-lab-intro',
      text:
        this.mode === 'memory'
          ? tr(
              '从持久化工件重建本地索引：标题、时间段文稿、画面文字、OCR、视觉证据与主张。',
              'Rebuilds a local index from saved artifacts: titles, timed transcript, on-screen text, OCR, visual evidence and claims.',
            )
          : tr(
              '选择至少两个已持久化工件，生成保留真实证据与复核状态的可编辑 Markdown。',
              'Pick at least two saved artifacts to build editable Markdown that keeps real evidence and review status.',
            ),
    });
    const loading = this.contentEl.createDiv({ cls: 'vs-knowledge-lab-loading' });
    loading.setText(tr('正在读取本地知识工件…', 'Reading local knowledge artifacts…'));
    void this.loadAndRender(loading);
  }

  onClose(): void {
    this.disposed = true;
    this.contentEl.empty();
  }

  private async loadAndRender(loading: HTMLElement): Promise<void> {
    try {
      this.artifacts = await this.plugin.artifactStore.list();
      if (this.disposed) return;
      loading.remove();
      if (this.artifacts.length === 0) {
        this.contentEl.createEl('p', {
          cls: 'vs-knowledge-lab-empty',
          text: tr(
            '还没有持久化的视频知识工件。请先处理至少一个视频。',
            'No saved video knowledge artifacts yet. Process at least one video first.',
          ),
        });
        return;
      }
      if (this.mode === 'memory') {
        this.renderMemorySearch();
      } else {
        this.renderClaimLab();
      }
    } catch (error) {
      if (this.disposed) return;
      loading.setText(tr(`读取失败：${messageOf(error)}`, `Could not read: ${messageOf(error)}`));
    }
  }

  private renderMemorySearch(): void {
    const index = this.plugin.memoryIndex || new CrossModalMemoryIndex();
    index.rebuild(this.artifacts);

    const controls = this.contentEl.createDiv({ cls: 'vs-memory-controls' });
    const query = controls.createEl('input', {
      cls: 'vs-memory-query',
      attr: {
        type: 'search',
        placeholder: tr(
          '搜索概念、原话、画面文字或主张…',
          'Search concepts, quotes, on-screen text or claims…',
        ),
        'aria-label': tr('搜索视频记忆', 'Search video memory'),
      },
    });
    const searchButton = controls.createEl('button', {
      text: tr('搜索', 'Search'),
      cls: 'mod-cta',
    });

    const filtersEl = this.contentEl.createDiv({ cls: 'vs-memory-filters' });
    const author = labeledInput(filtersEl, '作者', '任意作者');
    const platform = labeledSelect(filtersEl, '平台', [
      '',
      ...uniqueStrings(this.artifacts.map((artifact) => artifact.platform)),
    ]);
    const contentType = labeledSelect(filtersEl, '类型', [
      '',
      'course',
      'interview',
      'tutorial',
      'news',
      'meeting',
      'review',
      'general',
    ]);
    const courseId = labeledInput(filtersEl, '课程 ID', '任意课程');
    const dateField = labeledSelect(filtersEl, '日期字段', ['either', 'generated', 'updated']);
    const dateFrom = labeledInput(filtersEl, '起始日期', '', 'date');
    const dateTo = labeledInput(filtersEl, '结束日期', '', 'date');

    const relationRow = this.contentEl.createDiv({ cls: 'vs-memory-relation-source' });
    relationRow.createEl('label', {
      text: tr('关系建议来源（可选）', 'Relation suggestions from (optional)'),
    });
    const sourceArtifact = relationRow.createEl('select', {
      attr: { 'aria-label': tr('关系建议来源工件', 'Artifact to suggest relations from') },
    });
    sourceArtifact.createEl('option', {
      text: tr('不生成关系建议', 'No relation suggestions'),
      value: '',
    });
    this.artifacts.forEach((artifact) => {
      sourceArtifact.createEl('option', {
        text: artifact.title || artifact.artifact_id,
        value: artifact.artifact_id,
      });
    });
    relationRow.createSpan({
      text: tr(
        '建议不会自动写入；每条关系都需要再次明确确认。',
        'Suggestions are never written automatically; every relation needs your confirmation.',
      ),
    });

    const status = this.contentEl.createDiv({ cls: 'vs-memory-status' });
    status.setText(
      tr(
        `已索引 ${index.getRecordCount()} 条本地证据记录`,
        `Indexed ${index.getRecordCount()} local evidence records`,
      ),
    );
    const resultsEl = this.contentEl.createDiv({ cls: 'vs-memory-results' });

    const execute = () => {
      const filters: MemorySearchFilters = {
        author: author.value || undefined,
        platform: platform.value || undefined,
        content_type: (contentType.value || undefined) as MemorySearchFilters['content_type'],
        course_id: courseId.value || undefined,
        date_field: dateField.value as MemorySearchFilters['date_field'],
        date_from: dateFrom.value || undefined,
        date_to: dateTo.value || undefined,
      };
      const results = index.search(query.value, { filters, limit: 50 });
      status.setText(
        query.value.trim()
          ? tr(
              `找到 ${results.length} 条证据；排名可展开查看本地评分组成`,
              `Found ${results.length} pieces of evidence; expand a rank to see its local score`,
            )
          : tr('请输入搜索词', 'Enter a search term'),
      );
      this.renderMemoryResults(resultsEl, results, index, sourceArtifact.value || undefined);
    };
    searchButton.onclick = execute;
    query.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') execute();
    });
    query.focus();
  }

  private renderMemoryResults(
    container: HTMLElement,
    results: readonly MemorySearchResult[],
    index: CrossModalMemoryIndex,
    sourceArtifactId?: string,
  ): void {
    container.empty();
    if (results.length === 0) {
      container.createEl('p', {
        cls: 'vs-knowledge-lab-empty',
        text: tr(
          '没有匹配的持久化证据。可以减少过滤条件或换一个搜索词。',
          'No saved evidence matches. Remove filters or try another term.',
        ),
      });
      return;
    }

    const relationTargets = new Set<string>();
    results.forEach((result) => {
      const card = container.createDiv({ cls: 'vs-memory-result' });
      const heading = card.createDiv({ cls: 'vs-memory-result-heading' });
      const targetUrl =
        safeExternalHttpUrl(result.timestamp_url) || safeExternalHttpUrl(result.source_url);
      if (targetUrl) {
        const link = heading.createEl('a', {
          text: `${result.title}${result.timestamp !== null ? ` · ${formatTime(result.timestamp)}` : ''}`,
          href: targetUrl,
        });
        link.setAttr('target', '_blank');
        link.setAttr('rel', 'noopener');
      } else {
        heading.createEl('strong', { text: result.title });
      }
      heading.createSpan({
        cls: 'vs-memory-evidence-type',
        text: result.evidence_type,
      });
      heading.createSpan({
        cls: 'vs-memory-score',
        text: result.score.toFixed(2),
        attr: { title: tr('确定性本地评分', 'Deterministic local score') },
      });

      const snippet = card.createEl('p', { cls: 'vs-memory-snippet' });
      renderHighlightedText(snippet, result.snippet, result.highlights);
      const meta = card.createDiv({ cls: 'vs-memory-meta' });
      meta.setText(
        [
          result.author,
          result.platform,
          result.content_type,
          result.evidence_type === 'claim' && result.claim_review_state
            ? `主张状态 ${result.claim_review_state}`
            : undefined,
          ...result.course_ids,
        ]
          .filter(Boolean)
          .join(' · '),
      );
      const details = card.createEl('details', { cls: 'vs-memory-score-details' });
      details.createEl('summary', { text: tr('为什么排在这里', 'Why it ranks here') });
      const list = details.createEl('ul');
      result.score_explanation.forEach((component) => {
        list.createEl('li', { text: component.explanation });
      });

      this.renderKeyframe(card, result);

      if (
        sourceArtifactId &&
        sourceArtifactId !== result.artifact_id &&
        !relationTargets.has(result.artifact_id)
      ) {
        const source = index.getArtifact(sourceArtifactId);
        const target = index.getArtifact(result.artifact_id);
        if (source && target) {
          relationTargets.add(result.artifact_id);
          this.renderRelationReview(card, suggestArtifactRelation(source, target));
        }
      }
    });
  }

  private renderKeyframe(card: HTMLElement, result: MemorySearchResult): void {
    const reference = result.keyframe;
    if (!reference) return;
    let source: string | undefined;
    const localPath = safeManagedVaultImagePath(reference.path, result.media_asset_root);
    if (localPath) {
      const file = this.app.vault.getAbstractFileByPath(normalizePath(localPath));
      if (file instanceof TFile) source = this.app.vault.getResourcePath(file);
    }
    if (!source) return;
    card.createEl('img', {
      cls: 'vs-memory-keyframe',
      attr: { src: source, alt: `关键帧：${result.title}`, loading: 'lazy' },
    });
  }

  private renderRelationReview(card: HTMLElement, suggestion: ArtifactRelationSuggestion): void {
    const review = card.createDiv({ cls: 'vs-relation-review' });
    review.createEl('strong', {
      text: tr(
        `关系建议：${relationLabel(suggestion.relation)} · ${Math.round(
          suggestion.confidence * 100,
        )}%`,
        `Relation suggestion: ${relationLabel(suggestion.relation)} · ${Math.round(
          suggestion.confidence * 100,
        )}%`,
      ),
    });
    review.createEl('p', { text: suggestion.reason });
    review.createEl('p', {
      cls: 'vs-relation-pending',
      text: tr(
        '状态：仅建议，尚未写入工件',
        'Status: suggestion only, not written to the artifact',
      ),
    });
    const reviewButton = review.createEl('button', {
      text: tr('审阅这条建议', 'Review this suggestion'),
    });
    reviewButton.onclick = () => {
      reviewButton.disabled = true;
      const gate = review.createDiv({ cls: 'vs-relation-confirm-gate' });
      gate.createEl('p', {
        text: tr(
          `确认后才会把“${relationLabel(
            suggestion.relation,
          )}”写入来源工件的 related_notes。是否确认？`,
          `"${relationLabel(
            suggestion.relation,
          )}" will be written to the source artifact's related_notes only after you confirm. Confirm?`,
        ),
      });
      const confirm = gate.createEl('button', {
        text: tr('确认写入关系', 'Confirm and write'),
        cls: 'mod-cta',
      });
      const cancel = gate.createEl('button', { text: tr('取消', 'Cancel') });
      cancel.onclick = () => {
        gate.remove();
        reviewButton.disabled = false;
      };
      confirm.onclick = async () => {
        confirm.disabled = true;
        cancel.disabled = true;
        try {
          await applyReviewedRelationSuggestion(this.plugin.artifactStore, suggestion, true);
          gate.setText(
            tr('已确认并原子写入 related_notes。', 'Confirmed and written to related_notes.'),
          );
          const pending = review.querySelector('.vs-relation-pending');
          if (pending)
            pending.textContent = tr(
              '状态：已由用户确认并写入',
              'Status: confirmed by you and written',
            );
        } catch (error) {
          gate.setText(tr(`写入失败：${messageOf(error)}`, `Could not write: ${messageOf(error)}`));
          reviewButton.disabled = false;
        }
      };
    };
  }

  private renderClaimLab(): void {
    if (this.artifacts.length < 2) {
      this.contentEl.createEl('p', {
        cls: 'vs-knowledge-lab-empty',
        text: tr(
          '至少需要两个持久化工件。请先处理更多视频。',
          'At least two saved artifacts are needed. Process more videos first.',
        ),
      });
      return;
    }

    const toolbar = this.contentEl.createDiv({ cls: 'vs-claim-lab-toolbar' });
    const title = labeledInput(toolbar, '实验室标题', '多视频论点实验室');
    const artifactSearch = labeledInput(toolbar, '筛选工件', '按标题、作者或平台过滤');
    const count = toolbar.createSpan({ cls: 'vs-claim-lab-count' });
    const list = this.contentEl.createDiv({ cls: 'vs-claim-lab-artifacts' });
    const selected = new Set<string>();

    const renderList = () => {
      list.empty();
      const keyword = artifactSearch.value.trim().toLocaleLowerCase();
      this.artifacts
        .filter((artifact) =>
          [artifact.title, artifact.author, artifact.platform, artifact.artifact_id]
            .filter(Boolean)
            .join(' ')
            .toLocaleLowerCase()
            .includes(keyword),
        )
        .forEach((artifact) => {
          const row = list.createEl('label', { cls: 'vs-claim-lab-artifact' });
          const checkbox = row.createEl('input', {
            attr: { type: 'checkbox', value: artifact.artifact_id },
          });
          checkbox.checked = selected.has(artifact.artifact_id);
          const copy = row.createDiv();
          copy.createEl('strong', { text: artifact.title || artifact.artifact_id });
          copy.createSpan({
            text: [
              artifact.author,
              artifact.platform,
              `${artifact.claims.length} 条主张`,
              `${artifact.segments.length} 个时间段`,
            ]
              .filter(Boolean)
              .join(' · '),
          });
          checkbox.onchange = () => {
            if (checkbox.checked) selected.add(artifact.artifact_id);
            else selected.delete(artifact.artifact_id);
            count.setText(
              tr(`已选择 ${selected.size} 个工件`, `${selected.size} artifacts selected`),
            );
          };
        });
    };
    renderList();
    count.setText(tr('已选择 0 个工件', '0 artifacts selected'));
    artifactSearch.addEventListener('input', renderList);

    const actions = this.contentEl.createDiv({ cls: 'vs-claim-lab-actions' });
    const generate = actions.createEl('button', {
      text: tr('生成 / 更新论点实验室', 'Build / update the claim lab'),
      cls: 'mod-cta',
    });
    const status = actions.createSpan();
    generate.onclick = async () => {
      if (selected.size < 2) {
        new Notice(tr('请至少选择两个持久化工件', 'Pick at least two saved artifacts'));
        return;
      }
      generate.disabled = true;
      status.setText(tr('正在生成本地证据矩阵…', 'Building the local evidence matrix…'));
      try {
        const artifacts = this.artifacts.filter((artifact) => selected.has(artifact.artifact_id));
        const report = buildClaimLabReport(artifacts, {
          title: title.value.trim() || undefined,
        });
        const file = await this.saveClaimLab(report.lab_id, report);
        status.setText(tr(`已保存：${file.path}`, `Saved: ${file.path}`));
        await this.app.workspace.getLeaf('tab').openFile(file);
        this.close();
      } catch (error) {
        status.setText(
          tr(`生成失败：${messageOf(error)}`, `Could not build it: ${messageOf(error)}`),
        );
        generate.disabled = false;
      }
    };
  }

  private async saveClaimLab(
    labId: string,
    report: ReturnType<typeof buildClaimLabReport>,
  ): Promise<TFile> {
    const baseFolder = normalizePath(
      `${this.plugin.settings.outputFolder || '视频总结'}/知识实验室`,
    );
    await ensureFolder(this.app, baseFolder);
    const selectionHash = stableTextHash(report.artifact_ids.join('|'));
    const path = normalizePath(
      `${baseFolder}/论点实验室-${selectionHash || labId.replace(/^claim-lab-/, '')}.md`,
    );
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing && !(existing instanceof TFile)) {
      throw new Error(`目标路径不是 Markdown 文件：${path}`);
    }
    const before = existing instanceof TFile ? await this.app.vault.read(existing) : '';
    const after = upsertClaimLabMarkdown(before, report);
    if (existing instanceof TFile) {
      if (after !== before) await this.app.vault.modify(existing, after);
      return existing;
    }
    return this.app.vault.create(path, after);
  }
}

async function ensureFolder(app: App, folderPath: string): Promise<void> {
  let current = '';
  for (const part of normalizePath(folderPath).split('/').filter(Boolean)) {
    current = current ? `${current}/${part}` : part;
    const existing = app.vault.getAbstractFileByPath(current);
    if (!existing) {
      await app.vault.createFolder(current);
    } else if (!(existing instanceof TFolder)) {
      throw new Error(`无法创建文件夹，路径已被文件占用：${current}`);
    }
  }
}

function labeledInput(
  container: HTMLElement,
  label: string,
  placeholder: string,
  type = 'text',
): HTMLInputElement {
  const wrapper = container.createEl('label', { cls: 'vs-knowledge-field' });
  wrapper.createSpan({ text: label });
  return wrapper.createEl('input', {
    attr: { type, placeholder, 'aria-label': label },
  });
}

function labeledSelect(
  container: HTMLElement,
  label: string,
  values: readonly string[],
): HTMLSelectElement {
  const wrapper = container.createEl('label', { cls: 'vs-knowledge-field' });
  wrapper.createSpan({ text: label });
  const select = wrapper.createEl('select', { attr: { 'aria-label': label } });
  values.forEach((value) => {
    select.createEl('option', {
      value,
      text: value || tr('全部', 'All'),
    });
  });
  return select;
}

function renderHighlightedText(
  element: HTMLElement,
  text: string,
  rawRanges: readonly TextHighlightRange[],
): void {
  const ranges = rawRanges
    .map((range) => ({
      start: Math.max(0, Math.min(text.length, range.start)),
      end: Math.max(0, Math.min(text.length, range.end)),
    }))
    .filter((range) => range.end > range.start)
    .sort((left, right) => left.start - right.start);
  let cursor = 0;
  ranges.forEach((range) => {
    if (range.start > cursor) element.appendText(text.slice(cursor, range.start));
    const mark = element.createEl('mark');
    mark.setText(text.slice(range.start, range.end));
    cursor = Math.max(cursor, range.end);
  });
  if (cursor < text.length) element.appendText(text.slice(cursor));
}

function relationLabel(relation: ArtifactRelationSuggestion['relation']): string {
  const labels: Record<ArtifactRelationSuggestion['relation'], string> = {
    supplement: '补充 supplement',
    repeat: '重复 repeat',
    conflict: '冲突 conflict',
    update: '更新 update',
    related: '相关 related',
  };
  return labels[relation];
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.map((value) => value?.trim()).filter(Boolean) as string[])).sort(
    (left, right) => left.localeCompare(right),
  );
}

function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? errorMessage(error) : String(error);
}
