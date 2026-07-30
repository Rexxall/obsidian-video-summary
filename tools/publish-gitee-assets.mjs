#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const argumentsList = process.argv.slice(2);

function readArgument(name) {
  const index = argumentsList.indexOf(name);
  if (index === -1) return undefined;
  const value = argumentsList[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function hasFlag(name) {
  return argumentsList.includes(name);
}

function parseRepository(value) {
  const match = value
    .trim()
    .match(/^(?:https:\/\/gitee\.com\/|git@gitee\.com:)?([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  if (!match) {
    throw new Error(`Gitee repository must be an owner/repo slug or Gitee clone URL: ${value}`);
  }

  const [, owner, repo] = match;
  return {
    owner,
    repo,
    webUrl: `https://gitee.com/${owner}/${repo}`,
    cloneUrl: `https://gitee.com/${owner}/${repo}.git`,
  };
}

function parseSemver(value) {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) throw new Error(`Invalid semantic version: ${value}`);
  return match.slice(1).map(Number);
}

function compareSemver(left, right) {
  const leftParts = parseSemver(left);
  const rightParts = parseSemver(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] - rightParts[index];
    }
  }
  return 0;
}

function runGit(args, cwd, gitEnvironment, options = {}) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...gitEnvironment,
      GIT_TERMINAL_PROMPT: '0',
    },
  });

  if (!options.allowedStatuses?.includes(result.status) && result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`git ${args[0]} failed${detail ? `: ${detail}` : ''}`);
  }

  return result;
}

async function sha256(filePath) {
  const content = await readFile(filePath);
  return createHash('sha256').update(content).digest('hex');
}

async function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function writeLatestFiles(cloneDirectory, release) {
  const releasesDirectory = path.join(cloneDirectory, 'releases');
  const latestPath = path.join(releasesDirectory, 'latest.json');
  const existingLatest = await readJsonIfPresent(latestPath);
  const shouldUpdateLatest =
    !existingLatest?.version || compareSemver(release.version, existingLatest.version) >= 0;

  if (!shouldUpdateLatest) {
    console.log(
      `Keeping releases/latest.json at newer version ${existingLatest.version}; published ${release.version} without regressing it.`,
    );
    return;
  }

  const latest = {
    version: release.version,
    tag: release.version,
    releasePage: `${release.repository.webUrl}/releases#release-${release.version}`,
    assetsBase: release.baseUrl,
    assets: release.hashes,
  };
  await writeFile(latestPath, `${JSON.stringify(latest, null, 2)}\n`);

  await writeFile(
    path.join(cloneDirectory, 'README.md'),
    `# Video Summary 国内发布文件

本分支只保存国内下载文件，不作为源码开发分支。

- GitHub 主仓库：<https://github.com/Rexxall/obsidian-video-summary-plugin>
- Gitee 国内镜像：<${release.repository.webUrl}>
- Gitee 国内 Release：<${release.repository.webUrl}/releases#release-${release.version}>

## 最新版本

- 版本：\`${release.version}\`
- 安装包：[${release.archiveName}](${release.baseUrl}${release.archiveName})
- 校验文件：[SHA256SUMS](${release.baseUrl}SHA256SUMS)
- 机器可读索引：[releases/latest.json](releases/latest.json)

## 安装

1. 下载 \`${release.archiveName}\` 和 \`SHA256SUMS\`。
2. 校验安装包：

   \`\`\`bash
   grep '${release.archiveName}' SHA256SUMS | shasum -a 256 -c -
   \`\`\`

3. 将 ZIP 解压到 Obsidian 仓库的 \`.obsidian/plugins/video-summary/\`。
4. 重载 Obsidian，在“第三方插件”中启用 Video Summary。

GitHub 与 Gitee 提供的同版本文件必须具有相同的 SHA-256。不要从不透明的第三方 GitHub 代理下载插件包。
`,
  );
}

async function prepareBranchClone(cloneDirectory, release, gitEnvironment) {
  runGit(
    ['clone', '--no-checkout', release.repository.cloneUrl, cloneDirectory],
    process.cwd(),
    gitEnvironment,
  );

  const remoteBranch = runGit(
    ['show-ref', '--verify', '--quiet', 'refs/remotes/origin/gitee-release-assets'],
    cloneDirectory,
    gitEnvironment,
    { allowedStatuses: [0, 1] },
  );

  if (remoteBranch.status === 0) {
    runGit(
      ['switch', '--track', '-c', 'gitee-release-assets', 'origin/gitee-release-assets'],
      cloneDirectory,
      gitEnvironment,
    );
  } else {
    runGit(['switch', '--orphan', 'gitee-release-assets'], cloneDirectory, gitEnvironment);
  }
}

