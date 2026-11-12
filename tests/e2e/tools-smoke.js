'use strict';

/**
 * BOBO Tools smoke check - run with `npm run smoke`.
 *
 * Two layers, both real code paths:
 *
 *   1. Service + IPC layer: the actual tool modules, a real hidden WebContents
 *      for screenshot capture, real clipboard writes, real JSON files under
 *      tests/e2e/.tmp (never the user's %APPDATA%), and the real IPC handlers
 *      with the save/confirm dialogs replaced by deterministic stubs.
 *   2. Chrome UI: index.html loaded with the real preload and the real tool
 *      handlers, driven by clicking the actual buttons. Notes persist across a
 *      reload; enable/pin state persists; Reader renders untrusted text as text.
 *
 * Reader policy cannot be tested against a live http(s) page offline, so the
 * mechanical extraction runs against a local fixture and the policy branches run
 * against stub WebContents objects (URL -> refusal happens before any script).
 *
 * No network, no visible window, no user data. Exit code 1 on failure.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, dialog, clipboard, nativeImage } = require('electron');

const { createToolServices } = require('../../src/main/tools/service');
const { registerToolIpc } = require('../../src/main/tools/ipc');
const reader = require('../../src/main/tools/reader');
const screenshots = require('../../src/main/tools/screenshots');

const ROOT = path.resolve(__dirname, '../..');
const RENDERER = path.join(ROOT, 'src/renderer');
const CHROME_HTML = path.join(RENDERER, 'index.html');
const PRELOAD = path.join(ROOT, 'src/preload/preload.js');
const FIXTURE = path.join(__dirname, 'fixtures/article.html');
const SHOTS = path.join(__dirname, 'screenshots');

const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${message}`);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function expectReject(run, pattern, label) {
  try {
    await run();
    check(false, `${label} (did not reject)`);
  } catch (error) {
    check(pattern.test(error.message), `${label} (${error.message})`);
  }
}

// --- shared harness state --------------------------------------------------

let pageWin = null; // real WebContents showing the local fixture
let chromeWin = null; // the BOBO chrome page
let readerTarget = null; // swap-in WebContents stub for Reader UI tests

const js = (code) => chromeWin.webContents.executeJavaScript(code);

async function until(expression, label, timeout = 8000) {
  const start = Date.now();
  for (;;) {
    const value = await js(expression);
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${label}`);
    await sleep(60);
  }
}

async function untilFile(file, predicate, label, timeout = 8000) {
  const start = Date.now();
  for (;;) {
    try {
      const value = JSON.parse(await fsp.readFile(file, 'utf8'));
      if (predicate(value)) return value;
    } catch {
      // file not written yet
    }
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${label}`);
    await sleep(60);
  }
}

function setValue(id, value) {
  return `(() => {
    const el = document.getElementById(${JSON.stringify(id)});
    el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`;
}

function toggle(selector, checked) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    el.checked = ${checked ? 'true' : 'false'};
    el.dispatchEvent(new Event('change', { bubbles: true }));
  })()`;
}

// --- 1. service + IPC layer ------------------------------------------------

async function checkServices({ dataDir }) {
  const services = createToolServices({ dataDir });
  const handlers = new Map();
  const calls = [];

  registerToolIpc({
    handle: (channel, run) => {
      handlers.set(channel, run);
      calls.push(channel);
    },
    services,
    getActiveWebContents: () => readerTarget || (pageWin && pageWin.webContents) || null,
    getWindow: () => chromeWin,
  });

  const preload = fs.readFileSync(PRELOAD, 'utf8');
  const toolChannels = [
    ...new Set(
      [...preload.matchAll(/'(bobo:(?:tools|screenshot|notes|reader):[^']+)'/g)].map((match) => match[1])
    ),
  ];
  check(toolChannels.length === 14, `preload exposes 14 tool channels (got ${toolChannels.length})`);
  for (const channel of toolChannels) {
    check(handlers.has(channel), `handler registered for ${channel}`);
  }

  // --- screenshot ---------------------------------------------------------

  const shot = await handlers.get('bobo:screenshot:capture')();
  check(!!shot && shot.ok === true, 'capture returns ok for a real WebContents');
  check(/^data:image\/png;base64,/.test(shot.dataUrl || ''), 'capture returns a PNG data URL');

  const decoded = nativeImage.createFromDataURL(shot.dataUrl);
  const size = decoded.getSize();
  check(size.width > 0 && size.height > 0, `captured image decodes (${size.width}x${size.height})`);

  const shotPath = path.join(dataDir, 'service-capture.png');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: shotPath });
  const savedShot = await handlers.get('bobo:screenshot:save')({ dataUrl: shot.dataUrl });
  check(savedShot.ok === true, 'screenshot save reports success');
  check(fs.existsSync(shotPath), 'screenshot file exists on disk');
  const png = fs.readFileSync(shotPath);
  check(png.subarray(0, 8).toString('hex') === '89504e470d0a1a0a', 'saved file has a PNG signature');
  check(png.length > 1000, `saved PNG is not empty (${png.length} bytes)`);

  const copied = await handlers.get('bobo:screenshot:copy')({ dataUrl: shot.dataUrl });
  check(copied.ok === true && (await clipboard.has('image/png')), 'screenshot reaches the clipboard');

  await expectReject(
    () => handlers.get('bobo:screenshot:copy')({ dataUrl: 'data:image/jpeg;base64,AAAA' }),
    /PNG data URL/,
    'non-PNG screenshot payload is rejected'
  );

  // --- reader mechanics against the local fixture -------------------------

  const extracted = await reader.extractFrom(pageWin.webContents);
  check(!!extracted && extracted.ok === true, 'Reader extracts the local fixture');
  check(/Reader fixture/.test(extracted.title), 'Reader returns the page title');
  check(/Arctic Frost palette uses Snow White/.test(extracted.text), 'Reader returns article text');
  check(/Reader mode should return this sentence/.test(extracted.text), 'Reader returns sub-heading body');
  check(!extracted.text.includes('hunter2'), 'Reader never returns password values');
  check(!extracted.text.includes('SECRET-TOKEN'), 'Reader never returns hidden input values');
  check(!extracted.text.includes('private-user'), 'Reader never returns text input values');
  check(!extracted.text.includes('Submit now please'), 'Reader never returns form controls');
  check(!extracted.text.includes('SCRIPT-LEAK'), 'Reader never returns script contents');
  check(extracted.passwordFields === 1, 'Reader detects the visible password field');

  // Policy: sensitive host refused before the page is touched at all.
  let touched = 0;
  const sensitive = {
    isDestroyed: () => false,
    getURL: () => 'https://mail.google.com/mail/u/0/',
    executeJavaScript: async () => {
      touched += 1;
      return null;
    },
  };
  const sensitiveResult = await reader.extract(sensitive);
  check(sensitiveResult.ok === false && /sign-in/.test(sensitiveResult.error), 'Reader refuses webmail hosts');
  check(touched === 0, 'Reader refuses before executing anything on a sensitive page');

  // Policy: a page with a password field is refused even on a normal host.
  const passwordPage = {
    isDestroyed: () => false,
    getURL: () => 'https://example.com/article',
    executeJavaScript: async () => ({
      ok: true,
      title: 'Looks harmless',
      blocks: [{ kind: 'text', text: 'Welcome back' }],
      text: 'Welcome back',
      passwordFields: 1,
      truncated: '',
    }),
  };
  const passwordResult = await reader.extract(passwordPage);
  check(passwordResult.ok === false && /sign-in form/.test(passwordResult.error), 'Reader refuses pages with password fields');

  const localFile = {
    isDestroyed: () => false,
    getURL: () => 'file:///C:/secret.txt',
    executeJavaScript: async () => {
      throw new Error('must not run');
    },
  };
  const localResult = await reader.extract(localFile);
  check(localResult.ok === false && /http and https/.test(localResult.error), 'Reader only reads http(s) pages');

  // --- notes --------------------------------------------------------------

  const noteResult = await handlers.get('bobo:notes:save')({
    note: {
      title: 'Service note',
      body: 'Body written by the smoke test.',
      url: 'https://example.com/article',
      pageTitle: 'Fixture',
    },
  });
  check(noteResult.ok === true && typeof noteResult.note.id === 'string', 'notes save creates a note');

  const notesFile = JSON.parse(fs.readFileSync(services.notes.file, 'utf8'));
  check(notesFile.notes.length === 1 && notesFile.notes[0].title === 'Service note', 'notes are persisted to JSON');

  const listed = await handlers.get('bobo:notes:list')();
  check(listed.notes.length === 1, 'notes list returns the saved note');

  const exportPath = path.join(dataDir, 'service-notes.md');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: exportPath });
  const exported = await handlers.get('bobo:notes:export')({ id: noteResult.note.id });
  check(exported.ok === true && fs.existsSync(exportPath), 'notes export writes the chosen file');
  check(
    fs.readFileSync(exportPath, 'utf8').includes('Body written by the smoke test.'),
    'exported Markdown contains the note body'
  );

  await expectReject(
    () => handlers.get('bobo:notes:save')({ note: { title: 'Evil', body: 'x', url: 'javascript:alert(1)' } }),
    /invalid url/,
    'notes reject non-http source URLs'
  );

  // --- reader save --------------------------------------------------------

  const pagePath = path.join(dataDir, 'service-page.md');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: pagePath });
  const savedPage = await handlers.get('bobo:reader:save')({
    doc: { title: extracted.title, url: 'https://example.com/article', blocks: extracted.blocks },
  });
  check(savedPage.ok === true && fs.existsSync(pagePath), 'Reader save writes the chosen file');
  check(
    fs.readFileSync(pagePath, 'utf8').includes('Arctic Frost palette uses Snow White'),
    'saved reader Markdown contains the article text'
  );

  // --- clipboard text -----------------------------------------------------

  await handlers.get('bobo:tools:copy-text')({ text: 'BOBO clipboard check' });
  check((await clipboard.readText()) === 'BOBO clipboard check', 'copy-text reaches the clipboard');

  // --- settings -----------------------------------------------------------

  const state = await handlers.get('bobo:tools:state')();
  check(state.tools.length === 6 && state.tools.every((tool) => tool.enabled), 'all tools start enabled');
  check(state.tools.some((tool) => tool.pinned), 'screenshot starts pinned to the toolbar');

  const configured = await handlers.get('bobo:tools:configure')({ id: 'notes', pinned: true });
  check(configured.tools.find((tool) => tool.id === 'notes').pinned === true, 'pinning a tool persists');

  const prefs = await handlers.get('bobo:tools:prefs')({ fontSize: 200 });
  check(prefs.reader.fontSize === 24, 'reader font size is clamped');

  const settingsFile = JSON.parse(fs.readFileSync(services.settings.file, 'utf8'));
  check(settingsFile.tools.screenshot.enabled === true, 'settings file holds the tool config');

  // --- clearing tool data -------------------------------------------------

  dialog.showMessageBox = async () => ({ response: 0 });
  const canceled = await handlers.get('bobo:tools:clear')({ what: 'notes' });
  check(canceled.canceled === true, 'declining the clear dialog changes nothing');
  check((await handlers.get('bobo:notes:list')()).notes.length === 1, 'notes survive a declined clear');

  dialog.showMessageBox = async () => ({ response: 1 });
  const cleared = await handlers.get('bobo:tools:clear')({ what: 'notes' });
  check(cleared.ok === true && !cleared.canceled, 'confirming the clear dialog clears notes');
  check((await handlers.get('bobo:notes:list')()).notes.length === 0, 'notes are gone after clearing');

  // Leave a predictable state for the UI pass.
  await services.notes.clear();
  await services.settings.resetTools();
  await services.settings.setPrefs({ fontSize: 17 });

  return handlers;
}

// --- 2. chrome UI ----------------------------------------------------------

function snapshotFor(activeId) {
  const tab = (id, title, url) => ({
    id,
    title,
    url,
    favicon: '',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    isLocal: false,
    error: null,
  });
  return {
    activeId,
    tabs: [
      tab(1, 'Fixture article', 'https://example.com/article'),
      tab(2, 'Second tab', 'https://news.example.org/story'),
    ],
  };
}

async function checkUi({ dataDir }) {
  const notesFile = path.join(dataDir, 'notes.json');
  const settingsFile = path.join(dataDir, 'settings.json');

  await chromeWin.loadFile(CHROME_HTML);
  await chromeWin.webContents.insertCSS(
    '*, *::before, *::after { transition: none !important; animation: none !important; }'
  );

  await until(`!!window.bobo`, 'preload bridge');
  await until(`document.querySelectorAll('#tp-tabs [data-tool]').length === 8`, 'tools rendered');

  // Panel starts closed; the toolbar button opens it.
  check(await js(`document.getElementById('tools-panel').hidden === true`), 'tools panel starts closed');
  await js(`document.getElementById('btn-tools').click()`);
  await until(`!document.getElementById('tools-panel').hidden`, 'toolbar button opens the panel');

  const chromeReport = await js(`(() => ({
    tabs: document.querySelectorAll('#tp-tabs [data-tool]').length,
    sidebar: document.querySelectorAll('[data-side-tools] [data-tool-open]').length,
    pinned: document.querySelectorAll('#pinned-tools [data-tool-open]').length,
    view: Array.from(document.querySelectorAll('.tp-view')).find((view) => !view.hidden).dataset.view,
  }))()`);
  check(chromeReport.tabs === 8, 'panel shows all tools plus Settings');
  check(chromeReport.sidebar === 7, 'sidebar lists all tools');
  check(chromeReport.pinned === 1, 'screenshot is the default pinned tool');
  check(chromeReport.view === 'screenshot', 'panel opens on the Screenshot view');

  // Pinned button re-opens its tool.
  await js(`document.getElementById('tp-close').click()`);
  await until(`document.getElementById('tools-panel').hidden === true`, 'close button hides the panel');
  await js(`document.querySelector('#pinned-tools [data-tool-open="screenshot"]').click()`);
  await until(`!document.getElementById('tools-panel').hidden`, 'pinned button re-opens the panel');

  // --- screenshot ---------------------------------------------------------

  await js(`document.getElementById('shot-capture').click()`);
  await until(`document.getElementById('shot-preview').src.startsWith('data:image/png')`, 'screenshot preview');

  const shotUi = await js(`(() => ({
    copy: document.getElementById('shot-copy').disabled === false,
    save: document.getElementById('shot-save').disabled === false,
    status: document.getElementById('shot-status').textContent,
  }))()`);
  check(shotUi.copy && shotUi.save, 'preview enables Copy and Save');
  check(/Captured/.test(shotUi.status), 'capture reports success in the panel');

  const uiShotPath = path.join(dataDir, 'ui-capture.png');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: uiShotPath });
  await js(`document.getElementById('shot-save').click()`);
  await until(`document.getElementById('shot-status').textContent.includes('Saved to')`, 'screenshot save status');
  check(fs.existsSync(uiShotPath), 'panel Save writes a PNG to the chosen path');

  clipboard.clear();
  await js(`document.getElementById('shot-copy').click()`);
  await until(`document.getElementById('shot-status').textContent.includes('copied')`, 'screenshot copy status');
  check(await clipboard.has('image/png'), 'panel Copy puts the image on the clipboard');

  // --- notes: create + autosave + persist across reload -------------------

  await js(`document.querySelector('[data-side-tools] [data-tool-open="notes"]').click()`);
  await until(`!document.querySelector('[data-view="notes"]').hidden`, 'sidebar opens the Notes view');

  await js(`document.getElementById('notes-new').click()`);
  await until(`document.getElementById('note-title').value === ''`, 'new note editor');
  await js(setValue('note-title', 'UI note title'));
  await js(setValue('note-body', 'Saved from the tools smoke test.'));

  const created = await untilFile(
    notesFile,
    (data) => data.notes.length === 1 && data.notes[0].body.includes('Saved from the tools smoke test'),
    'note autosave'
  );
  check(typeof created.notes[0].id === 'string' && created.notes[0].id.length > 10, 'autosaved note has an id');
  await until(`document.querySelectorAll('#notes-list [data-note-id]').length === 1`, 'note appears in the list');

  await sleep(150);
  fs.mkdirSync(SHOTS, { recursive: true });
  const notesShot = await chromeWin.webContents.capturePage();
  fs.writeFileSync(path.join(SHOTS, 'tools-notes.png'), notesShot.toPNG());
  console.log('     screenshot tests/e2e/screenshots/tools-notes.png');

  await chromeWin.loadFile(CHROME_HTML);
  await until(`!!window.bobo`, 'preload after reload');
  await until(`document.querySelectorAll('#tp-tabs [data-tool]').length === 8`, 'tools after reload');
  await js(`document.getElementById('btn-tools').click()`);
  await until(`!document.getElementById('tools-panel').hidden`, 'panel after reload');
  await js(`document.querySelector('#tp-tabs [data-tool="notes"]').click()`);
  await until(`document.querySelectorAll('#notes-list [data-note-id]').length === 1`, 'note survives a reload');
  await js(`document.querySelector('#notes-list [data-note-id]').click()`);
  await until(`document.getElementById('note-body').value.includes('smoke test')`, 'saved note reloads into the editor');
  check(true, 'notes persist across a chrome reload');

  // --- notes: edit, link, export, copy, delete ----------------------------

  await js(setValue('note-body', 'Edited body after reload.'));
  await untilFile(
    notesFile,
    (data) => data.notes[0].body === 'Edited body after reload.',
    'edited note saved'
  );
  check(true, 'editing a note autosaves the new text');

  const linkState = await js(`(() => ({
    disabled: document.getElementById('note-link').disabled,
    label: document.getElementById('note-link-label').textContent,
  }))()`);
  check(!linkState.disabled && /example\.com/.test(linkState.label), 'active tab is offered as a note link');

  await js(toggle('#note-link', true));
  await untilFile(notesFile, (data) => data.notes[0].url === 'https://example.com/article', 'note link saved');
  check(true, 'linking a note stores the page URL');

  const uiExportPath = path.join(dataDir, 'ui-notes.md');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: uiExportPath });
  await js(`document.getElementById('note-export').click()`);
  await until(`document.getElementById('notes-status').textContent.includes('Exported to')`, 'export status');
  const exportedMd = fs.readFileSync(uiExportPath, 'utf8');
  check(exportedMd.includes('# UI note title'), 'exported note has a title');
  check(exportedMd.includes('Edited body after reload.'), 'exported note has the edited body');
  check(exportedMd.includes('https://example.com/article'), 'exported note keeps its source URL');

  await clipboard.writeText('');
  await js(`document.getElementById('note-copy').click()`);
  await until(`document.getElementById('notes-status').textContent.includes('copied')`, 'note copy status');
  check((await clipboard.readText()).includes('Edited body after reload.'), 'note Copy reaches the clipboard');

  await js(`document.getElementById('note-delete').click()`);
  const armed = await js(`document.getElementById('note-delete').textContent`);
  check(/Confirm delete/.test(armed), 'delete asks for confirmation first');
  await js(`document.getElementById('note-delete').click()`);
  await untilFile(notesFile, (data) => data.notes.length === 0, 'note deleted from disk');
  await until(`document.querySelectorAll('#notes-list [data-note-id]').length === 0`, 'deleted note leaves the list');
  check(true, 'notes delete removes the note locally');

  // --- tab switching reaches the tools UI ---------------------------------

  chromeWin.webContents.send('bobo:tabs', snapshotFor(2));
  await until(
    `document.getElementById('note-link-label').textContent.includes('news.example.org')`,
    'tools follow the active tab'
  );
  check(true, 'active-tab changes reach the notes link label');

  // --- settings: enable/disable + pinning ---------------------------------

  await js(`document.querySelector('#tp-tabs [data-tool="settings"]').click()`);
  await until(`!document.querySelector('[data-view="settings"]').hidden`, 'settings view');

  const settingsReport = await js(`(() => ({
    tools: document.querySelectorAll('[data-tool-enabled]').length,
    permissions: document.querySelectorAll('.settings-perm').length,
    storage: document.getElementById('settings-storage').textContent,
  }))()`);
  check(settingsReport.tools === 6, 'settings lists a switch per tool');
  check(settingsReport.permissions === 6, 'settings lists permissions per tool');
  check(settingsReport.storage.includes('settings.json'), 'settings shows where data is stored');

  // --- search engine: default + switch + persistence ----------------------

  const searchReport = await js(`(() => ({
    value: document.getElementById('settings-search').value,
    options: Array.from(document.getElementById('settings-search').options).map((option) => option.value),
  }))()`);
  check(searchReport.value === 'google', 'Google is the initial default search engine');
  check(searchReport.options.join(',') === 'google,duckduckgo', 'DuckDuckGo is offered as the alternative');

  await js(`(() => {
    const el = document.getElementById('settings-search');
    el.value = 'duckduckgo';
    el.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await untilFile(settingsFile, (data) => data.search && data.search.engine === 'duckduckgo', 'search choice saved');
  await until(
    `document.getElementById('settings-search-status').textContent.includes('DuckDuckGo')`,
    'search engine status'
  );
  check(true, 'switching to DuckDuckGo is persisted');

  await js(toggle('[data-tool-enabled="notes"]', false));
  await until(`document.querySelectorAll('#tp-tabs [data-tool]').length === 6`, 'disabled tool leaves the panel');
  await untilFile(settingsFile, (data) => data.tools.notes.enabled === false, 'disabled tool persisted');
  const hiddenNotes = await js(`(() => ({
    tab: !!document.querySelector('#tp-tabs [data-tool="notes"]'),
    sidebar: !!document.querySelector('[data-side-tools] [data-tool-open="notes"]'),
    pinned: !!document.querySelector('#pinned-tools [data-tool-open="notes"]'),
  }))()`);
  check(!hiddenNotes.tab && !hiddenNotes.sidebar && !hiddenNotes.pinned, 'disabled tool disappears from every entry point');

  await js(toggle('[data-tool-enabled="notes"]', true));
  await until(`document.querySelectorAll('#tp-tabs [data-tool]').length === 7`, 're-enabled tool returns');
  check(true, 'tools can be re-enabled');

  await js(toggle('[data-tool-pinned="notes"]', true));
  await until(`!!document.querySelector('#pinned-tools [data-tool-open="notes"]')`, 'pinned tool reaches the toolbar');
  await untilFile(settingsFile, (data) => data.tools.notes.pinned === true, 'pinned tool persisted');
  check(true, 'pinning a tool adds a toolbar button');

  await js(`document.querySelector('#pinned-tools [data-tool-open="notes"]').click()`);
  await until(`!document.querySelector('[data-view="notes"]').hidden`, 'pinned button opens its view');
  check(true, 'a pinned toolbar button opens its own tool');

  const afterTools = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  check(afterTools.search.engine === 'duckduckgo', 'tool changes do not reset the search engine');

  // --- reader: rendering, copy, save, policy error ------------------------

  readerTarget = {
    isDestroyed: () => false,
    getURL: () => 'https://example.com/article',
    executeJavaScript: async () => ({
      ok: true,
      title: 'Fixture article',
      blocks: [
        { kind: 'heading', text: 'Intro' },
        { kind: 'text', text: '<img src=x onerror=alert(1)> not html' },
        { kind: 'text', text: 'Plain paragraph from the page.' },
      ],
      text: 'Intro\n\n<img src=x onerror=alert(1)> not html\n\nPlain paragraph from the page.',
      passwordFields: 0,
      truncated: '',
    }),
  };

  await js(`document.querySelector('#tp-tabs [data-tool="reader"]').click()`);
  await js(`document.getElementById('reader-read').click()`);
  await until(`!document.getElementById('reader-doc').hidden`, 'reader renders a document');

  const docReport = await js(`(() => ({
    title: document.getElementById('reader-title').textContent,
    url: document.getElementById('reader-url').textContent,
    headings: document.querySelectorAll('#reader-content h2').length,
    paragraphs: document.querySelectorAll('#reader-content p').length,
    images: document.querySelectorAll('#reader-content img').length,
    scripts: document.querySelectorAll('#reader-content script').length,
    text: document.getElementById('reader-content').textContent,
  }))()`);
  check(docReport.title === 'Fixture article', 'reader shows the page title');
  check(docReport.url === 'https://example.com/article', 'reader shows the source URL');
  check(docReport.headings === 1 && docReport.paragraphs === 2, 'reader renders headings and paragraphs');
  check(docReport.images === 0 && docReport.scripts === 0, 'reader never injects page text as HTML');
  check(docReport.text.includes('<img src=x onerror=alert(1)>'), 'markup in page text stays literal text');

  await clipboard.writeText('');
  await js(`document.getElementById('reader-copy').click()`);
  await until(`document.getElementById('reader-status').textContent.includes('copied')`, 'reader copy status');
  check((await clipboard.readText()).includes('Plain paragraph from the page.'), 'reader Copy reaches the clipboard');

  const readerPath = path.join(dataDir, 'ui-reader.md');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: readerPath });
  await js(`document.getElementById('reader-save').click()`);
  await until(`document.getElementById('reader-status').textContent.includes('Saved to')`, 'reader save status');
  check(fs.readFileSync(readerPath, 'utf8').includes('Plain paragraph from the page.'), 'reader Save writes the text');

  fs.mkdirSync(SHOTS, { recursive: true });
  const readerShot = await chromeWin.webContents.capturePage();
  fs.writeFileSync(path.join(SHOTS, 'tools-reader.png'), readerShot.toPNG());
  console.log('     screenshot tests/e2e/screenshots/tools-reader.png');

  // Reader policy through the UI: the fixture is file://, so it must be refused.
  readerTarget = null;
  await js(`document.getElementById('reader-read').click()`);
  await until(
    `document.getElementById('reader-status').textContent.includes('http and https')`,
    'reader policy error in the panel'
  );
  check(await js(`document.getElementById('reader-doc').hidden`), 'refused page is not rendered');

  // --- final state survives a restart of the chrome page ------------------

  await chromeWin.loadFile(CHROME_HTML);
  await until(`!!window.bobo`, 'preload after final reload');
  await until(`document.querySelectorAll('#tp-tabs [data-tool]').length === 7`, 'tools after final reload');
  const pins = await js(`document.querySelectorAll('#pinned-tools [data-tool-open]').length`);
  check(pins === 2, `pinned tools are restored on restart (got ${pins})`);

  check(
    (await js(`document.getElementById('settings-search').value`)) === 'duckduckgo',
    'search engine choice survives a restart'
  );

  await js(`(() => {
    const el = document.getElementById('settings-search');
    el.value = 'google';
    el.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await untilFile(settingsFile, (data) => data.search.engine === 'google', 'search engine back to Google');
  check(true, 'switching back to Google persists');
}

// --- harness ---------------------------------------------------------------

async function main() {
  const dataDir = path.join(__dirname, '.tmp', `tools-${process.pid}`);
  await fsp.rm(dataDir, { recursive: true, force: true });
  await fsp.mkdir(dataDir, { recursive: true });

  pageWin = new BrowserWindow({
    show: false,
    width: 900,
    height: 620,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });
  await pageWin.loadFile(FIXTURE);
  await pageWin.webContents.executeJavaScript(
    `new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))`
  );

  const consoleErrors = [];
  chromeWin = new BrowserWindow({
    show: false,
    width: 1220,
    height: 800,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });
  chromeWin.webContents.on('console-message', (details) => {
    if (details && details.level === 'error') consoleErrors.push(details.message);
  });

  // Stub the browser channels; the tool channels come from the real module.
  const handlers = await checkServices({ dataDir });
  for (const [channel, run] of handlers) {
    ipcMain.handle(channel, (_event, payload) => run(payload));
  }

  const browserStubs = {
    'bobo:get-state': () => ({
      tabs: snapshotFor(1),
      theme: 'dark',
    }),
    'bobo:chrome:bounds': () => null,
    'bobo:ui:theme': (_event, payload) => (payload && payload.theme) || 'dark',
    'bobo:tabs:create': () => null,
    'bobo:tabs:close': () => null,
    'bobo:tabs:select': () => null,
    'bobo:nav:input': () => null,
    'bobo:nav:back': () => null,
    'bobo:nav:forward': () => null,
    'bobo:nav:reload': () => null,
    'bobo:nav:stop': () => null,
    'bobo:nav:home': () => null,
    'bobo:nav:retry': () => null,
  };
  for (const [channel, run] of Object.entries(browserStubs)) {
    ipcMain.handle(channel, run);
  }

  await checkUi({ dataDir });

  for (const message of consoleErrors) check(false, `chrome console error - ${message}`);
  if (!consoleErrors.length) check(true, 'chrome logged no console errors');

  chromeWin.destroy();
  pageWin.destroy();
  await fsp.rm(dataDir, { recursive: true, force: true });

  console.log(`\n${failures.length === 0 ? 'PASS' : 'FAILED'} - ${failures.length} problem(s)`);
  for (const failure of failures) console.log(`  - ${failure}`);
  return failures.length === 0;
}

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  let ok = false;
  try {
    ok = await main();
  } catch (error) {
    console.error(error);
  }
  // Let the pipe drain before exiting, otherwise the summary can be lost.
  await sleep(120);
  app.exit(ok ? 0 : 1);
});
