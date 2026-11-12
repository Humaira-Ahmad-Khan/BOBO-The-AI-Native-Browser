'use strict';

// Offline build gate: the executable must ship the version and sources just built.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const asar = require('@electron/asar');
const repo = path.resolve(__dirname, '..');
const archive = path.join(repo, 'out/BOBO-win32-x64/resources/app.asar');
const entries = new Map(asar.listPackage(archive).map(entry =>
  [entry.replace(/\\/g, '/').replace(/^\//, ''), entry.replace(/^[/\\]/, '')]));
function read(name) {
  assert.ok(entries.has(name), `Packaged file missing: ${name}`);
  return asar.extractFile(archive, entries.get(name));
}
const metadata = require('../package.json');
const packaged = JSON.parse(read('package.json'));
assert.equal(packaged.version, metadata.version, 'Packaged version is stale');
assert.equal(packaged.main, metadata.main, 'Packaged entry point differs');
let count = 0;
function check(directory) {
  for (const entry of fs.readdirSync(path.join(repo, directory), { withFileTypes: true })) {
    const name = `${directory}/${entry.name}`;
    if (entry.isDirectory()) check(name);
    else {
      assert.ok(read(name).equals(fs.readFileSync(path.join(repo, name))), `Packaged source is stale: ${name}`);
      count++;
    }
  }
}
check('src');
console.log(`Verified BOBO ${metadata.version}: ${count} packaged source files match the working tree.`);
