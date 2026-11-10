import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { VideoSummaryAPI } from '../api/VideoSummaryAPI';
import {
  BackendDiagnosis,
  BackendLostError,
  BackendMonitor,
  diagnoseBackend,
  endpointPort,
  isLocalEndpoint,
  mayMeanBackendGone,
  withBackendWatch,
} from '../core/BackendHealth';
import { JobStore } from '../core/JobStore';

const offline = (): BackendDiagnosis => ({
  ok: false,
  fault: 'unreachable',
  checkedAt: Date.now(),
});
const online = (): BackendDiagnosis => ({ ok: true, status: 200, checkedAt: Date.now() });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const spec = (title: string) => ({
  title,
  input: { url: `https://example.com/${title}` },
  mode: 'summary' as const,
  language: 'zh' as const,
  useCache: false,
});

void test('the three kinds of "no answer" are told apart', () => {
  // Nothing listens on the port: the container or Docker is not running.
  assert.equal(
    diagnoseBackend({ networkError: 'ERR_CONNECTION_REFUSED' }, undefined, 1).fault,
    'unreachable',
  );
  // n8n is up, the webhook is not registered: the workflow is not active.
  assert.equal(diagnoseBackend({ status: 404 }, true, 1).fault, 'workflow-inactive');
  // 404 and n8n's health endpoint is silent too: the address is wrong.
  assert.equal(diagnoseBackend({ status: 404 }, false, 1).fault, 'http');
  // The workflow ran and failed.
  assert.equal(diagnoseBackend({ status: 500 }, undefined, 1).fault, 'workflow-error');
  // The workflow answered 200 with nothing in it.
  assert.equal(
    diagnoseBackend({ status: 200, bodyEmpty: true }, undefined, 1).fault,
    'empty-response',
  );
  assert.equal(diagnoseBackend({ status: 403 }, undefined, 1).fault, 'auth');
  assert.equal(diagnoseBackend({ timedOut: true }, undefined, 1).fault, 'timeout');
  assert.equal(diagnoseBackend({ status: 200, bodyEmpty: false }, undefined, 1).ok, true);
});

void test('local addresses and ports are read from the webhook address', () => {
  assert.equal(isLocalEndpoint('http://localhost:5678/webhook/x'), true);
  assert.equal(isLocalEndpoint('http://127.0.0.1:5679/webhook/x#token=abc'), true);
  assert.equal(isLocalEndpoint('https://n8n.example.com/webhook/x'), false);
  assert.equal(endpointPort('http://localhost:5679/webhook/x'), 5679);
  assert.equal(endpointPort('https://n8n.example.com/webhook/x'), 443);
  assert.equal(endpointPort('not a url'), 0);
});

void test('the API diagnosis asks n8n health only after a 404, and sees an empty body', async () => {
  const original = VideoSummaryAPI.transport;
  const api = new VideoSummaryAPI(
    'http://localhost:5678/webhook/vs',
    { adapter: {} } as never,
    '.obsidian/plugins/video-summary/data',
    undefined,
    { headerName: 'X-Video-Summary-Token', secret: 'test-token' },
  );
  const calls: string[] = [];
  const reply = (status: number, text: string) => ({
    status,
    text,
    headers: {},
    json: null,
    arrayBuffer: new ArrayBuffer(0),
  });
  try {
    VideoSummaryAPI.transport = async (request) => {
      calls.push(`${request.method} ${request.url}`);
      return request.url.endsWith('/healthz') ? reply(200, '{"status":"ok"}') : reply(404, '{}');
    };
    assert.equal((await api.diagnose()).fault, 'workflow-inactive');
    assert.deepEqual(calls, [
      'POST http://localhost:5678/webhook/vs',
      'GET http://localhost:5678/healthz',
    ]);

    calls.length = 0;
    VideoSummaryAPI.transport = async (request) => {
      calls.push(request.url);
      return reply(200, '  ');
    };
    assert.equal((await api.diagnose()).fault, 'empty-response');
    assert.equal(calls.length, 1);

    VideoSummaryAPI.transport = async () => {
      throw new Error('net::ERR_CONNECTION_REFUSED');
    };
    assert.equal((await api.diagnose()).fault, 'unreachable');
    assert.equal(await api.pingService(), false);

    VideoSummaryAPI.transport = async () => reply(200, '{"ok":true}');
    assert.equal((await api.diagnose()).ok, true);
    assert.equal(await api.pingService(), true);
  } finally {
    VideoSummaryAPI.transport = original;
  }
});

void test('a job sent while the backend is offline waits, then runs by itself once it is back', async () => {
  let up = false;
  const jobs = new JobStore();
  const ran: string[] = [];
  jobs.setRunner(async (job) => {
    ran.push(job.title);
    return { summary: 'done' };
  });
  const monitor = new BackendMonitor(async () => (up ? online() : offline()));
  monitor.subscribe((snapshot) => {
    if (snapshot.status === 'online') jobs.setHeld(false);
    else if (snapshot.status === 'offline') jobs.setHeld(true);
  });

  // Submit: the pre-submit check fails, the queue is held, the job is still queued.
  assert.equal((await monitor.check()).ok, false);
  const first = jobs.enqueue(spec('first'));
  const second = jobs.enqueue(spec('second'));
  await tick();
  assert.equal(jobs.isHeld(), true);
  assert.equal(first.state, 'queued');
  assert.deepEqual(ran, []);

  // Start backend: the monitor reports "starting" while it is still down, then online.
  monitor.beginStart('Opening Docker');
  monitor.record(offline());
  assert.equal(monitor.snapshot().status, 'starting');
  assert.equal(jobs.isHeld(), true);
  up = true;
  monitor.record(online());
  monitor.endStart();

  await jobs.waitFor(first.id);
  await jobs.waitFor(second.id);
  assert.equal(monitor.snapshot().status, 'online');
  assert.deepEqual(ran, ['first', 'second']);
  assert.equal(first.state, 'success');
});

