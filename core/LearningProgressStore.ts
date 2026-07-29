import type { DataAdapter, ListedFiles } from 'obsidian';
import type { LearningCard, QuizQuestion, VideoKnowledgeArtifact, VideoSegment } from '../types';
import { buildTimestampUrl, stableHash } from './KnowledgeModel';

export const LEARNING_PROGRESS_SCHEMA_VERSION = 1;

const LEARNING_FILE_SUFFIX = '.learning.json';
const SAFE_ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/;
const MAX_INTERVAL_SECONDS = 180 * 24 * 60 * 60;

/**
 * The scheduler is deliberately small and inspectable. It is not an opaque
 * "AI score": an incorrect answer or low confidence always returns sooner,
 * while repeated confident correct answers expand the interval.
 */
export const LEARNING_SCHEDULER_POLICY = Object.freeze({
  version: 1,
  incorrectLowConfidenceSeconds: 5 * 60,
  incorrectSeconds: 15 * 60,
  correctLowConfidenceSeconds: Object.freeze({
    1: 30 * 60,
    2: 6 * 60 * 60,
  }),
  firstCorrectDays: Object.freeze({
    3: 1,
    4: 2,
    5: 4,
  }),
  confidentGrowth: Object.freeze({
    3: 1.8,
    4: 2.2,
    5: 2.8,
  }),
  masteryCorrectStreak: 3,
  maxIntervalDays: MAX_INTERVAL_SECONDS / 86_400,
});

export type LearningItemKind = 'flashcard' | 'question';
export type LearningConfidence = 1 | 2 | 3 | 4 | 5;
export type LearningMastery = 'new' | 'learning' | 'mastered';
export type LearningReviewState = 'due' | 'scheduled' | 'mastered' | 'suspended';

export interface LearningAttempt {
  id: string;
  answer: string;
  correct: boolean;
  confidence: LearningConfidence;
  attempted_at: string;
}

export interface LearningProgressItem {
  key: string;
  artifact_id: string;
  item_id: string;
  item_kind: LearningItemKind;
  attempts: LearningAttempt[];
  total_attempts: number;
  total_correct: number;
  consecutive_correct: number;
  interval_seconds: number;
  due_at: string;
  mastery: LearningMastery;
  suspended: boolean;
  created_at: string;
  updated_at: string;
}

export interface LearningProgressSidecar {
  schema_version: number;
  artifact_id: string;
  items: Record<string, LearningProgressItem>;
  created_at: string;
  updated_at: string;
}

export interface RecordLearningAttemptInput {
  artifact_id: string;
  item_id: string;
  item_kind: LearningItemKind;
  answer: string;
  correct: boolean;
  confidence: LearningConfidence;
  attempted_at?: string;
}

export interface LearningScheduleInput {
  artifact_id: string;
  item_id: string;
  item_kind: LearningItemKind;
  answer: string;
  correct: boolean;
  confidence: LearningConfidence;
  attempted_at: string;
}

export type LearningProgressAdapter = Pick<
  DataAdapter,
  'exists' | 'list' | 'read' | 'write' | 'mkdir' | 'remove' | 'rename'
> & {
  process?: DataAdapter['process'];
};

export interface LearningProgressStoreOptions {
  now?: () => Date;
}

export interface LearningArtifactItem {
  artifact_id: string;
  item_id: string;
  item_kind: LearningItemKind;
  prompt: string;
  answer: string;
  choices?: string[];
  explanation?: string;
  evidence_segment_ids: string[];
  tags?: string[];
  difficulty?: QuizQuestion['difficulty'];
}

export type LearningEvidenceStatus = 'available' | 'untimed' | 'missing';

export interface LearningEvidenceTarget {
  segment_id: string;
  status: LearningEvidenceStatus;
  start: number | null;
  end?: number | null;
  text?: string;
  timing_quality?: VideoSegment['timing_quality'];
  timestamp_url?: string;
  message: string;
}

export interface LearningEvidenceResolution {
  targets: LearningEvidenceTarget[];
  available: number;
  missing: number;
  message?: string;
}

export class LearningProgressValidationError extends Error {
  constructor(message: string) {
    super(`Learning progress validation failed: ${message}`);
    this.name = 'LearningProgressValidationError';
  }
}

