import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { asideName, readJsonGuarded, sameJson, writeJsonChecked } from '../core/SafeFiles';
import { PendingResults, WriteFailedError } from '../core/PendingResults';
import { JobStore } from '../core/JobStore';

/** An in-memory vault adapter; `broken` paths throw on read, like a disk or permission error. */
function memory(files: Record<string, string> = {}, broken: string[] = []) {
  const data = new Map(Object.entries(files));
  const adapter = {
    data,
    exists: async (path: string) =>
      data.has(path) || [...data.keys()].some((k) => k.startsWith(`${path}/`)),
    read: async (path: string) => {
      if (broken.includes(path)) throw new Error('EIO');
      const text = data.get(path);
      if (text === undefined) throw new Error('ENOENT');
      return text;
    },
    write: async (path: string, text: string) => void data.set(path, text),
    remove: async (path: string) => void data.delete(path),
    rename: async (from: string, to: string) => {
      if (!data.has(from)) throw new Error('ENOENT');
      if (data.has(to)) throw new Error('EEXIST');
      data.set(to, data.get(from) ?? '');
      data.delete(from);
      const i = broken.indexOf(from);
      if (i >= 0) broken[i] = to;
    },
    mkdir: async () => undefined,
    list: async (dir: string) => ({
      files: [...data.keys()].filter((k) => k.startsWith(`${dir}/`)),
      folders: [],
    }),
  };
  return adapter;
}

void test('history that cannot be parsed is set aside, never overwritten', async () => {
  const fs = memory({ 'p/history.json': '{"history": [1, 2' });
  const read = await readJsonGuarded(fs, 'p/history.json', 42);
  assert.deepEqual(read, { state: 'unreadable', backup: 'p/history.unreadable-42.json' });
  assert.equal(fs.data.get('p/history.unreadable-42.json'), '{"history": [1, 2');
  assert.equal(fs.data.has('p/history.json'), false);
});

void test('a file that cannot even be read is moved aside by rename, bytes untouched', async () => {
  const fs = memory({ 'p/history.json': 'whatever' }, ['p/history.json']);
  const read = await readJsonGuarded(fs, 'p/history.json', 7);
  assert.equal(read.state, 'unreadable');
  assert.equal(fs.data.get('p/history.unreadable-7.json'), 'whatever');
});

void test('missing is missing; a checked temporary file left by a cut-off save is recovered', async () => {
  assert.deepEqual(await readJsonGuarded(memory(), 'p/h.json'), { state: 'missing' });
  const fs = memory({ 'p/h.json.tmp': '{"a":1}' });
  assert.deepEqual(await readJsonGuarded(fs, 'p/h.json'), {
    state: 'ok',
    value: { a: 1 },
    recovered: true,
  });
  assert.equal(fs.data.get('p/h.json'), '{"a":1}');
});

void test('a checked save replaces the file only after reading the new text back', async () => {
  const fs = memory({ 'p/h.json': '{"old":true}' });
  await writeJsonChecked(fs, 'p/h.json', '{"new":true}');
  assert.equal(fs.data.get('p/h.json'), '{"new":true}');
  assert.equal(fs.data.has('p/h.json.tmp'), false);
  // A disk that does not keep what it was given: the old file stays.
  const lying = memory({ 'p/h.json': '{"old":true}' });
  lying.write = async (path, text) => void lying.data.set(path, text.slice(0, 3));
  await assert.rejects(writeJsonChecked(lying, 'p/h.json', '{"new":true}'), /read back/);
  assert.equal(lying.data.get('p/h.json'), '{"old":true}');
  assert.equal(asideName('a/data.json', 'unreadable', 1), 'a/data.unreadable-1.json');
  assert.equal(sameJson('{\n  "a": 1\n}', { a: 1 }), true);
  assert.equal(sameJson('{"a":2}', { a: 1 }), false);
});

void test('a result that could not be written waits as "ready to write", across sessions', async () => {
  const fs = memory();
  const pending = new PendingResults(fs, 'p/data/pending-results');
  const job = {
    id: 'job-1',
    title: 'Talk',
    notePath: 'Videos/Talk.md',
    input: { url: 'https://youtu.be/x' },
    mode: 'summary' as const,
    language: 'zh' as const,
  };
  await pending.save(job, { note: 'the note' }, 'disk full');
  const [record] = await pending.list();
  assert.equal(record.result.note, 'the note');
  assert.equal(record.error, 'disk full');

  // The running job fails at the write: its result is kept on the job.
  const jobs = new JobStore();
  jobs.setRunner(async () => {
    throw new WriteFailedError('笔记没写进去：disk full', { note: 'the note' });
  });
  const running = jobs.enqueue({ ...job, useCache: false });
  const done = await jobs.waitFor(running.id);
  assert.equal(done?.state, 'review');
  assert.equal(done?.writeFailed, true);
  assert.equal(done?.result?.note, 'the note');

  // Next session: the kept result comes back once.
  const later = new JobStore();
  later.restore(record);
  later.restore(record);
  assert.equal(later.getAll().length, 1);
  assert.equal(later.getAll()[0].state, 'review');
  await pending.remove('job-1');
  assert.deepEqual(await pending.list(), []);
});
