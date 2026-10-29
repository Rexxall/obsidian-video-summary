import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ListedFiles } from 'obsidian';
import type { VideoKnowledgeArtifact } from '../types';
import {
  LearningProgressAdapter,
  LearningProgressStore,
  learningItemKey,
  learningItemsFromArtifact,
  learningReviewState,
  resolveLearningEvidence,
  scheduleLearningAttempt,
} from '../core/LearningProgressStore';

const START = '2026-07-29T00:00:00.000Z';

void test('scheduler returns wrong and low-confidence answers earlier', () => {
  const wrongLow = scheduleLearningAttempt(undefined, {
    artifact_id: 'artifact-learning',
    item_id: 'card-one',
    item_kind: 'flashcard',
    answer: 'no',
    correct: false,
    confidence: 1,
    attempted_at: START,
  });
  const wrongConfident = scheduleLearningAttempt(undefined, {
    artifact_id: 'artifact-learning',
    item_id: 'card-one',
    item_kind: 'flashcard',
    answer: 'no',
    correct: false,
    confidence: 4,
    attempted_at: START,
  });
  const correctLow = scheduleLearningAttempt(undefined, {
    artifact_id: 'artifact-learning',
    item_id: 'card-one',
    item_kind: 'flashcard',
    answer: 'yes',
    correct: true,
    confidence: 1,
    attempted_at: START,
  });
  const correctConfident = scheduleLearningAttempt(undefined, {
    artifact_id: 'artifact-learning',
    item_id: 'card-one',
    item_kind: 'flashcard',
    answer: 'yes',
    correct: true,
    confidence: 3,
    attempted_at: START,
  });

  assert.equal(wrongLow.interval_seconds, 5 * 60);
  assert.equal(wrongConfident.interval_seconds, 15 * 60);
  assert.equal(correctLow.interval_seconds, 30 * 60);
  assert.equal(correctConfident.interval_seconds, 24 * 60 * 60);
  assert.ok(wrongLow.interval_seconds < correctLow.interval_seconds);
  assert.ok(correctLow.interval_seconds < correctConfident.interval_seconds);
});

void test('consecutive confident correct answers grow intervals and reach mastery', () => {
  let progress = scheduleLearningAttempt(undefined, {
    artifact_id: 'artifact-learning',
    item_id: 'question-one',
    item_kind: 'question',
    answer: 'A',
    correct: true,
    confidence: 4,
    attempted_at: START,
  });
  const firstInterval = progress.interval_seconds;
  progress = scheduleLearningAttempt(progress, {
    artifact_id: 'artifact-learning',
    item_id: 'question-one',
    item_kind: 'question',
    answer: 'A',
    correct: true,
    confidence: 4,
    attempted_at: progress.due_at,
  });
  const secondInterval = progress.interval_seconds;
  progress = scheduleLearningAttempt(progress, {
    artifact_id: 'artifact-learning',
    item_id: 'question-one',
    item_kind: 'question',
    answer: 'A',
    correct: true,
    confidence: 4,
    attempted_at: progress.due_at,
  });

  assert.ok(secondInterval > firstInterval);
  assert.ok(progress.interval_seconds > secondInterval);
  assert.equal(progress.consecutive_correct, 3);
  assert.equal(progress.mastery, 'mastered');
  assert.equal(learningReviewState(progress, START), 'mastered');

  const reset = scheduleLearningAttempt(progress, {
    artifact_id: 'artifact-learning',
    item_id: 'question-one',
    item_kind: 'question',
    answer: 'B',
    correct: false,
    confidence: 4,
    attempted_at: progress.due_at,
  });
  assert.equal(reset.consecutive_correct, 0);
  assert.equal(reset.mastery, 'learning');
  assert.equal(reset.interval_seconds, 15 * 60);
  assert.equal(learningReviewState(reset, reset.due_at), 'due');
});

void test('sidecar survives store restart and preserves attempts, due and suspended state', async () => {
  const adapter = new MemoryAdapter();
  let now = new Date(START);
  const firstStore = new LearningProgressStore(adapter, 'plugin-data/learning', {
    now: () => now,
  });
  const first = await firstStore.recordAttempt({
    artifact_id: 'artifact-learning',
    item_id: 'card-one',
    item_kind: 'flashcard',
    answer: 'first answer',
    correct: false,
    confidence: 2,
  });

  assert.equal(first.total_attempts, 1);
  assert.equal((await firstStore.listDue(now)).length, 0);

  const restarted = new LearningProgressStore(adapter, 'plugin-data/learning', {
    now: () => now,
  });
  const recovered = await restarted.getItem('artifact-learning', 'flashcard', 'card-one');
  assert.deepEqual(recovered, first);

  now = new Date(first.due_at);
  assert.equal((await restarted.listDue()).length, 1);
  const second = await restarted.recordAttempt({
    artifact_id: 'artifact-learning',
    item_id: 'card-one',
    item_kind: 'flashcard',
    answer: 'second answer',
    correct: true,
    confidence: 3,
  });
  assert.equal(second.total_attempts, 2);
  assert.deepEqual(
    second.attempts.map((attempt) => attempt.answer),
    ['first answer', 'second answer'],
  );

  const suspended = await restarted.setSuspended(
    'artifact-learning',
    'flashcard',
    'card-one',
    true,
  );
  assert.equal(suspended?.suspended, true);
  now = new Date(second.due_at);
  assert.equal((await restarted.listDue()).length, 0);
  assert.equal(suspended && learningReviewState(suspended, now), 'suspended');
});

