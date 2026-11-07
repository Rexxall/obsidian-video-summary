import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { withCssClass } from '../utils/noteCssClass';

void test('the note class joins the classes already on the note, once, and an empty setting adds none', () => {
  const fm: Record<string, unknown> = { cssclasses: ['wide'] };
  withCssClass(fm, 'ih-film');
  withCssClass(fm, 'ih-film');
  assert.deepEqual(fm.cssclasses, ['wide', 'ih-film']);

  const legacy: Record<string, unknown> = { cssclass: 'wide, dense' };
  withCssClass(legacy, 'ih-film');
  assert.deepEqual(legacy.cssclasses, ['wide', 'dense', 'ih-film']);
  assert.equal('cssclass' in legacy, false);

  const none: Record<string, unknown> = {};
  withCssClass(none, '');
  withCssClass(none, 'not a class!');
  assert.equal('cssclasses' in none, false);
});
