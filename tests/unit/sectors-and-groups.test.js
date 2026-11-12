'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const { Store } = require('../../src/main/db');
const { SavedGroupsService } = require('../../src/main/saved-groups');
const { SectorSelectorService, isPlaceholder } = require('../../src/main/tools/sectors');

const TMP = path.join(__dirname, '..', '.tmp');

async function testStore(t) {
  await fs.mkdir(TMP, { recursive: true });
  const dir = await fs.mkdtemp(path.join(TMP, 'db-test-'));
  const dbFile = path.join(dir, 'test.db');
  const store = new Store({ file: dbFile });
  t.after(async () => {
    store.close();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });
  return store;
}

describe('SavedGroupsService', () => {
  test('creates, lists, gets and deletes a saved group with tabs', async (t) => {
    const store = await testStore(t);
    const service = new SavedGroupsService({ store });

    const created = service.save({
      name: 'Work Project',
      color: 'green',
      tabs: [
        { url: 'https://github.com/project', title: 'GitHub' },
        { url: 'https://elgcd.punjab.gov.pk', title: 'eLGCD Portal' },
      ],
    });

    assert.ok(created.id > 0);
    assert.equal(created.name, 'Work Project');
    assert.equal(created.color, 'green');
    assert.equal(created.tabCount, 2);
    assert.equal(created.tabs[0].url, 'https://github.com/project');

    const list = service.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, created.id);
    assert.equal(list[0].tabCount, 2);

    const retrieved = service.get(created.id);
    assert.equal(retrieved.name, 'Work Project');
    assert.equal(retrieved.tabs.length, 2);

    const deleted = service.delete(created.id);
    assert.equal(deleted, true);
    assert.equal(service.list().length, 0);
    assert.equal(service.get(created.id), null);
  });

  test('cleans navigation metadata and preserves the saved snapshot on a rejected update', async (t) => {
    const service = new SavedGroupsService({ store: await testStore(t) });
    const group = service.save({
      name: 'Work',
      color: 'cyan',
      tabs: [
        { url: 'https://example.com/first?token=secret#auth', title: 'Page-supplied text' },
        { url: 'https://user:pass@example.com/' },
        { url: 'file:///internal.html' },
        { url: 'https://example.com/private', private: true },
        { url: 'https://example.com/second' },
      ],
    });
    assert.deepEqual(group.tabs.map(({ url, title, position }) => [url, title, position]), [
      ['https://example.com/first', '', 0],
      ['https://example.com/second', '', 1],
    ]);
    assert.throws(() => service.update(group.id, {
      name: 'Changed',
      tabs: [{ url: 'javascript:alert(1)' }],
    }), /no eligible web tabs/);
    assert.deepEqual(service.get(group.id), group);
    const renamed = service.update(group.id, { name: 'Renamed', color: 'orange' });
    assert.equal(renamed.name, 'Renamed');
    assert.equal(renamed.color, 'orange');
    assert.ok(renamed.updatedAt > group.updatedAt);
    assert.deepEqual(renamed.tabs, group.tabs);
  });
});

describe('SectorSelectorService', () => {
  test('placeholder detection', () => {
    assert.equal(isPlaceholder('Select Sector'), true);
    assert.equal(isPlaceholder('-- Select Option --'), true);
    assert.equal(isPlaceholder(''), true);
    assert.equal(isPlaceholder('51 – NoorPura'), false);
    assert.equal(isPlaceholder('Chak No.46/F'), false);
  });

  test('saves, searches, counts and clears sectors', async (t) => {
    const store = await testStore(t);
    const service = new SectorSelectorService({ store });

    const sample = [
      { code: '51', name: '51 – NoorPura', value: '51' },
      { code: '55', name: '55 – Satellite Town', value: '55' },
      { code: '33', name: '33 – Chak No.46/F', value: '33' },
      { code: '37', name: '37 – Chak No.15/G (Small)', value: '37' },
      { code: '', name: 'Select Sector', value: '' }, // placeholder
    ];

    const res = service.saveSectors(sample);
    assert.equal(res.ok, true);
    assert.equal(res.saved, 4);
    assert.equal(service.countSectors(), 4);

    // Search by code
    const byCode = service.listSectors('51');
    assert.equal(byCode.length, 1);
    assert.equal(byCode[0].code, '51');
    assert.equal(byCode[0].name, '51 – NoorPura');

    // Search by name partial
    const byName = service.listSectors('satellite');
    assert.equal(byName.length, 1);
    assert.equal(byName[0].code, '55');

    // Clear
    const cleared = service.clearSectors();
    assert.equal(cleared.ok, true);
    assert.equal(service.countSectors(), 0);
  });
});
