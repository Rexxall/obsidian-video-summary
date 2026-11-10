import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const projectRoot = new URL('../', import.meta.url);

async function readJson(name) {
  return JSON.parse(await readFile(new URL(name, projectRoot), 'utf8'));
}

test('community manifest and release metadata stay aligned', async () => {
  const [manifest, pkg, lock, versions] = await Promise.all([
    readJson('manifest.json'),
    readJson('package.json'),
    readJson('package-lock.json'),
    readJson('versions.json'),
  ]);

  assert.equal(manifest.description.length <= 250, true);
  assert.match(manifest.description, /\.$/);
  assert.equal(manifest.isDesktopOnly, true, 'Node/Electron usage requires desktop-only support');
  assert.equal(pkg.version, manifest.version);
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages?.['']?.version, manifest.version);
  assert.equal(versions[manifest.version], manifest.minAppVersion);
});

test('command IDs do not repeat the plugin ID', async () => {
  const [manifest, source] = await Promise.all([
    readJson('manifest.json'),
    readFile(new URL('main.ts', projectRoot), 'utf8'),
  ]);
  const commandSection = source.slice(
    source.indexOf('private addCommands()'),
    source.indexOf('private registerContextMenu()'),
  );
  const commandIds = [...commandSection.matchAll(/\bid:\s*['"]([^'"]+)['"]/g)].map(
    (match) => match[1],
  );

  assert.ok(commandIds.length > 0, 'expected registered commands');
  assert.equal(new Set(commandIds).size, commandIds.length, 'command IDs must be unique');
  for (const id of commandIds) {
    assert.notEqual(id, manifest.id);
    assert.equal(
      id.startsWith(`${manifest.id}-`),
      false,
      `command ID ${id} repeats plugin ID ${manifest.id}`,
    );
  }
});

test('versions.json contains only released versions plus the current candidate', async (t) => {
  const [manifest, versions] = await Promise.all([
    readJson('manifest.json'),
    readJson('versions.json'),
  ]);
  const result = spawnSync('git', ['tag', '--list'], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    t.skip('Git tags are unavailable in this source checkout');
    return;
  }
  const tags = new Set(result.stdout.split(/\r?\n/).filter(Boolean));
  for (const version of Object.keys(versions)) {
    if (version !== manifest.version) {
      assert.ok(tags.has(version), `versions.json references missing release tag ${version}`);
    }
  }
});

test('README discloses network and external-file access', async () => {
  const readme = await readFile(new URL('README.md', projectRoot), 'utf8');
  assert.match(readme, /^\*\*Network use\.\*\*/m);
  assert.match(readme, /^\*\*Files outside the vault\.\*\*/m);
  assert.match(readme, /does not include client-side telemetry/i);
});

test('the bundle loads obsidian with require, never with a native import()', async () => {
  const bundle = await readFile(new URL('../main.js', import.meta.url), 'utf8');
  // Obsidian evaluates main.js as CommonJS; import('obsidian') fails there at request time.
  assert.doesNotMatch(bundle, /\bimport\(\s*["']obsidian["']\s*\)/);
});

test('README discloses the programs the plugin runs, and Start backend never fetches or builds', async () => {
  const [readme, launcher, desktop] = await Promise.all([
    readFile(new URL('README.md', projectRoot), 'utf8'),
    readFile(new URL('core/BackendLauncher.ts', projectRoot), 'utf8'),
    readFile(new URL('utils/desktop.ts', projectRoot), 'utf8'),
  ]);
  assert.match(readme, /^\*\*Programs the plugin runs\*\*/m);
  assert.match(readme, /docker compose up -d --no-build --pull never/);
  assert.match(launcher, /'--no-build',\s*'--pull',\s*'never'/);
  // Developer policies: a plugin must not install or update its dependencies.
  assert.doesNotMatch(launcher, /'pull'|'build'|'install'/);
  // Programs are run with an argument list, never through a shell.
  assert.doesNotMatch(desktop, /\bexec\(|shell:\s*true|\bspawn\(/);
});

test('downloading the backend is left to the Terminal step the person confirms', async () => {
  const [installer, managed] = await Promise.all([
    readFile(new URL('core/BackendInstaller.ts', projectRoot), 'utf8'),
    readFile(new URL('core/ManagedBackend.ts', projectRoot), 'utf8'),
  ]);
  // No docker call made by the plugin itself pulls or builds an image.
  assert.doesNotMatch(installer, /\[\s*'(?:pull|build|compose)'/);
  const dockerCalls = [...managed.matchAll(/run\(\s*'docker',\s*\[([^\]]*)\]/g)].map((m) => m[1]);
  assert.ok(dockerCalls.length >= 3);
  for (const args of dockerCalls) assert.doesNotMatch(args, /'pull'|'build'|'compose'/);
  // The only pull is inside the script text, after the prompt.
  assert.match(managed, /read -r -p[\s\S]*docker compose --env-file \.env pull/);
});