void test('learning identity includes kind so card and question ids cannot collide', () => {
  assert.equal(learningItemKey('flashcard', 'same'), 'flashcard:same');
  assert.equal(learningItemKey('question', 'same'), 'question:same');
  assert.notEqual(learningItemKey('flashcard', 'same'), learningItemKey('question', 'same'));
});

void test('evidence resolver links real timestamps and reports missing or untimed evidence', () => {
  const artifact = makeArtifact();
  const items = learningItemsFromArtifact(artifact);
  const available = resolveLearningEvidence(artifact, items[0]);
  const mixed = resolveLearningEvidence(artifact, items[1]);
  const absent = resolveLearningEvidence(artifact, items[2]);

  assert.equal(available.available, 1);
  assert.equal(available.targets[0].status, 'available');
  assert.equal(available.targets[0].start, 42);
  assert.match(available.targets[0].timestamp_url || '', /t=42s/);

  assert.deepEqual(
    mixed.targets.map((target) => target.status),
    ['untimed', 'missing'],
  );
  assert.equal(mixed.available, 0);
  assert.equal(mixed.missing, 2);

  assert.equal(absent.targets.length, 0);
  assert.match(absent.message || '', /没有 evidence_segment_ids/);
});

function makeArtifact(): VideoKnowledgeArtifact {
  return {
    schema_version: 3,
    artifact_id: 'artifact-learning',
    source: {
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      source_hash: 'a'.repeat(64),
    },
    title: 'Learning fixture',
    timing_quality: 'exact',
    transcript: 'Timed evidence. Untimed evidence.',
    segments: [
      {
        id: 'segment-timed',
        start: 42,
        end: 50,
        text: 'Timed evidence.',
        source: 'speech',
        timing_quality: 'exact',
      },
      {
        id: 'segment-untimed',
        start: null,
        text: 'Untimed evidence.',
        source: 'speech',
        timing_quality: 'none',
      },
    ],
    claims: [],
    visual_evidence: [],
    learning: {
      flashcards: [
        {
          id: 'card-timed',
          front: 'Timed?',
          back: 'Yes',
          evidence_segment_ids: ['segment-timed'],
        },
        {
          id: 'card-mixed',
          front: 'Mixed?',
          back: 'Review',
          evidence_segment_ids: ['segment-untimed', 'segment-missing'],
        },
        {
          id: 'card-no-evidence',
          front: 'Absent?',
          back: 'Explicit',
        },
      ],
    },
    related_notes: [],
    highlights: [],
    course_ids: [],
    provenance: {
      schema_version: 3,
      source_hash: 'a'.repeat(64),
    },
    created_at: START,
    updated_at: START,
  };
}

class MemoryAdapter implements LearningProgressAdapter {
  readonly files = new Map<string, string>();
  readonly folders = new Set<string>();

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.folders.has(path);
  }

  async list(path: string): Promise<ListedFiles> {
    const prefix = `${path.replace(/\/$/, '')}/`;
    return {
      files: Array.from(this.files.keys()).filter(
        (file) => file.startsWith(prefix) && !file.slice(prefix.length).includes('/'),
      ),
      folders: Array.from(this.folders).filter(
        (folder) => folder.startsWith(prefix) && !folder.slice(prefix.length).includes('/'),
      ),
    };
  }

  async read(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`Missing file: ${path}`);
    return value;
  }

  async write(path: string, data: string): Promise<void> {
    this.files.set(path, data);
  }

  async mkdir(path: string): Promise<void> {
    this.folders.add(path);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }

  async rename(path: string, newPath: string): Promise<void> {
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`Missing file: ${path}`);
    if (this.files.has(newPath)) throw new Error(`Target exists: ${newPath}`);
    this.files.set(newPath, value);
    this.files.delete(path);
  }

  async process(path: string, fn: (data: string) => string): Promise<string> {
    const next = fn(await this.read(path));
    this.files.set(path, next);
    return next;
  }
}
