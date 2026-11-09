import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_SETTINGS, withDefaultSettings } from '../constants';
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

void test('the note class is empty by default and a saved class survives the new default', () => {
  assert.equal(DEFAULT_SETTINGS.noteCssClass, '');
  assert.equal(withDefaultSettings({}).noteCssClass, '');
  // Someone who already saved a class (such as ih-film) keeps it after upgrading.
  assert.equal(withDefaultSettings({ noteCssClass: 'ih-film' }).noteCssClass, 'ih-film');
  // Someone who cleared it keeps it cleared.
  assert.equal(withDefaultSettings({ noteCssClass: '' }).noteCssClass, '');
});
