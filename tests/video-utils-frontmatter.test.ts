import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { VideoUtils } from '../utils/VideoUtils';

test('quoted local_file values reach the backend without their YAML quotes', () => {
  const note = (value: string) => `---\nlocal_file: ${value}\nstatus: pending\n---\n`;
  assert.equal(VideoUtils.extractLocalFileName(note("'讲座 01.m4a'")), '讲座 01.m4a');
  assert.equal(VideoUtils.extractLocalFileName(note('"lecture-01.mp4"')), 'lecture-01.mp4');
  assert.equal(VideoUtils.extractLocalFileName(note("'it''s.mp3'")), "it's.mp3");
  assert.equal(VideoUtils.extractLocalFileName(note('plain.mp3')), 'plain.mp3');
});
