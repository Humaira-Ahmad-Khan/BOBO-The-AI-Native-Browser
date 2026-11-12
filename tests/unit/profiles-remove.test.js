'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Profiles, COLORS } = require('../../src/main/profiles');

test('A profile can be removed, Default cannot, and its data folder is kept', () => {
  fs.mkdirSync(path.join(__dirname, '.tmp'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(__dirname, '.tmp', 'profiles-remove-'));
  try {
    const profiles = new Profiles(dir);
    const added = profiles.edit({ name: 'ayesha', color: COLORS[3] });
    const data = profiles.directory(added.id);
    fs.mkdirSync(data, { recursive: true });
    assert.equal(profiles.list().length, 2);
    assert.throws(() => profiles.remove('default'), /cannot be deleted/);
    profiles.remove(added.id);
    assert.deepEqual(profiles.list().map((p) => p.id), ['default']);
    assert.ok(fs.existsSync(data));
    assert.throws(() => profiles.remove(added.id), /not found/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
