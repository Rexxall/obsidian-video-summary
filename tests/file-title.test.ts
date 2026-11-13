import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { fileTitle } from '../utils/fileTitle';

test('a title keeps reading naturally once the forbidden characters are gone', () => {
  assert.equal(
    fileTitle('Philosopher David Chalmers asks: When we talk to AI, what are we talking to?'),
    'Philosopher David Chalmers asks - When we talk to AI, what are we talking to',
  );
  assert.equal(fileTitle('哲学家问：我们在和谁说话?'), '哲学家问：我们在和谁说话？');
  assert.equal(fileTitle('AIと話すとき、相手は誰か?'), 'AIと話すとき、相手は誰か？');
  assert.equal(fileTitle('Part 1/2: "Mind" <live>*'), 'Part 1 - 2 - Mind live');
  assert.equal(fileTitle('Lecture 3: 12:30 slot'), 'Lecture 3 - 12-30 slot');
  assert.equal(fileTitle('   ...   '), '');
});