/**
 * Local, restart-safe learning state. The store writes only plugin sidecars;
 * it never changes a user's Markdown note.
 */
export class LearningProgressStore {
  private readonly adapter: LearningProgressAdapter;
  private readonly rootPath: string;
  private readonly now: () => Date;
  private readonly locks = new Map<string, Promise<unknown>>();
  private tempSequence = 0;

  constructor(
    adapter: LearningProgressAdapter,
    rootPath: string,
    options: LearningProgressStoreOptions = {},
  ) {
    this.adapter = adapter;
    this.rootPath = normalizeAdapterPath(rootPath);
    if (!this.rootPath) throw new Error('LearningProgressStore rootPath must not be empty');
    this.now = options.now || (() => new Date());
  }

  async recordAttempt(input: RecordLearningAttemptInput): Promise<LearningProgressItem> {
    validateAttemptInput(input);
    const artifactId = normalizeArtifactId(input.artifact_id);
    const path = this.pathFor(artifactId);
    return this.withLock(path, async () => {
      const timestamp = normalizeIso(input.attempted_at, this.now());
      const current = await this.loadOrCreate(artifactId, new Date(timestamp));
      const key = learningItemKey(input.item_kind, input.item_id);
      const previous = current.items[key];
      const scheduled = scheduleLearningAttempt(previous, {
        artifact_id: artifactId,
        item_id: input.item_id.trim(),
        item_kind: input.item_kind,
        answer: input.answer,
        correct: input.correct,
        confidence: input.confidence,
        attempted_at: timestamp,
      });
      const next: LearningProgressSidecar = {
        ...current,
        items: { ...current.items, [key]: scheduled },
        updated_at: timestamp,
      };
      validateLearningProgressSidecar(next, artifactId);
      await this.ensureRoot();
      await this.atomicWrite(path, serialize(next));
      return clone(scheduled);
    });
  }

  async getItem(
    artifactId: string,
    itemKind: LearningItemKind,
    itemId: string,
  ): Promise<LearningProgressItem | undefined> {
    const sidecar = await this.load(artifactId);
    const item = sidecar?.items[learningItemKey(itemKind, itemId)];
    return item ? clone(item) : undefined;
  }

  async getArtifactProgress(artifactId: string): Promise<LearningProgressSidecar | undefined> {
    return this.load(artifactId);
  }

  async list(): Promise<LearningProgressSidecar[]> {
    if (!(await this.adapter.exists(this.rootPath))) return [];
    const listing = await this.adapter.list(this.rootPath);
    const ids = learningArtifactIdsFromListing(listing, this.rootPath);
    const sidecars: LearningProgressSidecar[] = [];
    for (const artifactId of ids) {
      const loaded = await this.load(artifactId);
      if (loaded) sidecars.push(loaded);
    }
    return sidecars.sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  }

  async listDue(at = this.now()): Promise<LearningProgressItem[]> {
    const sidecars = await this.list();
    return sidecars
      .flatMap((sidecar) => Object.values(sidecar.items))
      .filter((item) => learningReviewState(item, at) === 'due')
      .sort((left, right) => {
        const byDue = left.due_at.localeCompare(right.due_at);
        return byDue || left.key.localeCompare(right.key);
      })
      .map(clone);
  }

  async setSuspended(
    artifactId: string,
    itemKind: LearningItemKind,
    itemId: string,
    suspended: boolean,
  ): Promise<LearningProgressItem | undefined> {
    const normalizedArtifactId = normalizeArtifactId(artifactId);
    const path = this.pathFor(normalizedArtifactId);
    return this.withLock(path, async () => {
      const current = await this.load(normalizedArtifactId);
      if (!current) return undefined;
      const key = learningItemKey(itemKind, itemId);
      const existing = current.items[key];
      if (!existing) return undefined;
      const updatedAt = this.now().toISOString();
      const updated: LearningProgressItem = {
        ...existing,
        suspended,
        updated_at: updatedAt,
      };
      const next: LearningProgressSidecar = {
        ...current,
        items: { ...current.items, [key]: updated },
        updated_at: updatedAt,
      };
      validateLearningProgressSidecar(next, normalizedArtifactId);
      await this.atomicWrite(path, serialize(next));
      return clone(updated);
    });
  }

