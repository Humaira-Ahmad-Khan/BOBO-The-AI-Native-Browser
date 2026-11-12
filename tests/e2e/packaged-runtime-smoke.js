'use strict';

// Runs the offline fixtures with BOBO.exe, app.isPackaged=true and ASAR preloads.
// Uses repository-local dummy profiles only; never launches the installed profile.
// node tests/e2e/packaged-runtime-smoke.js daily-receive
// node tests/e2e/packaged-runtime-smoke.js passwords save
// node tests/e2e/packaged-runtime-smoke.js passwords verify
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { packager } = require('@electron/packager');
const repo = path.resolve(__dirname, '../..');
const feature = process.argv[2];
function copyTree(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name), to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else fs.copyFileSync(from, to);
  }
}
if (!['daily-receive', 'passwords', 'youtube-navigation'].includes(feature) ||
    feature === 'passwords' && !['save', 'verify'].includes(process.argv[3])) {
  throw new Error('Choose daily-receive, youtube-navigation or passwords save/verify.');
}
async function main() {
  console.log(`Packaging offline ${feature} fixture...`);
  const root = fs.mkdtempSync(path.join(__dirname, '.tmp/packaged-runtime-'));
  const staging = path.join(root, 'app');
  fs.mkdirSync(staging);
  copyTree(path.join(repo, 'src'), path.join(staging, 'src'));
  const metadata = require('../../package.json');
  fs.writeFileSync(path.join(staging, 'package.json'), JSON.stringify({
    name: metadata.name, productName: metadata.productName, version: metadata.version, main: 'smoke.js',
  }));
  fs.writeFileSync(path.join(staging, 'smoke.js'),
    "if (!require('electron').app.isPackaged) throw Error('Expected packaged runtime'); require(process.env.BOBO_SMOKE_ENTRY);\n");
  console.log('Fixture source staged.');
  const [runtime] = await packager({ dir: staging, name: 'BOBO', platform: 'win32', arch: 'x64',
    electronVersion: require('electron/package.json').version,
    electronZipDir: path.join(repo, 'out-offline-runtime'),
    out: path.join(root, 'build'), asar: true, prune: false,
  });
  const archive = path.join(runtime, 'resources/app.asar');
  const args = feature === 'passwords' ? [`--stage=${process.argv[3]}`,
    ...(process.argv.includes('--native-submit') ? ['--native-submit'] : []),
    ...(process.argv.includes('--angular-form') ? ['--angular-form'] : []),
    ...(process.argv.includes('--legacy-controls') ? ['--legacy-controls'] : [])] : [];
  const child = spawn(path.join(runtime, 'BOBO.exe'), args, {
    cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, BOBO_SMOKE_APP_ROOT: archive,
      BOBO_SMOKE_ENTRY: path.join(__dirname, `${feature}-smoke.js`) },
  });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
}
main().catch(error => { console.error(error); process.exitCode = 1; });
