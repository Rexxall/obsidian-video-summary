import { App, Modal, Notice, TFile } from 'obsidian';
import type { VideoKnowledgeArtifact } from '../types';
import {
  LearningArtifactItem,
  LearningConfidence,
  LearningEvidenceTarget,
  LearningProgressItem,
  LearningProgressSidecar,
  LearningProgressStore,
  LearningReviewState,
  learningItemKey,
  learningItemsFromArtifact,
  learningReviewState,
  resolveLearningEvidence,
} from '../core/LearningProgressStore';
import { formatTimestamp } from '../core/KnowledgeModel';
import { safeExternalHttpUrl } from '../utils/SafeExternalUrl';

import { fire } from '../utils/fire';
import { errorMessage } from '../utils/errors';
import { tr } from '../utils/i18n';
export type LearningReviewMode = 'due' | 'mistakes' | 'all';

export interface LearningReviewModalOptions {
  store: LearningProgressStore;
  artifact: VideoKnowledgeArtifact;
  mode?: LearningReviewMode;
  now?: () => Date;
  /**
   * The host view can seek its synchronized reader. Without a host callback,
   * external timestamp URLs still open directly.
   */
  onOpenEvidence?: (
    artifact: VideoKnowledgeArtifact,
    target: LearningEvidenceTarget,
  ) => void | Promise<void>;
  /** Optional continuation used by the cross-video due-review queue. */
  onContinue?: () => void | Promise<void>;
  continueLabel?: string;
}

interface AnswerResult {
  item: LearningArtifactItem;
  progress: LearningProgressItem;
  correct: boolean;
}

/**
 * A review-only UI over LearningProgressStore. Answers are persisted to the
 * learning sidecar; this modal intentionally has no Markdown write API.
 */
export class LearningReviewModal extends Modal {
  private readonly options: LearningReviewModalOptions;
  private readonly now: () => Date;
  private mode: LearningReviewMode;
  private queue: LearningArtifactItem[] = [];
  private currentIndex = 0;
  private sidecar?: LearningProgressSidecar;
  private result?: AnswerResult;
  private revealed = false;
  private selectedAnswer = '';
  private confidence: LearningConfidence = 3;
  private readonly completedKeys = new Set<string>();
  private refreshSequence = 0;

  constructor(app: App, options: LearningReviewModalOptions) {
    super(app);
    this.options = options;
    this.mode = options.mode || 'due';
    this.now = options.now || (() => new Date());
  }

