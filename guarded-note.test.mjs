import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const bundle = fs.readFileSync(import.meta.dirname + '/main.js', 'utf8');
const ast = ts.createSourceFile('main.js', bundle, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const statement = ast.statements.find(
  (s) =>
    ts.isVariableStatement(s) &&
    s.declarationList.declarations.some((d) => d.name.getText(ast) === 'NoteProcessor'),
);
assert.ok(statement, 'Shipping NoteProcessor exists');
function fixture(race = false) {
  let content = 'user note';
  const context = { shouldMirrorLegacyStatus: () => false, canonicalPluginStatus: (x) => x };
  vm.runInNewContext(statement.getText(ast), context);
  const vault = {
    read: async () => content,
    process: async (_, fn) => {
      if (race) content = 'new user edit';
      content = fn(content);
    },
  };
  const processor = new context.NoteProcessor(vault);
  processor.parseFrontmatter = (text) => ({ fm: {}, body: text });
  processor.buildContent = (fm, body) => JSON.stringify(fm) + '\n' + body;
  return { processor, read: () => content };
}
test('shipping status update preserves note text', async () => {
  const f = fixture();
  await f.processor.setProcessingStatus({}, 'done');
  assert.match(f.read(), /user note/);
  assert.match(f.read(), /done/);
});
test('shipping status write rejects a concurrent user edit', async () => {
  const f = fixture(true);
  await assert.rejects(f.processor.setProcessingStatus({}, 'done'), /已变化/);
  assert.equal(f.read(), 'new user edit');
});
