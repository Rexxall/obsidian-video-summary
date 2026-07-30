import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { JobStore } from '../core/JobStore';

test('retry preserves the preview gate and returns a successful rerun for review', async () => {
  const jobs = new JobStore();
  let attempts = 0;
  let writerCalls = 0;

  jobs.setRunner(async (job) => {
    attempts += 1;
    if (attempts === 1) throw new Error('temporary backend failure');

    // JobService writes only when this gate is false. Model that boundary here
    // so a retry regression cannot silently turn preview mode into auto-write.
    if (!job.awaitingWrite) writerCalls += 1;
    return { summary: 'review this before writing' };
  });

  const job = jobs.enqueue({
    title: 'Preview retry',
    input: { transcript: 'persisted transcript' },
    mode: 'summary',
    language: 'zh',
    useCache: true,
    awaitingWrite: true,
  });

  const failed = await jobs.waitFor(job.id);
  assert.equal(failed?.state, 'error');
  assert.equal(failed?.awaitingWrite, true);

  jobs.retry(job.id);
  const retried = await jobs.waitFor(job.id);

  assert.equal(attempts, 2);
  assert.equal(retried?.state, 'review');
  assert.equal(retried?.awaitingWrite, true);
  assert.equal(writerCalls, 0);
});