function syncSourceTag(release, gitEnvironment, dryRun) {
  const args = ['push'];
  if (dryRun) args.push('--dry-run');
  args.push(
    release.repository.cloneUrl,
    `refs/tags/${release.version}:refs/tags/${release.version}`,
  );
  runGit(args, process.cwd(), gitEnvironment);
  console.log(
    `${dryRun ? 'Verified' : 'Synchronized'} Gitee source tag ${release.version} at ${release.sourceCommit}.`,
  );
}

async function publishAssetBranch(temporaryDirectory, release, gitEnvironment, dryRun) {
  const maximumAttempts = dryRun ? 1 : 3;

  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    const cloneDirectory = path.join(temporaryDirectory, `repo-${attempt}`);
    await prepareBranchClone(cloneDirectory, release, gitEnvironment);

    const versionDirectory = path.join(cloneDirectory, 'releases', release.version);
    await mkdir(versionDirectory, { recursive: true });
    for (const fileName of release.files) {
      await copyFile(
        path.join(release.assetDirectory, fileName),
        path.join(versionDirectory, fileName),
      );
    }
    await writeLatestFiles(cloneDirectory, release);

    runGit(['add', 'README.md', 'releases'], cloneDirectory, gitEnvironment);
    const diff = runGit(['diff', '--cached', '--quiet'], cloneDirectory, gitEnvironment, {
      allowedStatuses: [0, 1],
    });

    if (diff.status === 0) {
      console.log(`Gitee release asset branch already contains ${release.version}.`);
      return;
    }
    if (dryRun) {
      console.log(`Dry run passed for Gitee release assets ${release.version}; no push performed.`);
      return;
    }

    runGit(
      [
        '-c',
        'user.name=github-actions[bot]',
        '-c',
        'user.email=41898282+github-actions[bot]@users.noreply.github.com',
        'commit',
        '-m',
        `Publish verified ${release.version} domestic release assets`,
      ],
      cloneDirectory,
      gitEnvironment,
    );

    try {
      runGit(['push', 'origin', 'HEAD:gitee-release-assets'], cloneDirectory, gitEnvironment);
      console.log(`Published verified Gitee release assets ${release.version}.`);
      return;
    } catch (error) {
      const retryable = /fetch first|non-fast-forward|rejected/i.test(String(error));
      if (!retryable || attempt === maximumAttempts) throw error;
      console.warn(`Gitee asset branch moved during publication; retrying (${attempt + 1}/3).`);
    }
  }
}

async function giteeRequest(release, method, endpoint, options = {}) {
  const url = new URL(`https://gitee.com/api/v5${endpoint}`);
  let body;

  if (options.filePath) {
    const form = new FormData();
    form.set('access_token', release.token);
    form.set('file', new Blob([await readFile(options.filePath)]), path.basename(options.filePath));
    body = form;
  } else if (method === 'GET' || method === 'DELETE') {
    url.searchParams.set('access_token', release.token);
    for (const [name, value] of Object.entries(options.query || {})) {
      url.searchParams.set(name, String(value));
    }
  } else {
    body = JSON.stringify({
      access_token: release.token,
      ...Object.fromEntries(
        Object.entries(options.form || {}).map(([name, value]) => [name, value]),
      ),
    });
  }

  const response = await fetch(url, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
    },
    body,
  });
  const responseText = await response.text();
  let responseBody;
  if (responseText) {
    try {
      responseBody = JSON.parse(responseText);
    } catch {
      responseBody = responseText;
    }
  }

  if (!response.ok && !options.allowedStatuses?.includes(response.status)) {
    const detail =
      typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody || {});
    throw new Error(`Gitee API ${method} ${endpoint} failed (${response.status}): ${detail}`);
  }

  return { status: response.status, body: responseBody };
}

async function downloadAttachmentHash(release, repositoryPath, releaseId, attachmentId) {
  const url = new URL(
    `https://gitee.com/api/v5${repositoryPath}/releases/${releaseId}/attach_files/${attachmentId}/download`,
  );
  url.searchParams.set('access_token', release.token);
  const response = await fetch(url, { headers: { Accept: 'application/octet-stream' } });
  if (!response.ok) {
    throw new Error(`Gitee attachment download failed (${response.status})`);
  }
  return createHash('sha256')
    .update(Buffer.from(await response.arrayBuffer()))
    .digest('hex');
}