  onOpen(): void {
    this.modalEl.addClass('ap', 'ap-modal');
    this.setTitle(tr('视频学习复习', 'Video learning review'));
    this.contentEl.addClass('vs-modal', 'vs-learning-review-modal');
    this.renderLoading();
    void this.refreshQueue();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private renderLoading(): void {
    this.contentEl.empty();
    this.contentEl.createDiv({
      text: tr('正在读取本地复习进度…', 'Reading local review progress…'),
      cls: 'vs-hint',
    });
  }

  private async refreshQueue(): Promise<void> {
    const sequence = (this.refreshSequence += 1);
    try {
      const sidecar = await this.options.store.getArtifactProgress(
        this.options.artifact.artifact_id,
      );
      if (sequence !== this.refreshSequence) return;
      this.sidecar = sidecar;
      this.queue = selectReviewItems(
        learningItemsFromArtifact(this.options.artifact),
        sidecar,
        this.mode,
        this.now(),
      ).filter((item) => !this.completedKeys.has(learningItemKey(item.item_kind, item.item_id)));
      this.currentIndex = 0;
      this.result = undefined;
      this.revealed = false;
      this.selectedAnswer = '';
      this.render();
    } catch (error) {
      if (sequence !== this.refreshSequence) return;
      this.contentEl.empty();
      this.contentEl.createEl('h3', {
        text: tr('无法读取复习进度', 'Cannot read the review progress'),
      });
      this.contentEl.createDiv({
        text: error instanceof Error ? errorMessage(error) : String(error),
        cls: 'vs-hint is-error',
      });
    }
  }

  private render(): void {
    this.contentEl.empty();
    this.renderToolbar();

    const allItems = learningItemsFromArtifact(this.options.artifact);
    if (allItems.length === 0) {
      this.contentEl.createEl('h3', {
        text: tr('这份视频还没有学习卡片', 'This video has no learning cards yet'),
      });
      this.contentEl.createDiv({
        text: tr(
          '重新处理时开启“学习练习”后，再回到这里复习。',
          'Turn on "Learning exercises" when processing again, then come back here.',
        ),
        cls: 'vs-hint',
      });
      return;
    }

    const item = this.queue[this.currentIndex];
    if (!item) {
      this.contentEl.createEl('h3', {
        text:
          this.mode === 'due'
            ? tr('当前没有到期复习', 'Nothing due right now')
            : tr('这个列表已经复习完了', 'This list is done'),
      });
      if (this.mode === 'mistakes') {
        this.contentEl.createDiv({
          text: tr('错题到期后会出现在“到期”列表里。', 'Wrong answers come back in the due list.'),
          cls: 'vs-hint',
        });
      }
      if (this.options.onContinue) {
        const next = this.contentEl.createEl('button', {
          text: this.options.continueLabel || tr('继续下一个视频', 'Next video'),
          cls: 'mod-cta',
          attr: { type: 'button' },
        });
        next.addEventListener('click', () => {
          this.close();
          void this.options.onContinue?.();
        });
      }
      return;
    }

    this.contentEl.createDiv({
      text: `${this.currentIndex + 1} / ${this.queue.length}`,
      cls: 'vs-learning-review-count',
    });
    const card = this.contentEl.createDiv({ cls: 'vs-learning-review-card' });
    card.createDiv({
      text: item.item_kind === 'flashcard' ? tr('闪卡', 'Flashcards') : tr('自测题', 'Quiz'),
      cls: 'vs-learning-review-kind',
    });
    card.createEl('h3', { text: item.prompt });

    if (this.result) {
      this.renderResult(card, this.result);
      return;
    }
    if (item.item_kind === 'flashcard') {
      this.renderFlashcard(card, item);
    } else {
      this.renderQuestion(card, item);
    }
  }

  private renderToolbar(): void {
    const toolbar = this.contentEl.createDiv({ cls: 'vs-learning-review-toolbar' });
    const modes: Array<[LearningReviewMode, string]> = [
      ['due', tr('到期', 'Due')],
      ['mistakes', tr('错题', 'Mistakes')],
      ['all', tr('全部', 'All')],
    ];
    modes.forEach(([mode, label]) => {
      const button = toolbar.createEl('button', {
        text: label,
        cls: `vs-chip${this.mode === mode ? ' is-active' : ''}`,
        attr: { type: 'button' },
      });
      button.addEventListener('click', () => {
        if (this.mode === mode) return;
        this.mode = mode;
        this.completedKeys.clear();
        this.renderLoading();
        void this.refreshQueue();
      });
    });
  }

  private renderFlashcard(container: HTMLElement, item: LearningArtifactItem): void {
    if (!this.revealed) {
      const reveal = container.createEl('button', {
        text: tr('显示答案', 'Show answer'),
        cls: 'mod-cta',
        attr: { type: 'button' },
      });
      reveal.addEventListener('click', () => {
        this.revealed = true;
        this.render();
      });
      return;
    }

    container.createDiv({ text: item.answer, cls: 'vs-learning-review-answer' });
    this.renderConfidence(container);
    const actions = container.createDiv({ cls: 'vs-learning-review-actions' });
    const wrong = actions.createEl('button', {
      text: tr('记错了', 'Got it wrong'),
      attr: { type: 'button' },
    });
    const correct = actions.createEl('button', {
      text: tr('记对了', 'Got it right'),
      cls: 'mod-cta',
      attr: { type: 'button' },
    });
    wrong.addEventListener('click', () => void this.record(item, item.answer, false));
    correct.addEventListener('click', () => void this.record(item, item.answer, true));
  }

  private renderQuestion(container: HTMLElement, item: LearningArtifactItem): void {
    if (item.choices?.length) {
      const choices = container.createDiv({ cls: 'vs-learning-review-choices' });
      item.choices.forEach((choice) => {
        const label = choices.createEl('label', { cls: 'vs-learning-review-choice' });
        const input = label.createEl('input', {
          attr: {
            type: 'radio',
            name: `learning-${item.item_id}`,
            value: choice,
          },
        });
        input.checked = this.selectedAnswer === choice;
        input.addEventListener('change', () => {
          this.selectedAnswer = choice;
        });
        label.createSpan({ text: choice });
      });
    } else {
      const input = container.createEl('textarea', {
        cls: 'vs-learning-review-textarea',
        attr: { placeholder: tr('写下你的答案…', 'Write your answer…'), rows: '4' },
      });
      input.value = this.selectedAnswer;
      input.addEventListener('input', () => {
        this.selectedAnswer = input.value;
      });
    }
    this.renderConfidence(container);
    const submit = container.createEl('button', {
      text: tr('提交答案', 'Submit answer'),
      cls: 'mod-cta',
      attr: { type: 'button' },
    });
    submit.addEventListener('click', () => {
      const answer = this.selectedAnswer.trim();
      if (!answer) {
        new Notice(tr('请先选择或填写答案', 'Pick or write an answer first'));
        return;
      }
      void this.record(item, answer, answersMatch(answer, item.answer));
    });
  }

  private renderConfidence(container: HTMLElement): void {
    const row = container.createEl('label', { cls: 'vs-learning-review-confidence' });
    row.createSpan({ text: tr('把握程度', 'Confidence') });
    const select = row.createEl('select');
    const labels = [
      tr('1 · 完全没把握', '1 · No idea'),
      tr('2 · 比较犹豫', '2 · Unsure'),
      tr('3 · 一般', '3 · So-so'),
      tr('4 · 有把握', '4 · Fairly sure'),
      tr('5 · 非常确定', '5 · Certain'),
    ];
    labels.forEach((label, index) => {
      const confidence = (index + 1) as LearningConfidence;
      const option = select.createEl('option', {
        text: label,
        value: String(confidence),
      });
      option.selected = confidence === this.confidence;
    });
    select.addEventListener('change', () => {
      this.confidence = Number(select.value) as LearningConfidence;
    });
  }

  private async record(
    item: LearningArtifactItem,
    answer: string,
    correct: boolean,
  ): Promise<void> {
    try {
      const progress = await this.options.store.recordAttempt({
        artifact_id: item.artifact_id,
        item_id: item.item_id,
        item_kind: item.item_kind,
        answer,
        correct,
        confidence: this.confidence,
        attempted_at: this.now().toISOString(),
      });
      await this.syncNoteReviewDue();
      this.result = { item, progress, correct };
      this.completedKeys.add(learningItemKey(item.item_kind, item.item_id));
      this.render();
    } catch (error) {
      new Notice(error instanceof Error ? errorMessage(error) : String(error));
    }
  }

  private renderResult(container: HTMLElement, result: AnswerResult): void {
    container.createEl('h4', {
      text: result.correct ? tr('回答正确', 'Correct') : tr('回答错误', 'Incorrect'),
      cls: result.correct ? 'is-success' : 'is-error',
    });
    container.createDiv({
      text: tr(`标准答案：${result.item.answer}`, `Answer: ${result.item.answer}`),
      cls: 'vs-learning-review-answer',
    });
    if (result.item.explanation) {
      container.createDiv({
        text: tr(`解释：${result.item.explanation}`, `Explanation: ${result.item.explanation}`),
        cls: 'vs-learning-review-explanation',
      });
    }
    const state = learningReviewState(result.progress, this.now());
    container.createDiv({
      text: progressMessage(result.progress, state),
      cls: 'vs-hint',
    });
    this.renderEvidence(container, result.item);

    const actions = container.createDiv({ cls: 'vs-learning-review-actions' });
    const suspend = actions.createEl('button', {
      text: tr('暂停这道题', 'Pause this question'),
      attr: { type: 'button' },
    });
    suspend.addEventListener(
      'click',
      fire(async () => {
        await this.options.store.setSuspended(
          result.item.artifact_id,
          result.item.item_kind,
          result.item.item_id,
          true,
        );
        await this.syncNoteReviewDue();
        await this.refreshQueue();
      }),
    );
    const next = actions.createEl('button', {
      text: tr('下一题', 'Next question'),
      cls: 'mod-cta',
      attr: { type: 'button' },
    });
    next.addEventListener('click', () => {
      this.renderLoading();
      void this.refreshQueue();
    });
  }

  private async syncNoteReviewDue(): Promise<void> {
    const path = this.options.artifact.source.note_path;
    if (!path) return;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    const sidecar = await this.options.store.getArtifactProgress(this.options.artifact.artifact_id);
    const currentItems = learningItemsFromArtifact(this.options.artifact);
    const progressByKey = sidecar?.items || {};
    const hasUnreviewed = currentItems.some(
      (item) => !progressByKey[learningItemKey(item.item_kind, item.item_id)],
    );
    const nextDue = hasUnreviewed
      ? this.now().toISOString()
      : currentItems
          .map((item) => progressByKey[learningItemKey(item.item_kind, item.item_id)])
          .filter((item): item is LearningProgressItem => Boolean(item && !item.suspended))
          .map((item) => item.due_at)
          .filter(Boolean)
          .sort()[0];
    const learningItems = currentItems.length;
    await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
      frontmatter.video_review_due = nextDue || null;
      frontmatter.video_learning_items = learningItems;
    });
  }

  private renderEvidence(container: HTMLElement, item: LearningArtifactItem): void {
    const evidence = resolveLearningEvidence(this.options.artifact, item);
    const section = container.createDiv({ cls: 'vs-learning-review-evidence' });
    section.createEl('h4', { text: tr('回到证据', 'Back to the evidence') });
    if (evidence.message) section.createDiv({ text: evidence.message, cls: 'vs-hint is-warning' });
    evidence.targets.forEach((target) => {
      const row = section.createDiv({
        cls: `vs-learning-review-evidence-row is-${target.status}`,
      });
      const label =
        target.status === 'available'
          ? formatTimestamp(target.start)
          : target.status === 'untimed'
            ? tr('无时间点', 'No timestamp')
            : tr('证据缺失', 'Evidence missing');
      row.createSpan({ text: label, cls: 'vs-learning-review-evidence-time' });
      row.createSpan({
        text: target.text || target.message,
        cls: 'vs-learning-review-evidence-copy',
      });
      if (target.status === 'available') {
        const open = row.createEl('button', {
          text: tr('定位', 'Locate'),
          attr: { type: 'button' },
        });
        open.addEventListener('click', () => void this.openEvidence(target));
      } else {
        row.createDiv({ text: target.message, cls: 'vs-hint is-warning' });
      }
    });
    if (evidence.targets.length === 0) {
      section.createDiv({
        text: evidence.message || tr('没有可验证的证据引用。', 'No verifiable evidence reference.'),
        cls: 'vs-hint is-warning',
      });
    }
  }

  private async openEvidence(target: LearningEvidenceTarget): Promise<void> {
    if (this.options.onOpenEvidence) {
      await this.options.onOpenEvidence(this.options.artifact, target);
      return;
    }
    const externalUrl = safeExternalHttpUrl(target.timestamp_url);
    if (externalUrl) {
      window.open(externalUrl, '_blank', 'noopener,noreferrer');
      return;
    }
    new Notice(
      tr(
        '证据有时间点，但当前入口没有播放器定位回调',
        'The evidence has a timestamp, but this view cannot move the player',
      ),
    );
  }
}

