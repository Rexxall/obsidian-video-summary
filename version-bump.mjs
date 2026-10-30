import { readFileSync, writeFileSync } from 'fs';

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const versions = JSON.parse(readFileSync('versions.json', 'utf8'));

manifest.version = packageJson.version;
versions[packageJson.version] = manifest.minAppVersion;

writeFileSync('manifest.json', JSON.stringify(manifest, null, 2) + '\n');
writeFileSync('versions.json', JSON.stringify(versions, null, 2) + '\n');

// The backend package pulls the image published for this exact version.
const compose = readFileSync('backend/compose.yaml', 'utf8');
writeFileSync(
  'backend/compose.yaml',
  compose.replace(
    /(ghcr\.io\/rexxall\/video-summary-backend:)[0-9]+\.[0-9]+\.[0-9]+/,
    `$1${packageJson.version}`,
  ),
);