async function buildReleaseNotes(release) {
  let notes;
  try {
    notes = await readFile(
      path.join(process.cwd(), 'docs', 'releases', `${release.version}.md`),
      'utf8',
    );
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    notes = `# Video Summary ${release.version}\n`;
  }

  return `${notes.trim()}

---

国内备用直链：

- 安装包：${release.baseUrl}${release.archiveName}
- SHA-256：${release.baseUrl}SHA256SUMS
- n8n 工作流：${release.baseUrl}Obsidian.Video.Summary.json
`;
}

async function upsertGiteeRelease(release) {
  const repositoryPath = `/repos/${encodeURIComponent(release.repository.owner)}/${encodeURIComponent(
    release.repository.repo,
  )}`;
  const byTag = await giteeRequest(
    release,
    'GET',
    `${repositoryPath}/releases/tags/${encodeURIComponent(release.version)}`,
    { allowedStatuses: [404] },
  );
  const releaseForm = {
    tag_name: release.version,
    name: `Video Summary ${release.version}（国内镜像）`,
    body: await buildReleaseNotes(release),
    prerelease: false,
  };

  let giteeRelease;
  if (byTag.status === 404 || !byTag.body) {
    const createResult = await giteeRequest(release, 'POST', `${repositoryPath}/releases`, {
      form: { ...releaseForm, target_commitish: release.sourceCommit },
      allowedStatuses: [409, 422],
    });
    if (createResult.status === 409 || createResult.status === 422) {
      giteeRelease = (
        await giteeRequest(
          release,
          'GET',
          `${repositoryPath}/releases/tags/${encodeURIComponent(release.version)}`,
        )
      ).body;
    } else {
      giteeRelease = createResult.body;
    }
  } else {
    giteeRelease = (
      await giteeRequest(release, 'PATCH', `${repositoryPath}/releases/${byTag.body.id}`, {
        form: releaseForm,
      })
    ).body;
  }

  if (!Number.isInteger(giteeRelease?.id)) {
    throw new Error('Gitee Release response did not include a numeric id');
  }

  const attachmentsPath = `${repositoryPath}/releases/${giteeRelease.id}/attach_files`;
  const attachments = (
    await giteeRequest(release, 'GET', attachmentsPath, {
      query: { page: 1, per_page: 100 },
    })
  ).body;
  if (!Array.isArray(attachments)) {
    throw new Error('Gitee attachment-list response was not an array');
  }

  for (const fileName of release.files) {
    const matches = attachments.filter((attachment) => attachment?.name === fileName);
    if (
      matches.length === 1 &&
      Number.isInteger(matches[0]?.id) &&
      (await downloadAttachmentHash(release, repositoryPath, giteeRelease.id, matches[0].id)) ===
        release.hashes[fileName]
    ) {
      console.log(`Gitee Release attachment ${fileName} already matches.`);
      continue;
    }

    for (const attachment of matches) {
      if (!Number.isInteger(attachment?.id)) {
        throw new Error(`Gitee attachment ${fileName} did not include a numeric id`);
      }
      await giteeRequest(
        release,
        'DELETE',
        `${attachmentsPath}/${encodeURIComponent(attachment.id)}`,
      );
    }
    await giteeRequest(release, 'POST', attachmentsPath, {
      filePath: path.join(release.assetDirectory, fileName),
    });
  }

  const verifiedAttachments = (
    await giteeRequest(release, 'GET', attachmentsPath, {
      query: { page: 1, per_page: 100 },
    })
  ).body;
  if (!Array.isArray(verifiedAttachments)) {
    throw new Error('Gitee final attachment-list response was not an array');
  }
  for (const fileName of release.files) {
    const matches = verifiedAttachments.filter((attachment) => attachment?.name === fileName);
    if (matches.length !== 1 || !Number.isInteger(matches[0]?.id)) {
      throw new Error(`Expected exactly one Gitee Release attachment named ${fileName}`);
    }
    const remoteHash = await downloadAttachmentHash(
      release,
      repositoryPath,
      giteeRelease.id,
      matches[0].id,
    );
    if (remoteHash !== release.hashes[fileName]) {
      throw new Error(`Gitee Release attachment hash mismatch for ${fileName}`);
    }
  }

  console.log(`Created or updated Gitee Release ${release.version} with verified attachments.`);
}