export function selectReviewItems(
  items: LearningArtifactItem[],
  sidecar: LearningProgressSidecar | undefined,
  mode: LearningReviewMode,
  at: Date,
): LearningArtifactItem[] {
  const getProgress = (item: LearningArtifactItem) =>
    sidecar?.items[learningItemKey(item.item_kind, item.item_id)];
  return items
    .filter((item) => {
      const progress = getProgress(item);
      if (progress?.suspended) return false;
      if (mode === 'all') return true;
      if (mode === 'mistakes') {
        const last = progress?.attempts[progress.attempts.length - 1];
        return last?.correct === false;
      }
      return !progress || learningReviewState(progress, at) === 'due';
    })
    .sort((left, right) => {
      const leftProgress = getProgress(left);
      const rightProgress = getProgress(right);
      const leftDue = leftProgress?.due_at || '';
      const rightDue = rightProgress?.due_at || '';
      return leftDue.localeCompare(rightDue) || left.item_id.localeCompare(right.item_id);
    });
}

export function answersMatch(actual: string, expected: string): boolean {
  return normalizeAnswer(actual) === normalizeAnswer(expected);
}

function normalizeAnswer(value: string): string {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .replace(/^[A-HＡ-Ｈ][.、:：)\]]\s*/i, '')
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase();
}

function progressMessage(progress: LearningProgressItem, state: LearningReviewState): string {
  const due = new Date(progress.due_at).toLocaleString();
  if (state === 'suspended') return tr('这道题已暂停。', 'This question is paused.');
  const mastery =
    progress.mastery === 'mastered' ? tr('已掌握', 'Mastered') : tr('学习中', 'Learning');
  return tr(
    `${mastery} · 连续答对 ${progress.consecutive_correct} 次 · 下次 ${due}`,
    `${mastery} · right ${progress.consecutive_correct} times in a row · next ${due}`,
  );
}
