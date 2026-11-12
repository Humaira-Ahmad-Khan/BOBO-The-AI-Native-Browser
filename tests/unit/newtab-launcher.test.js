'use strict';

/**
 * Google services launcher: catalog integrity + validated persistence.
 *
 * Runs with plain Node (no Electron). The renderer is exercised separately by
 * tests/e2e/newtab-smoke.js.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, test } = require('node:test');

const {
  GOOGLE_APPS,
  GOOGLE_APP_IDS,
  normalizeLauncherPrefs,
  publicGoogleApps,
} = require('../../src/main/google-apps');
const { SettingsService } = require('../../src/main/tools/settings');

const ROOT = path.resolve(__dirname, '../..');
const scratchDirs = [];

async function scratch() {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bobo-launcher-'));
  scratchDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of scratchDirs.splice(0)) {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

const REQUIRED = {
  account: 'https://myaccount.google.com/',
  drive: 'https://drive.google.com/',
  gmail: 'https://mail.google.com/',
  youtube: 'https://www.youtube.com/',
  maps: 'https://maps.google.com/',
  search: 'https://www.google.com/',
  calendar: 'https://calendar.google.com/',
  news: 'https://news.google.com/',
  photos: 'https://photos.google.com/',
  meet: 'https://meet.google.com/',
  translate: 'https://translate.google.com/',
  docs: 'https://docs.google.com/document/u/0/',
  sheets: 'https://docs.google.com/spreadsheets/u/0/',
  slides: 'https://docs.google.com/presentation/u/0/',
  contacts: 'https://contacts.google.com/',
  keep: 'https://keep.google.com/',
  forms: 'https://docs.google.com/forms/u/0/',
};

describe('Google services catalog', () => {
  test('contains exactly the 17 requested services with official URLs', () => {
    assert.equal(GOOGLE_APPS.length, 17);
    assert.deepEqual(GOOGLE_APP_IDS, Object.keys(REQUIRED));
    for (const [id, url] of Object.entries(REQUIRED)) {
      const app = GOOGLE_APPS.find((entry) => entry.id === id);
      assert.ok(app, `missing ${id}`);
      assert.equal(app.url, url, `${id} URL`);
      assert.match(app.name, /Google|Gmail|YouTube/, `${id} name`);
    }
  });

  test('ids and URLs are unique, and every icon exists inside src/assets/google', () => {
    assert.equal(new Set(GOOGLE_APP_IDS).size, GOOGLE_APP_IDS.length, 'unique ids');
    assert.equal(new Set(GOOGLE_APPS.map((app) => app.url)).size, GOOGLE_APPS.length, 'unique urls');
    for (const app of GOOGLE_APPS) {
      assert.equal(app.icon, path.basename(app.icon), `${app.id} icon stays in the icon directory`);
      assert.ok(
        fs.existsSync(path.join(ROOT, 'src/assets/google', app.icon)),
        `${app.icon} exists on disk`
      );
    }
  });

  test('public catalog exposes no filesystem path or extra field', () => {
    for (const app of publicGoogleApps()) {
      assert.deepEqual(Object.keys(app).sort(), ['icon', 'id', 'name', 'url']);
      for (const value of Object.values(app)) assert.equal(typeof value, 'string');
    }
  });
});

describe('launcher preferences validation', () => {
  test('defaults: catalog order, nothing hidden, current tab', () => {
    const prefs = normalizeLauncherPrefs(undefined);
    assert.deepEqual(prefs.order, GOOGLE_APP_IDS);
    assert.deepEqual(prefs.hidden, []);
    assert.equal(prefs.openInNewTab, false);
  });

  test('drops unknown/duplicate ids and appends missing catalog ids', () => {
    const prefs = normalizeLauncherPrefs({
      order: ['gmail', 'bogus', 'gmail', 'drive'],
      hidden: ['youtube', 'youtube', 'evil'],
      openInNewTab: 'yes',
    });

    assert.deepEqual(prefs.order.slice(0, 2), ['gmail', 'drive']);
    assert.equal(prefs.order.length, 17, 'every service stays available');
    assert.deepEqual(prefs.order.slice(-2), ['keep', 'forms'], 'missing ids appended in catalog order');
    assert.deepEqual(prefs.hidden, ['youtube']);
    assert.equal(prefs.openInNewTab, false, 'only a real boolean opts in');
  });

  test('preferences persist through SettingsService and survive reload', async (t) => {
    const dir = await scratch();
    const file = path.join(dir, 'settings.json');
    const settings = new SettingsService({ file });

    const defaults = await settings.launcherPrefs();
    assert.deepEqual(defaults.order, GOOGLE_APP_IDS);

    const hidden = ['news', 'meet'];
    const order = ['drive', 'gmail', ...GOOGLE_APP_IDS.filter((id) => id !== 'drive' && id !== 'gmail')];
    const saved = await settings.setLauncherPrefs({ order, hidden, openInNewTab: true });
    assert.deepEqual(saved.order, order);
    assert.deepEqual(saved.hidden, hidden);
    assert.equal(saved.openInNewTab, true);

    const reloaded = await new SettingsService({ file }).launcherPrefs();
    assert.deepEqual(reloaded, saved);

    // Partial patch keeps fields the renderer did not send.
    const patched = await settings.setLauncherPrefs({ hidden: [] });
    assert.deepEqual(patched.hidden, []);
    assert.deepEqual(patched.order, order);
    assert.equal(patched.openInNewTab, true);
  });

  test('an older settings file without a launcher section gets safe defaults', async () => {
    const dir = await scratch();
    const file = path.join(dir, 'settings.json');
    await fs.promises.writeFile(
      file,
      JSON.stringify({ version: 2, tools: {}, search: { engine: 'google' } }),
      'utf8'
    );

    const prefs = await new SettingsService({ file }).launcherPrefs();
    assert.deepEqual(prefs.order, GOOGLE_APP_IDS);
    assert.deepEqual(prefs.hidden, []);
    assert.equal(prefs.openInNewTab, false);
  });
});
