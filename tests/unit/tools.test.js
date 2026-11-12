'use strict';

/**
 * Unit tests for the BOBO Tools domain layer.
 *
 * No Electron is needed: the storage helpers, the URL policy, the settings and
 * notes services, and the IPC payload validators are all plain Node modules.
 *
 * Temporary files live in tests/.tmp/ (git-ignored) so nothing is written
 * outside the repository, and every test removes its own directory.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const lib = require('../../src/main/tools/lib');
const format = require('../../src/main/tools/format');
const { FONT_SIZES, SettingsService, clampFontSize } = require('../../src/main/tools/settings');
const { NotesService, readNoteInput } = require('../../src/main/tools/notes');
const { DEFAULT_SEARCH_ENGINE, isSearchEngine, publicSearchEngines, searchEngine, searchUrl } = require('../../src/main/search');
const { readReaderDocument, safeFileName, stampedName } = require('../../src/main/tools/ipc');

const TMP = path.join(__dirname, '..', '.tmp');

async function scratch(t) {
  await fs.mkdir(TMP, { recursive: true });
  const dir = await fs.mkdtemp(path.join(TMP, 'unit-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

// --- storage helpers -------------------------------------------------------

describe('lib: input validation at the IPC boundary', () => {
  test('cleanText strips control characters and trims', () => {
    assert.equal(lib.cleanText('  hello\u0000\u0007 world \n', 100), 'hello world');
    assert.equal(lib.cleanText(null, 100), '');
  });

  test('text truncates instead of throwing', () => {
    assert.equal(lib.text('abcdef', 3), 'abc');
  });

  test('optionalUrl keeps http(s) and rejects every other scheme', () => {
    assert.equal(lib.optionalUrl(''), '');
    assert.equal(lib.optionalUrl(null), '');
    assert.equal(lib.optionalUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
    for (const bad of ['javascript:alert(1)', 'file:///C:/secret.txt', 'data:text/html,x', 'not a url']) {
      assert.throws(() => lib.optionalUrl(bad), /invalid url/, bad);
    }
  });

  test('noteId only accepts short slug-shaped ids', () => {
    assert.equal(lib.noteId('abc-123'), 'abc-123');
    assert.throws(() => lib.noteId('../../etc/passwd'), /invalid note id/);
    assert.throws(() => lib.noteId('x'.repeat(lib.LIMITS.id + 1)), /invalid note id/);
    assert.throws(() => lib.noteId(42), /invalid note id/);
  });

  test('pngDataUrl only accepts a PNG data URL', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    assert.equal(lib.pngDataUrl(png), png);
    assert.throws(() => lib.pngDataUrl('data:image/jpeg;base64,AAAA'), /PNG data URL/);
    assert.throws(() => lib.pngDataUrl('https://example.com/a.png'), /PNG data URL/);
  });

  test('JsonFile round-trips, then preserves a corrupt file instead of losing it', async (t) => {
    const dir = await scratch(t);
    const file = path.join(dir, 'data.json');

    const json = new lib.JsonFile(file, { hello: 'world' });
    assert.deepEqual(await json.read(), { hello: 'world' }, 'missing file -> defaults');

    await json.write({ hello: 'again' });
    assert.deepEqual(await json.read(), { hello: 'again' });

    await fs.writeFile(file, '{ this is not json', 'utf8');
    const recovered = new lib.JsonFile(file, { hello: 'default' });
    assert.deepEqual(await recovered.read(), { hello: 'default' });
    assert.equal(recovered.recovered, true);

    const kept = (await fs.readdir(dir)).filter((name) => name.startsWith('data.json.corrupt-'));
    assert.equal(kept.length, 1, 'the unreadable file is kept as a backup');
  });
});

// --- page safety policy ----------------------------------------------------

describe('format: what Reader is allowed to read', () => {
  test('sensitive hosts match exactly and by subdomain', () => {
    assert.equal(format.isSensitiveHost('mail.google.com'), true);
    assert.equal(format.isSensitiveHost('accounts.google.com'), true);
    assert.equal(format.isSensitiveHost('notgmail.com'), false);
    assert.equal(format.isSensitiveHost('example.com'), false);
  });

  test('auth-looking paths are refused', () => {
    assert.equal(format.isAuthPath('https://example.com/login'), true);
    assert.equal(format.isAuthPath('https://example.com/sign-in?next=/'), true);
    assert.equal(format.isAuthPath('https://example.com/session/42'), true);
    assert.equal(format.isAuthPath('https://example.com/articles/login-history'), false);
    assert.equal(format.isAuthPath('https://example.com/reading'), false);
  });

  test('isSensitiveUrl combines host and path rules', () => {
    assert.equal(format.isSensitiveUrl('https://accounts.google.com/signin'), true);
    assert.equal(format.isSensitiveUrl('https://paypal.com/checkout'), true);
    assert.equal(format.isSensitiveUrl('https://example.com/article'), false);
    assert.equal(format.isSensitiveUrl('not a url'), false);
  });

  test('markdown builders keep title, body and source', () => {
    const note = {
      title: 'Shopping',
      body: 'Milk\nEggs',
      url: 'https://example.com/list',
      updatedAt: Date.UTC(2026, 10, 3, 12, 30),
    };
    const one = format.noteToMarkdown(note);
    assert.match(one, /^# Shopping/);
    assert.match(one, /Milk/);
    assert.match(one, /Source: https:\/\/example\.com\/list/);

    const many = format.notesToMarkdown([note, { title: 'Second', body: 'Hi' }]);
    assert.match(many, /## Shopping/);
    assert.match(many, /## Second/);

    const page = format.readerToMarkdown({
      title: 'An article',
      url: 'https://example.com/a',
      blocks: [
        { kind: 'heading', text: 'Intro' },
        { kind: 'text', text: 'Body text.' },
      ],
    });
    assert.match(page, /^# An article/);
    assert.match(page, /## Intro/);
    assert.match(page, /Body text\./);
  });
});

// --- settings --------------------------------------------------------------

describe('search providers', () => {
  test('Google is the default and DuckDuckGo stays available', () => {
    assert.equal(DEFAULT_SEARCH_ENGINE, 'google');
    assert.equal(searchUrl('google'), 'https://www.google.com/search?q=');
    assert.equal(searchUrl('duckduckgo'), 'https://duckduckgo.com/?q=');
    assert.equal(searchEngine('duckduckgo').label, 'DuckDuckGo');
    assert.deepEqual(publicSearchEngines().map((engine) => engine.id), ['google', 'duckduckgo']);
  });

  test('engine ids are validated exactly', () => {
    assert.equal(isSearchEngine('google'), true);
    assert.equal(isSearchEngine('duckduckgo'), true);
    assert.equal(isSearchEngine('GOOGLE'), false);
    assert.equal(isSearchEngine('bing'), false);
    assert.equal(isSearchEngine(null), false);
  });
});

describe('settings service', () => {
  test('defaults: all tools enabled, screenshot pinned, reader 17px, Google search', async (t) => {
    const dir = await scratch(t);
    const settings = new SettingsService({ file: path.join(dir, 'settings.json') });
    const state = await settings.state();

    assert.deepEqual(state.tools.map((tool) => tool.id), ['screenshot', 'notes', 'reader', 'social-video', 'web-scraper', 'linkedin-capture', 'youtube-auto-skip', 'ad-free-youtube', 'transcript', 'sectors']);
    assert.ok(state.tools.every((tool) => tool.enabled));
    assert.equal(state.tools.find((tool) => tool.id === 'screenshot').pinned, true);
    assert.equal(state.reader.fontSize, 17);
    assert.equal(state.search.engine, 'google');
    assert.deepEqual(state.search.options.map((option) => option.id), ['google', 'duckduckgo']);
    assert.match(state.storage, /settings\.json$/);
  });

  test('search engine choice persists and rejects unknown providers', async (t) => {
    const dir = await scratch(t);
    const file = path.join(dir, 'settings.json');
    const settings = new SettingsService({ file });

    const changed = await settings.setSearchEngine('duckduckgo');
    assert.equal(changed.search.engine, 'duckduckgo');
    assert.equal(await settings.searchEngine(), 'duckduckgo');

    const reloaded = await new SettingsService({ file }).state();
    assert.equal(reloaded.search.engine, 'duckduckgo');

    await assert.rejects(() => settings.setSearchEngine('bing'), /unknown search engine/);
    await assert.rejects(() => settings.setSearchEngine(null), /unknown search engine/);

    const reset = await settings.resetTools();
    assert.equal(reset.search.engine, 'duckduckgo', 'clearing tool data keeps the browser search preference');
  });

  test('a settings file from before the search setting defaults to Google', async (t) => {
    const dir = await scratch(t);
    const file = path.join(dir, 'settings.json');
    await fs.writeFile(
      file,
      JSON.stringify({
        version: 1,
        tools: { notes: { enabled: false, pinned: true } },
        reader: { fontSize: 20 },
      }),
      'utf8'
    );

    const state = await new SettingsService({ file }).state();
    assert.equal(state.search.engine, 'google', 'missing search key -> Google');
    assert.equal(state.tools.find((tool) => tool.id === 'notes').enabled, false, 'old tool prefs survive');
    assert.equal(state.tools.find((tool) => tool.id === 'notes').pinned, true);
    assert.equal(state.reader.fontSize, 20);
  });

  test('enable and pin decisions persist across instances', async (t) => {
    const dir = await scratch(t);
    const file = path.join(dir, 'settings.json');
    const settings = new SettingsService({ file });

    const next = await settings.configure({ id: 'notes', enabled: false, pinned: true });
    const notes = next.tools.find((tool) => tool.id === 'notes');
    assert.equal(notes.enabled, false);
    assert.equal(notes.pinned, true);

    const reloaded = await new SettingsService({ file }).state();
    const again = reloaded.tools.find((tool) => tool.id === 'notes');
    assert.equal(again.enabled, false);
    assert.equal(again.pinned, true);
  });

  test('unknown tools and unknown boolean fields are ignored or rejected', async (t) => {
    const dir = await scratch(t);
    const settings = new SettingsService({ file: path.join(dir, 'settings.json') });

    await assert.rejects(() => settings.configure({ id: 'shell', enabled: true }), /unknown tool/);
    await settings.configure({ id: 'reader', enabled: 'yes' }); // not a boolean -> no change
    const state = await settings.state();
    assert.equal(state.tools.find((tool) => tool.id === 'reader').enabled, true);
  });

  test('reader font size is clamped to the usable range', async (t) => {
    assert.equal(clampFontSize(2), FONT_SIZES.min);
    assert.equal(clampFontSize(99), FONT_SIZES.max);
    assert.equal(clampFontSize('not a number'), 17);
    assert.equal(clampFontSize(17.6), 18);

    const dir = await scratch(t);
    const settings = new SettingsService({ file: path.join(dir, 'settings.json') });
    const state = await settings.setPrefs({ fontSize: 200 });
    assert.equal(state.reader.fontSize, FONT_SIZES.max);
  });

  test('resetTools restores the defaults', async (t) => {
    const dir = await scratch(t);
    const settings = new SettingsService({ file: path.join(dir, 'settings.json') });
    await settings.configure({ id: 'screenshot', enabled: false });
    const state = await settings.resetTools();
    assert.equal(state.tools.find((tool) => tool.id === 'screenshot').enabled, true);
  });
});

// --- notes -----------------------------------------------------------------

describe('notes service', () => {
  test('create, update, list, export and delete', async (t) => {
    const dir = await scratch(t);
    const file = path.join(dir, 'notes.json');
    const notes = new NotesService({ file });

    const created = await notes.save({
      title: 'Article idea',
      body: 'Write about local-first tools.',
      url: 'https://example.com/post',
      pageTitle: 'Example',
    });
    assert.ok(created.note.id);
    assert.equal(created.note.title, 'Article idea');
    assert.equal(created.note.url, 'https://example.com/post');

    const updated = await notes.save({ ...created.note, body: 'Edited body.' });
    assert.equal(updated.note.id, created.note.id, 'updating keeps the id');

    const list = await notes.list();
    assert.equal(list.notes.length, 1);
    assert.equal(list.notes[0].body, 'Edited body.');

    const markdown = await notes.markdown({ id: created.note.id });
    assert.match(markdown.text, /^# Article idea/);
    assert.match(markdown.text, /Edited body\./);

    const all = await notes.markdown(null);
    assert.match(all.text, /Article idea/);

    const removed = await notes.remove({ id: created.note.id });
    assert.equal(removed.ok, true);
    assert.equal((await notes.list()).notes.length, 0);

    const missing = await notes.remove({ id: created.note.id });
    assert.equal(missing.ok, false, 'deleting twice reports, it does not throw');
  });

  test('notes survive a reload from disk', async (t) => {
    const dir = await scratch(t);
    const file = path.join(dir, 'notes.json');
    await new NotesService({ file }).save({ title: 'Persisted', body: 'Still here.' });

    const reloaded = await new NotesService({ file }).list();
    assert.equal(reloaded.notes.length, 1);
    assert.equal(reloaded.notes[0].title, 'Persisted');
  });

  test('invalid notes are rejected before they touch the file', async (t) => {
    const dir = await scratch(t);
    const notes = new NotesService({ file: path.join(dir, 'notes.json') });

    await assert.rejects(() => notes.save({ title: '', body: '' }), /title is required/);
    await assert.rejects(
      () => notes.save({ title: 'Evil', body: 'x', url: 'javascript:alert(1)' }),
      /invalid url/
    );
    await assert.rejects(() => notes.save('not an object'), /invalid note/);
    assert.equal((await notes.list()).notes.length, 0);
  });

  test('readNoteInput trims and derives nothing on its own', () => {
    const input = readNoteInput({ title: '  Title  ', body: '  body  ', url: '' });
    assert.equal(input.title, 'Title');
    assert.equal(input.body, 'body');
    assert.equal(input.url, '');
  });

  test('clear() empties the store', async (t) => {
    const dir = await scratch(t);
    const notes = new NotesService({ file: path.join(dir, 'notes.json') });
    await notes.save({ title: 'One', body: '1' });
    await notes.clear();
    assert.equal((await notes.list()).notes.length, 0);
  });
});

// --- IPC payload helpers ---------------------------------------------------

describe('ipc helpers', () => {
  test('safeFileName strips path and shell characters', () => {
    const name = safeFileName('../My page: notes? *', 'fallback');
    assert.doesNotMatch(name, /[<>:"/\\|?*]/);
    assert.doesNotMatch(name, /^\./);
    assert.ok(name.length <= 80);
    assert.equal(safeFileName('', 'bobo-page'), 'bobo-page');
    assert.equal(safeFileName('...', 'bobo-page'), 'bobo-page');
  });

  test('stampedName is timestamped and deterministic', () => {
    const name = stampedName('bobo-screenshot', 'png', new Date(2026, 10, 3, 15, 20, 10));
    assert.equal(name, 'bobo-screenshot-20261103-152010.png');
  });

  test('readReaderDocument validates and normalises an untrusted document', () => {
    const doc = readReaderDocument({
      title: '  Title  ',
      url: 'https://example.com/a',
      blocks: [
        { kind: 'heading', text: ' Intro ' },
        { kind: 'script', text: 'Body' },
        { kind: 'text', text: '   ' },
      ],
    });
    assert.equal(doc.title, 'Title');
    assert.deepEqual(doc.blocks, [
      { kind: 'heading', text: 'Intro' },
      { kind: 'text', text: 'Body' },
    ]);

    assert.throws(() => readReaderDocument({ title: 'x', blocks: [] }), /nothing to save/);
    assert.throws(
      () => readReaderDocument({ title: 'x', url: 'javascript:alert(1)', blocks: [{ text: 'x' }] }),
      /invalid url/
    );
  });
});