const sourceManifest = JSON.parse(await readFile('manifest.json', 'utf8'));
const version =
  readArgument('--version') || process.env.RELEASE_VERSION || process.env.GITHUB_REF_NAME;
if (!version) throw new Error('Provide --version or RELEASE_VERSION');
parseSemver(version);

const assetDirectory = path.resolve(readArgument('--asset-dir') || process.cwd());
const repository = parseRepository(
  readArgument('--repository') ||
    process.env.GITEE_REPOSITORY ||
    'roronoazoro35/obsidian-video-summary-plugin',
);
const dryRun = hasFlag('--dry-run');
const token = process.env.GITEE_TOKEN;
const archiveName = `video-summary-${version}.zip`;
const releaseFiles = [
  'main.js',
  'manifest.json',
  'styles.css',
  'Obsidian.Video.Summary.json',
  archiveName,
  'SHA256SUMS',
];

if (sourceManifest.version !== version) {
  throw new Error(`Source manifest version ${sourceManifest.version} does not match ${version}`);
}
const sourceCommit = runGit(
  ['rev-parse', `refs/tags/${version}^{commit}`],
  process.cwd(),
  {},
).stdout.trim();
if (!/^[a-f0-9]{40}$/i.test(sourceCommit)) {
  throw new Error(`Could not resolve source commit for tag ${version}`);
}
const releaseManifest = JSON.parse(
  await readFile(path.join(assetDirectory, 'manifest.json'), 'utf8'),
);
if (releaseManifest.version !== version) {
  throw new Error(`Release manifest version ${releaseManifest.version} does not match ${version}`);
}

const checksumText = await readFile(path.join(assetDirectory, 'SHA256SUMS'), 'utf8');
const checksumEntries = new Map();
for (const line of checksumText.trim().split('\n')) {
  const match = line.match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
  if (!match) throw new Error(`Invalid SHA256SUMS line: ${line}`);
  if (checksumEntries.has(match[2])) throw new Error(`Duplicate SHA256SUMS entry: ${match[2]}`);
  checksumEntries.set(match[2], match[1].toLowerCase());
}

const hashedFiles = releaseFiles.filter((fileName) => fileName !== 'SHA256SUMS');
if (
  checksumEntries.size !== hashedFiles.length ||
  [...checksumEntries.keys()].some((fileName) => !hashedFiles.includes(fileName))
) {
  throw new Error('SHA256SUMS must contain exactly the five release-asset entries');
}

const hashes = {};
for (const fileName of releaseFiles) {
  const filePath = path.join(assetDirectory, fileName);
  hashes[fileName] = await sha256(filePath);
  if (fileName !== 'SHA256SUMS' && checksumEntries.get(fileName) !== hashes[fileName]) {
    throw new Error(`Checksum mismatch for ${fileName}`);
  }
}

const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'video-summary-gitee-release-'));
const username = process.env.GITEE_USERNAME || repository.owner;
const gitEnvironment = {};

try {
  if (token) {
    const askpassPath = path.join(temporaryDirectory, 'gitee-askpass.sh');
    await writeFile(
      askpassPath,
      `#!/bin/sh
case "$1" in
  *Username*) printf '%s\\n' "$GITEE_USERNAME" ;;
  *) printf '%s\\n' "$GITEE_TOKEN" ;;
esac
`,
    );
    await chmod(askpassPath, 0o700);
    Object.assign(gitEnvironment, {
      GIT_ASKPASS: askpassPath,
      GITEE_USERNAME: username,
      GITEE_TOKEN: token,
    });
  }

  const baseUrl = `${repository.webUrl}/raw/gitee-release-assets/releases/${version}/`;
  const release = {
    archiveName,
    assetDirectory,
    baseUrl,
    files: releaseFiles,
    hashes,
    repository,
    sourceCommit,
    token,
    version,
  };

  syncSourceTag(release, gitEnvironment, dryRun);
  await publishAssetBranch(temporaryDirectory, release, gitEnvironment, dryRun);

  if (dryRun) {
    console.log('Dry run skipped the Gitee Release API.');
  } else if (token) {
    await upsertGiteeRelease(release);
  } else {
    console.warn(
      'GITEE_TOKEN is not set; the asset branch was updated, but the Gitee Release page was not changed.',
    );
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
