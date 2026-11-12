'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test, describe } = require('node:test');
const {
  MAX_STARTUP_URLS,
  SettingsService,
  parseStartupUrls,
  sanitizeStartupUrls,
} = require('../../src/main/tools/settings');

const TMP = path.join(__dirname, '..', '.tmp');

async function scratch(t) {
  await fs.mkdir(TMP, { recursive: true });
  const dir = await fs.mkdtemp(path.join(TMP, 'startup-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

describe('startup preferences', () => {
  test('stored startup URLs are filtered to normal http(s) addresses', () => {
    assert.deepEqual(sanitizeStartupUrls([
      'https://example.com/',
      'http://example.org/path?q=1',
      'javascript:alert(1)',
      'file:///C:/secret.txt',
      'https://user:pass@example.net/',
      'not a url',
      42,
    ]), ['https://example.com/', 'http://example.org/path?q=1']);
  });

  test('saving startup pages rejects unsafe or excessive input', () => {
    assert.deepEqual(parseStartupUrls(['https://example.com/']), ['https://example.com/']);
    assert.throws(() => parseStartupUrls(['chrome://settings']), /http\(s\)/);
    assert.throws(() => parseStartupUrls(['https://user:secret@example.com/']), /http\(s\)/);
    assert.throws(
      () => parseStartupUrls(Array.from({ length: MAX_STARTUP_URLS + 1 }, () => 'https://example.com/')),
      /too many/
    );
  });

  test('startup mode persists and keeps the legacy restoreSession flag in sync', async (t) => {
    const dir = await scratch(t);
    const file = path.join(dir, 'settings.json');
    const settings = new SettingsService({ file });

    let state = await settings.setBrowserPrefs({
      startup: { mode: 'specific', urls: ['https://example.com/', 'https://example.org/'] },
    });
    assert.equal(state.browser.startup.mode, 'specific');
    assert.deepEqual(state.browser.startup.urls, ['https://example.com/', 'https://example.org/']);
    assert.equal(state.browser.tabs.restoreSession, false);

    const reloaded = await new SettingsService({ file }).state();
    assert.equal(reloaded.browser.startup.mode, 'specific');
    assert.equal(reloaded.browser.startup.urls.length, 2);

    state = await settings.setBrowserPrefs({ startup: { mode: 'continue' } });
    assert.equal(state.browser.startup.mode, 'continue');
    assert.equal(state.browser.tabs.restoreSession, true);

    await assert.rejects(
      settings.setBrowserPrefs({ startup: { mode: 'unknown' } }),
      /unknown startup mode/
    );
  });

  test('a v1 settings file with only restoreSession selects the matching startup mode', async (t) => {
    const dir = await scratch(t);
    const file = path.join(dir, 'settings.json');
    await fs.writeFile(file, JSON.stringify({
      version: 2,
      browser: { tabs: { restoreSession: false, savedGroupsShortcut: '' } },
    }), 'utf8');
    const state = await new SettingsService({ file }).state();
    assert.equal(state.browser.startup.mode, 'newtab');
  });
});