  private async load(artifactId: string): Promise<LearningProgressSidecar | undefined> {
    const normalized = normalizeArtifactId(artifactId);
    const path = this.pathFor(normalized);
    if (!(await this.adapter.exists(path))) return undefined;
    let raw: unknown;
    try {
      raw = JSON.parse(await this.adapter.read(path));
    } catch (error) {
      throw new LearningProgressValidationError(
        `invalid JSON for ${normalized} (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    validateLearningProgressSidecar(raw, normalized);
    return clone(raw);
  }

  private async loadOrCreate(artifactId: string, at: Date): Promise<LearningProgressSidecar> {
    const existing = await this.load(artifactId);
    if (existing) return existing;
    const timestamp = at.toISOString();
    return {
      schema_version: LEARNING_PROGRESS_SCHEMA_VERSION,
      artifact_id: artifactId,
      items: {},
      created_at: timestamp,
      updated_at: timestamp,
    };
  }

  private pathFor(artifactId: string): string {
    return `${this.rootPath}/${normalizeArtifactId(artifactId)}${LEARNING_FILE_SUFFIX}`;
  }

  private async ensureRoot(): Promise<void> {
    const parts = this.rootPath.split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (await this.adapter.exists(current)) continue;
      try {
        await this.adapter.mkdir(current);
      } catch (error) {
        if (!(await this.adapter.exists(current))) throw error;
      }
    }
  }

  private async atomicWrite(path: string, data: string): Promise<void> {
    if (await this.adapter.exists(path)) {
      if (this.adapter.process) {
        await this.adapter.process(path, () => data);
        return;
      }
      await this.replaceWithRename(path, data);
      return;
    }

    const tempPath = this.tempPath(path);
    try {
      await this.adapter.write(tempPath, data);
      await this.adapter.rename(tempPath, path);
    } catch (error) {
      await this.removeIfExists(tempPath);
      if (await this.adapter.exists(path)) {
        if (this.adapter.process) {
          await this.adapter.process(path, () => data);
          return;
        }
        await this.replaceWithRename(path, data);
        return;
      }
      throw error;
    }
  }

  private async replaceWithRename(path: string, data: string): Promise<void> {
    const tempPath = this.tempPath(path);
    const backupPath = `${path}.bak`;
    await this.removeIfExists(tempPath);
    await this.removeIfExists(backupPath);
    await this.adapter.write(tempPath, data);
    let backedUp = false;
    try {
      if (await this.adapter.exists(path)) {
        await this.adapter.rename(path, backupPath);
        backedUp = true;
      }
      await this.adapter.rename(tempPath, path);
      if (backedUp) await this.removeIfExists(backupPath);
    } catch (error) {
      await this.removeIfExists(tempPath);
      if (
        backedUp &&
        !(await this.adapter.exists(path)) &&
        (await this.adapter.exists(backupPath))
      ) {
        await this.adapter.rename(backupPath, path);
      }
      throw error;
    }
  }

  private tempPath(path: string): string {
    this.tempSequence += 1;
    return `${path}.tmp-${Date.now().toString(36)}-${this.tempSequence.toString(36)}`;
  }

  private async removeIfExists(path: string): Promise<void> {
    if (await this.adapter.exists(path)) await this.adapter.remove(path);
  }

  private async withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) || Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.locks.set(key, current);
    try {
      return await current;
    } finally {
      if (this.locks.get(key) === current) this.locks.delete(key);
    }
  }
}

export function learningItemKey(itemKind: LearningItemKind, itemId: string): string {
  const normalized = String(itemId || '').trim();
  if (!normalized) throw new LearningProgressValidationError('item_id must not be empty');
  if (itemKind !== 'flashcard' && itemKind !== 'question') {
    throw new LearningProgressValidationError(`unsupported item_kind ${String(itemKind)}`);
  }
  return `${itemKind}:${normalized}`;
}

export function scheduleLearningAttempt(
  previous: LearningProgressItem | undefined,
  input: LearningScheduleInput,
): LearningProgressItem {
  validateAttemptInput(input);
  const attemptedAt = normalizeIso(input.attempted_at, new Date());
  const attemptedDate = new Date(attemptedAt);
  const key = learningItemKey(input.item_kind, input.item_id);
  if (previous && previous.key !== key) {
    throw new LearningProgressValidationError('previous progress belongs to a different item');
  }
  if (previous && previous.artifact_id !== input.artifact_id) {
    throw new LearningProgressValidationError('previous progress belongs to a different artifact');
  }

  const consecutiveCorrect = input.correct ? (previous?.consecutive_correct || 0) + 1 : 0;
  const intervalSeconds = nextIntervalSeconds(previous, input);
  const dueAt = new Date(attemptedDate.getTime() + intervalSeconds * 1000).toISOString();
  const mastery: LearningMastery =
    input.correct &&
    input.confidence >= 3 &&
    consecutiveCorrect >= LEARNING_SCHEDULER_POLICY.masteryCorrectStreak
      ? 'mastered'
      : 'learning';
  const attempts = previous?.attempts ? previous.attempts.map(clone) : [];
  const attempt: LearningAttempt = {
    id: `attempt-${stableHash(`${key}|${attemptedAt}|${attempts.length}`)}`,
    answer: String(input.answer ?? ''),
    correct: input.correct,
    confidence: input.confidence,
    attempted_at: attemptedAt,
  };
  attempts.push(attempt);

  return {
    key,
    artifact_id: normalizeArtifactId(input.artifact_id),
    item_id: input.item_id.trim(),
    item_kind: input.item_kind,
    attempts,
    total_attempts: attempts.length,
    total_correct: (previous?.total_correct || 0) + (input.correct ? 1 : 0),
    consecutive_correct: consecutiveCorrect,
    interval_seconds: intervalSeconds,
    due_at: dueAt,
    mastery,
    suspended: previous?.suspended === true,
    created_at: previous?.created_at || attemptedAt,
    updated_at: attemptedAt,
  };
}

export function learningReviewState(
  item: LearningProgressItem,
  at: Date | string = new Date(),
): LearningReviewState {
  if (item.suspended) return 'suspended';
  const timestamp = typeof at === 'string' ? Date.parse(at) : at.getTime();
  if (!Number.isFinite(timestamp)) {
    throw new LearningProgressValidationError('review time must be a valid date');
  }
  if (Date.parse(item.due_at) <= timestamp) return 'due';
  return item.mastery === 'mastered' ? 'mastered' : 'scheduled';
}

export function learningItemsFromArtifact(
  artifact: VideoKnowledgeArtifact,
): LearningArtifactItem[] {
  const artifactId = normalizeArtifactId(artifact.artifact_id);
  const cards = (artifact.learning?.flashcards || []).map((card: LearningCard) => ({
    artifact_id: artifactId,
    item_id: card.id,
    item_kind: 'flashcard' as const,
    prompt: card.front,
    answer: card.back,
    evidence_segment_ids: uniqueStrings(card.evidence_segment_ids),
    tags: uniqueStrings(card.tags),
  }));
  const questions = (artifact.learning?.questions || []).map((question: QuizQuestion) => ({
    artifact_id: artifactId,
    item_id: question.id,
    item_kind: 'question' as const,
    prompt: question.prompt,
    answer: question.answer,
    choices: uniqueStrings(question.choices),
    explanation: question.explanation,
    evidence_segment_ids: uniqueStrings(question.evidence_segment_ids),
    difficulty: question.difficulty,
  }));
  return [...cards, ...questions].filter(
    (item) => item.item_id.trim() && item.prompt.trim() && item.answer.trim(),
  );
}

/**
 * Resolve only references that really exist in the artifact. Missing or
 * untimed evidence remains explicit; no timestamp is guessed.
 */
export function resolveLearningEvidence(
  artifact: VideoKnowledgeArtifact,
  item: Pick<LearningArtifactItem, 'evidence_segment_ids'>,
): LearningEvidenceResolution {
  const segmentById = new Map(artifact.segments.map((segment) => [segment.id, segment]));
  if (item.evidence_segment_ids.length === 0) {
    return {
      targets: [],
      available: 0,
      missing: 1,
      message: '这道题没有 evidence_segment_ids，无法回到原视频证据。',
    };
  }

  const targets = item.evidence_segment_ids.map((segmentId): LearningEvidenceTarget => {
    const segment = segmentById.get(segmentId);
    if (!segment) {
      return {
        segment_id: segmentId,
        status: 'missing',
        start: null,
        message: `证据段 ${segmentId} 已不存在，需重新生成或人工复核。`,
      };
    }
    if (
      segment.start === null ||
      !Number.isFinite(segment.start) ||
      segment.timing_quality === 'none'
    ) {
      return {
        segment_id: segmentId,
        status: 'untimed',
        start: segment.start,
        end: segment.end,
        text: segment.text,
        timing_quality: segment.timing_quality,
        message: '证据文本存在，但没有可靠时间点。',
      };
    }
    const timestampUrl =
      segment.timestamp_url || buildTimestampUrl(artifact.source.url || '', segment.start);
    return {
      segment_id: segmentId,
      status: 'available',
      start: segment.start,
      end: segment.end,
      text: segment.text,
      timing_quality: segment.timing_quality,
      timestamp_url: timestampUrl,
      message:
        segment.timing_quality === 'estimated'
          ? '证据段存在；时间点为估算值。'
          : '证据段和时间点均可用。',
    };
  });
  const available = targets.filter((target) => target.status === 'available').length;
  const missing = targets.filter((target) => target.status !== 'available').length;
  return {
    targets,
    available,
    missing,
    message: missing > 0 ? `${missing} 条证据无法直接定位，界面会明确标出。` : undefined,
  };
}

export function validateLearningProgressSidecar(
  raw: unknown,
  expectedArtifactId?: string,
): asserts raw is LearningProgressSidecar {
  if (!isRecord(raw)) throw new LearningProgressValidationError('sidecar must be an object');
  if (raw.schema_version !== LEARNING_PROGRESS_SCHEMA_VERSION) {
    throw new LearningProgressValidationError(
      `unsupported schema_version ${String(raw.schema_version)}`,
    );
  }
  const artifactId = normalizeArtifactId(String(raw.artifact_id || ''));
  if (expectedArtifactId && artifactId !== expectedArtifactId) {
    throw new LearningProgressValidationError('artifact_id does not match sidecar filename');
  }
  if (!isRecord(raw.items)) {
    throw new LearningProgressValidationError('items must be an object');
  }
  if (!isIso(raw.created_at) || !isIso(raw.updated_at)) {
    throw new LearningProgressValidationError('created_at and updated_at must be ISO dates');
  }

  for (const [key, value] of Object.entries(raw.items)) {
    if (!isRecord(value)) throw new LearningProgressValidationError(`items.${key} is invalid`);
    if (value.key !== key) {
      throw new LearningProgressValidationError(`items.${key}.key must match its map key`);
    }
    if (value.artifact_id !== artifactId) {
      throw new LearningProgressValidationError(`items.${key}.artifact_id must match sidecar`);
    }
    if (learningItemKey(value.item_kind as LearningItemKind, String(value.item_id || '')) !== key) {
      throw new LearningProgressValidationError(`items.${key} has an invalid identity`);
    }
    if (!Array.isArray(value.attempts)) {
      throw new LearningProgressValidationError(`items.${key}.attempts must be an array`);
    }
    if (value.total_attempts !== value.attempts.length) {
      throw new LearningProgressValidationError(`items.${key}.total_attempts is inconsistent`);
    }
    if (
      !Number.isInteger(value.total_correct) ||
      value.total_correct < 0 ||
      value.total_correct > value.total_attempts
    ) {
      throw new LearningProgressValidationError(`items.${key}.total_correct is invalid`);
    }
    if (!Number.isInteger(value.consecutive_correct) || value.consecutive_correct < 0) {
      throw new LearningProgressValidationError(`items.${key}.consecutive_correct is invalid`);
    }
    if (
      typeof value.interval_seconds !== 'number' ||
      !Number.isFinite(value.interval_seconds) ||
      value.interval_seconds <= 0 ||
      value.interval_seconds > MAX_INTERVAL_SECONDS
    ) {
      throw new LearningProgressValidationError(`items.${key}.interval_seconds is invalid`);
    }
    if (!isIso(value.due_at) || !isIso(value.created_at) || !isIso(value.updated_at)) {
      throw new LearningProgressValidationError(`items.${key} contains an invalid date`);
    }
    if (!['new', 'learning', 'mastered'].includes(String(value.mastery))) {
      throw new LearningProgressValidationError(`items.${key}.mastery is invalid`);
    }
    if (typeof value.suspended !== 'boolean') {
      throw new LearningProgressValidationError(`items.${key}.suspended must be boolean`);
    }
    value.attempts.forEach((attempt, index) => validateStoredAttempt(attempt, `${key}[${index}]`));
  }
}

function nextIntervalSeconds(
  previous: LearningProgressItem | undefined,
  input: LearningScheduleInput,
): number {
  if (!input.correct) {
    return input.confidence <= 2
      ? LEARNING_SCHEDULER_POLICY.incorrectLowConfidenceSeconds
      : LEARNING_SCHEDULER_POLICY.incorrectSeconds;
  }
  if (input.confidence === 1) {
    return LEARNING_SCHEDULER_POLICY.correctLowConfidenceSeconds[1];
  }
  if (input.confidence === 2) {
    return LEARNING_SCHEDULER_POLICY.correctLowConfidenceSeconds[2];
  }
  const confidence = input.confidence as 3 | 4 | 5;
  const firstDays = LEARNING_SCHEDULER_POLICY.firstCorrectDays[confidence];
  const previousDays = (previous?.interval_seconds || 0) / 86_400;
  const days =
    previousDays >= 1
      ? Math.max(firstDays, previousDays * LEARNING_SCHEDULER_POLICY.confidentGrowth[confidence])
      : firstDays;
  return Math.min(MAX_INTERVAL_SECONDS, Math.round(days * 86_400));
}

function validateAttemptInput(input: {
  artifact_id: string;
  item_id: string;
  item_kind: LearningItemKind;
  correct: boolean;
  confidence: LearningConfidence;
}): void {
  normalizeArtifactId(input.artifact_id);
  learningItemKey(input.item_kind, input.item_id);
  if (typeof input.correct !== 'boolean') {
    throw new LearningProgressValidationError('correct must be boolean');
  }
  if (![1, 2, 3, 4, 5].includes(input.confidence)) {
    throw new LearningProgressValidationError('confidence must be an integer from 1 to 5');
  }
}

function validateStoredAttempt(raw: unknown, path: string): void {
  if (!isRecord(raw)) throw new LearningProgressValidationError(`attempt ${path} is invalid`);
  if (typeof raw.id !== 'string' || !raw.id.trim()) {
    throw new LearningProgressValidationError(`attempt ${path}.id is invalid`);
  }
  if (typeof raw.answer !== 'string' || typeof raw.correct !== 'boolean') {
    throw new LearningProgressValidationError(`attempt ${path} answer/correct is invalid`);
  }
  if (![1, 2, 3, 4, 5].includes(raw.confidence as number) || !isIso(raw.attempted_at)) {
    throw new LearningProgressValidationError(`attempt ${path} confidence/date is invalid`);
  }
}

function learningArtifactIdsFromListing(listing: ListedFiles, rootPath: string): string[] {
  const prefix = `${rootPath}/`;
  return listing.files
    .filter((path) => path.startsWith(prefix) && path.endsWith(LEARNING_FILE_SUFFIX))
    .map((path) => path.slice(prefix.length, -LEARNING_FILE_SUFFIX.length))
    .filter((artifactId) => SAFE_ARTIFACT_ID.test(artifactId))
    .sort();
}

function normalizeArtifactId(value: string): string {
  const normalized = String(value || '').trim();
  if (!SAFE_ARTIFACT_ID.test(normalized)) {
    throw new LearningProgressValidationError('artifact_id contains unsafe characters');
  }
  return normalized;
}

function normalizeAdapterPath(value: string): string {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/{2,}/g, '/');
}

function normalizeIso(value: string | undefined, fallback: Date): string {
  if (!value) return fallback.toISOString();
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new LearningProgressValidationError('attempted_at must be a valid ISO date');
  }
  return new Date(timestamp).toISOString();
}

function isIso(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function uniqueStrings(values: readonly string[] | undefined): string[] {
  return Array.from(
    new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean)),
  );
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function serialize(value: LearningProgressSidecar): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
