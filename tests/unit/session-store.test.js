'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  MAX_TABS,
  SessionStore,
  fitBounds,
  sanitize,
} = require('../../src/main/session-store');

test('session checkpoints omit private tabs and credential URLs and keep the selected tab', () => {
  const privateTab = { url: 'https://private.test/', private: true };
  const credentialTab = { url: 'https://user:secret@example.test/', pinned: true };
  const first = { url: 'https://first.test/', pinned: false };
  const active = { url: 'https://active.test/', pinned: false };
  const snapshot = sanitize({
    tabs: [privateTab, first, credentialTab, active],
    activeIndex: 3,
    closed: [privateTab, credentialTab],
  });
  assert.equal(snapshot.version, 2);
  assert.equal(snapshot.windows.length, 1);
  assert.deepEqual(snapshot.windows[0].tabs, [
    { url: 'https://first.test/', title: '', pinned: false, groupKey: null, crashCount: 0 },
    { url: 'https://active.test/', title: '', pinned: false, groupKey: null, crashCount: 0 },
  ]);
  assert.equal(snapshot.windows[0].activeIndex, 1);
  assert.deepEqual(snapshot.windows[0].closed, []);
});

test('legacy v1 saved group metadata becomes a live group on restore', () => {
  const snapshot = sanitize({
    version: 1,
    tabs: [
      {
        url: 'https://one.test/',
        pinned: false,
        savedGroup: { key: '12:1700000000000', name: 'Work', color: 'blue' },
      },
      {
        url: 'https://two.test/',
        pinned: false,
        savedGroup: { key: '12:1700000000000', name: 'Work', color: 'blue' },
      },
    ],
    activeIndex: 0,
  });
  const window = snapshot.windows[0];
  assert.deepEqual(window.groups, [{
    key: '12:1700000000000',
    name: 'Work',
    color: 'blue',
    collapsed: false,
    savedKey: '12:1700000000000',
  }]);
  assert.deepEqual(window.tabs.map((tab) => tab.groupKey), ['12:1700000000000', '12:1700000000000']);
});

test('multi-window sessions keep geometry, order, pins and crash counts', () => {
  const snapshot = sanitize({
    windows: [
      {
        bounds: { x: 20, y: 30, width: 1000, height: 700 },
        maximized: true,
        activeIndex: 1,
        tabs: [
          { url: 'https://pinned.test/', pinned: true, crashCount: 2 },
          { url: 'https://second.test/', title: 'Second' },
        ],
        groups: [{ key: 'grp_a', name: 'Group', color: 'red', collapsed: true }],
        closed: [{ url: 'https://closed.test/', title: 'Closed' }],
      },
      { tabs: [{ url: 'https://other.test/' }] },
    ],
  });
  assert.equal(snapshot.windows.length, 2);
  assert.deepEqual(snapshot.windows[0].bounds, { x: 20, y: 30, width: 1000, height: 700 });
  assert.equal(snapshot.windows[0].maximized, true);
  assert.equal(snapshot.windows[0].activeIndex, 1);
  assert.equal(snapshot.windows[0].tabs[0].crashCount, 2);
  assert.equal(snapshot.windows[0].groups[0].collapsed, true);
  assert.deepEqual(snapshot.windows[0].closed, [{ url: 'https://closed.test/', title: 'Closed' }]);
  assert.equal(snapshot.windows[1].tabs.length, 1);
});

test('session tabs are capped and a tab cannot reference an unknown group', () => {
  const tabs = Array.from({ length: MAX_TABS + 5 }, (_, index) => ({
    url: `https://site${index}.test/`,
    groupKey: 'grp_missing',
  }));
  const snapshot = sanitize({ windows: [{ tabs }] });
  assert.equal(snapshot.windows[0].tabs.length, MAX_TABS);
  assert.ok(snapshot.windows[0].tabs.every((tab) => tab.groupKey === null));
});

test('off-screen window bounds are recentred on the available display', () => {
  const displays = [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }];
  assert.deepEqual(
    fitBounds({ x: 5000, y: 5000, width: 800, height: 600 }, displays),
    { x: 560, y: 240, width: 800, height: 600 }
  );
  const visible = { x: 100, y: 100, width: 900, height: 700 };
  assert.deepEqual(fitBounds(visible, displays), visible);
});

test('SessionStore writes v2 atomically, reads it back and preserves a recovery copy', () => {
  const directory = fs.mkdtempSync(path.join(__dirname, 'session-store-'));
  const file = path.join(directory, 'session.json');
  const store = new SessionStore({ file });
  try {
    store.write({
      windows: [{
        bounds: { x: 10, y: 10, width: 900, height: 700 },
        tabs: [{ url: 'https://kept.test/', pinned: true }],
        activeIndex: 0,
      }],
    }, { cleanExit: false });
    const read = store.read();
    assert.equal(read.version, 2);
    assert.equal(read.cleanExit, false);
    assert.equal(read.windows[0].tabs[0].url, 'https://kept.test/');
    assert.equal(read.windows[0].tabs[0].pinned, true);
    assert.ok(read.savedAt > 0);

    const recovery = store.preserve('crash');
    assert.ok(recovery && fs.existsSync(recovery));
    assert.equal(JSON.parse(fs.readFileSync(recovery, 'utf8')).version, 2);

    // A corrupt file is quarantined instead of blocking startup.
    fs.writeFileSync(file, '{not json', 'utf8');
    const empty = store.read();
    assert.deepEqual(empty.windows, []);
    assert.equal(store.recovered, true);
    assert.ok(fs.readdirSync(directory).some((name) => name.startsWith('session.json.corrupt-')));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