void test('concurrent checks share one probe and a fresh result is reused', async () => {
  let probes = 0;
  const monitor = new BackendMonitor(async () => {
    probes += 1;
    await tick();
    return online();
  });
  await Promise.all([monitor.check(), monitor.check(), monitor.check()]);
  assert.equal(probes, 1);
  await monitor.check(60_000);
  assert.equal(probes, 1);
  await monitor.check();
  assert.equal(probes, 2);
});

/** Timers the test fires by hand. */
function manualTimers() {
  const pending: Array<{ run: () => void; ms: number }> = [];
  return {
    pending,
    setTimer: (run: () => void, ms: number) => {
      const entry = { run, ms };
      pending.push(entry);
      return entry;
    },
    clearTimer: (handle: unknown) => {
      const index = pending.indexOf(handle as (typeof pending)[number]);
      if (index >= 0) pending.splice(index, 1);
    },
    async fire() {
      const entry = pending.shift();
      assert.ok(entry, 'a timer should be waiting');
      entry.run();
      await tick();
      await tick();
      return entry.ms;
    },
  };
}

void test('a running job fails as soon as the backend is gone twice in a row, and can be retried', async () => {
  const timers = manualTimers();
  let alive = true;
  let lost = 0;
  let attempts = 0;
  const jobs = new JobStore();
  jobs.setRunner(() => {
    attempts += 1;
    // First attempt: the request never comes back, as when the container is stopped mid-job.
    const work =
      attempts === 1
        ? new Promise<{ summary: string }>(() => undefined)
        : Promise.resolve({ summary: 'second try' });
    return withBackendWatch(work, {
      ping: async () => alive,
      onLost: () => {
        lost += 1;
      },
      lostMessage: 'backend stopped',
      intervalMs: 45_000,
      confirmMs: 5_000,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
  });

  const job = jobs.enqueue(spec('long video'));
  await tick();
  assert.equal(job.state, 'running');

  assert.equal(await timers.fire(), 45_000); // still alive: keep waiting
  assert.equal(job.state, 'running');

  alive = false;
  assert.equal(await timers.fire(), 45_000); // first miss: ask again soon
  assert.equal(job.state, 'running');
  assert.equal(await timers.fire(), 5_000); // second miss: fail now
  await jobs.waitFor(job.id);
  assert.equal(job.state, 'error');
  assert.equal(job.error, 'backend stopped');
  assert.equal(lost, 1);
  assert.equal(timers.pending.length, 0);

  alive = true;
  jobs.retry(job.id);
  await jobs.waitFor(job.id);
  assert.equal(job.state, 'success');
  assert.equal(timers.pending.length, 0, 'the watch stops when the job ends');
});

void test('one missed ping followed by an answer does not fail the job', async () => {
  const timers = manualTimers();
  const answers = [false, true];
  let finish: (value: string) => void = () => undefined;
  const watched = withBackendWatch(
    new Promise<string>((resolve) => {
      finish = resolve;
    }),
    {
      ping: async () => answers.shift() ?? true,
      onLost: () => assert.fail('must not be reported lost'),
      lostMessage: 'x',
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    },
  );
  await timers.fire();
  await timers.fire();
  finish('ok');
  assert.equal(await watched, 'ok');
  assert.equal(new BackendLostError('x').name, 'BackendLostError');
});

void test('the messages a stopped backend leaves on a job are recognised after rewording', () => {
  const api = new VideoSummaryAPI(
    'http://localhost:5678/webhook/vs',
    { adapter: {} } as never,
    '.obsidian/plugins/video-summary/data',
    undefined,
  );
  // n8n answers pending requests with an empty body when it is told to stop.
  assert.equal(mayMeanBackendGone(api.formatUserFacingError(new Error('服务器返回空响应'))), true);
  assert.equal(
    mayMeanBackendGone(api.formatUserFacingError(new Error('net::ERR_CONNECTION_REFUSED'))),
    true,
  );
  assert.equal(mayMeanBackendGone(api.formatUserFacingError(new Error('Failed to fetch'))), true);
  assert.equal(mayMeanBackendGone(api.formatUserFacingError(new Error('HTTP 401'))), false);
  assert.equal(mayMeanBackendGone('Bilibili refused the request'), false);
});

void test('a job sent while the backend restarts with new settings waits and then runs, without an error', async () => {
  let up = true;
  const jobs = new JobStore();
  jobs.setRunner(async () => {
    if (!up) throw new Error('sent to a backend that is down');
    return { summary: 'done' };
  });
  const monitor = new BackendMonitor(async () => (up ? online() : offline()));
  monitor.subscribe((snapshot) => {
    if (snapshot.status === 'online') jobs.setHeld(false);
  });
  await monitor.check();

  // Settings changed: the queue is held first, then the container restarts.
  monitor.beginStart('Restarting with the new settings');
  jobs.setHeld(true);
  up = false;
  const job = jobs.enqueue(spec('sent during the restart'));
  assert.equal((await monitor.check()).ok, false);
  assert.equal(monitor.snapshot().status, 'starting');
  await tick();
  assert.equal(job.state, 'queued');

  up = true;
  monitor.record(online());
  monitor.endStart();
  await jobs.waitFor(job.id);
  assert.equal(job.state, 'success');
  assert.equal(job.error, undefined);
});
