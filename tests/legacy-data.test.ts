import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { mergeHistory, mergeWebhookHistory, salvageSettingsJson } from '../core/LegacyData';

// Shaped like a real 2.1.x data.json after a sync conflict; every value is made up.
const entry = (file: string, time: string) =>
  `    {\n      "file": "${file}",\n      "result": "success",\n      "mode": "summary",\n      "time": "${time}"\n    }`;
const webhook = (timestamp: number, title: string) =>
  `    {\n      "input": {\n        "url": "https://www.youtube.com/watch?v=${timestamp}"\n      },\n      "result": {\n        "summary": "s",\n        "video_title": "${title}"\n      },\n      "mode": "summary",\n      "language": "zh",\n      "timestamp": ${timestamp}\n    }`;
const damaged = [
  '{',
  '  "n8nWebhookUrl": "http://localhost:5678/webhook/demo",',
  '>>>>>>>+main',
  'files":   "n8nWebhookUrl": "http://loc',
  '>>>>>>>-origin/main',
  '  "retryCount": 2,',
  '  "enableCache": true,',
  '  "history": [',
  entry('Note A', '2026/1/2 10:00:00') + ',',
  entry('Note B', '2026/1/3 10:00:00') + ',',
  entry('Note A', '2026/1/2 10:00:00') + ',',
  '    {\n      "file": "Cut',
  '>>>>>>>+main',
  'off in the middle", "result": "success" }',
  '  ],',
  '  "webhookHistory": [',
  webhook(1700000000002, 'Second') + ',',
  webhook(1700000000001, 'First'),
  '  ]',
  '}',
].join('\n');

void test('a data.json with merge markers is salvaged instead of thrown away', () => {
  assert.throws(() => JSON.parse(damaged));
  const result = salvageSettingsJson(damaged);
  assert.equal(result.corrupt, true);
  assert.equal(result.settings.n8nWebhookUrl, 'http://localhost:5678/webhook/demo');
  assert.equal(result.settings.retryCount, 2);
  assert.equal(result.settings.enableCache, true);
  assert.deepEqual(
    result.history.map((item) => item.file),
    ['Note A', 'Note B'],
    'complete entries kept once, the cut one dropped',
  );
  assert.deepEqual(
    result.webhookHistory.map((item) => item.timestamp),
    [1700000000002, 1700000000001],
  );
});

void test('an intact file is returned as it is', () => {
  const intact = JSON.stringify({ a: 1, history: [], webhookHistory: [] });
  const result = salvageSettingsJson(intact);
  assert.equal(result.corrupt, false);
  assert.equal(result.settings.a, 1);
});

void test('records already in history.json are never collapsed, even when they look alike', () => {
  const same = { file: 'X', result: 'success', mode: 'summary', time: '2026/1/3 10:00:00' };
  const base = [same, { ...same }];
  assert.equal(mergeHistory(base, []), base);
  assert.equal(mergeHistory(base, [same]).length, 2);
});

void test('histories from two places merge without repeats, in time order', () => {
  const a = [{ file: 'X', result: 'success', mode: 'summary', time: '2026/1/3 10:00:00' }];
  const b = [
    { file: 'Y', result: 'success', mode: 'summary', time: '2026/1/1 10:00:00' },
    { file: 'X', result: 'success', mode: 'summary', time: '2026/1/3 10:00:00' },
  ];
  assert.deepEqual(
    mergeHistory(a, b).map((item) => item.file),
    ['Y', 'X'],
  );
  const w = (timestamp: number) => ({ timestamp, input: { url: `u${timestamp}` }, result: {} });
  assert.deepEqual(
    mergeWebhookHistory([w(1), w(3)], [w(2), w(3)]).map((item) => item.timestamp),
    [3, 2, 1],
  );
});
