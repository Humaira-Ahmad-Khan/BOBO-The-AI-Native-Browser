'use strict';

/**
 * New Tab controls smoke check - run with `npm run smoke`.
 *
 * Loads the real newtab.html with the real preload, and stubs only the main
 * process boundary (native file dialog, launcher storage, navigation). It
 * exercises the search controls, local attachments, honest mic/camera/AI
 * states, Gmail/Images links and the Google apps launcher.
 *
 * Local only: no window is shown, no dialog opens, no network is touched.
 */

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const { GOOGLE_APPS } = require('../../src/main/google-apps');

const ROOT = path.resolve(__dirname, '../..');
const NEWTAB = path.join(ROOT, 'src/renderer/newtab.html');
const PRELOAD = path.join(ROOT, 'src/preload/preload.js');
const SHOTS = path.join(__dirname, 'screenshots');

// A 1x1 transparent PNG, enough to verify the preview <img> gets a data URL.
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${message}`);
};

let win = null;
let lastAppsPrefs = null;
const navCalls = [];
const tabCalls = [];
const pickerCalls = [];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function js(code) {
  return win.webContents.executeJavaScript(code, true);
}

async function waitFor(expression, label, timeout = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await js(expression)) return true;
    await sleep(60);
  }
  check(false, `${label} (timed out)`);
  return false;
}

function stubIpc() {
  ipcMain.handle('bobo:get-state', () => ({
    tabs: {
      activeId: 1,
      tabs: [
        {
          id: 1,
          title: 'New Tab',
          url: '',
          favicon: '',
          loading: false,
          canGoBack: false,
          canGoForward: false,
          isLocal: true,
          error: null,
        },
      ],
    },
    theme: 'dark',
  }));
  ipcMain.handle('bobo:tools:state', () => ({
    tools: [],
    reader: { fontSize: 17 },
    search: { engine: 'google', options: [] },
  }));
  ipcMain.handle('bobo:ui:theme', (_event, payload) => (payload && payload.theme) || 'dark');
  ipcMain.handle('bobo:chrome:bounds', () => {});

  ipcMain.handle('bobo:nav:input', (_event, payload) => {
    navCalls.push(payload);
    return true;
  });
  ipcMain.handle('bobo:tabs:create', (_event, payload) => {
    tabCalls.push(payload && payload.url);
    return 2;
  });

  ipcMain.handle('bobo:newtab:pick-attachments', (_event, payload) => {
    const kind = payload && payload.kind;
    pickerCalls.push(kind);
    if (kind === 'images') {
      return {
        canceled: false,
        truncated: false,
        rejected: 0,
        items: [
          {
            name: 'arctic-frost.png',
            size: 12288,
            type: 'PNG',
            kind: 'image',
            preview: `data:image/png;base64,${TINY_PNG}`,
          },
        ],
      };
    }
    return {
      canceled: false,
      truncated: false,
      rejected: 0,
      items: [
        {
          name: 'quarterly-report.pdf',
          size: 2097152,
          type: 'PDF',
          kind: 'file',
          preview: null,
        },
      ],
    };
  });

  ipcMain.handle('bobo:newtab:apps:get', () => ({
    apps: GOOGLE_APPS.map(({ id, name, url, icon }) => ({ id, name, url, icon })),
    prefs: {
      order: GOOGLE_APPS.map((app) => app.id),
      hidden: [],
      openInNewTab: false,
    },
  }));

  ipcMain.handle('bobo:newtab:apps:set', (_event, payload) => {
    lastAppsPrefs = payload;
    return { prefs: payload };
  });
}

async function shot(name) {
  await js(
    `new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 350))))`
  );
  fs.mkdirSync(SHOTS, { recursive: true });
  const image = await win.webContents.capturePage();
  const file = path.join(SHOTS, `${name}.png`);
  fs.writeFileSync(file, image.toPNG());
  console.log(`     screenshot ${path.relative(ROOT, file)}`);
}

async function main() {
  stubIpc();
  win = new BrowserWindow({
    show: false,
    width: 1180,
    height: 840,
    backgroundColor: '#192734',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  const consoleErrors = [];
  win.webContents.on('console-message', (details) => {
    if (details && details.level === 'error') consoleErrors.push(details.message);
  });

  await win.loadFile(NEWTAB);
  await win.webContents.insertCSS(
    '*, *::before, *::after { transition: none !important; animation: none !important; }'
  );
  await js(`document.documentElement.dataset.theme = 'dark'`);
  await js(
    `new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))`
  );

  // --- structure ----------------------------------------------------------

  check(await js(`!!document.getElementById('q')`), 'search input exists');
  check(await js(`!!document.getElementById('btn-attach-menu')`), 'plus button exists');
  check(await js(`!!document.getElementById('btn-search-mic')`), 'microphone button exists');
  check(await js(`!!document.getElementById('btn-search-cam')`), 'camera button exists');
  check(await js(`!!document.getElementById('btn-ai-mode')`), 'AI Mode button exists');
  check(
    await js(`document.getElementById('btn-ai-mode').getAttribute('aria-disabled') === 'true'`),
    'AI Mode is exposed as disabled placeholder'
  );
  check(await js(`!!document.querySelector('.newtab-top-bar #link-gmail')`), 'Gmail link present');
  check(await js(`!!document.querySelector('.newtab-top-bar #link-images')`), 'Images link present');
  check(
    await js(`document.getElementById('attachments-tray').hidden === true`),
    'attachment tray starts empty'
  );

  // --- app catalog renders with local icons --------------------------------

  const appsReady = await waitFor(
    `document.querySelectorAll('.google-app-item').length === 17`,
    'all 17 Google services render'
  );
  if (appsReady) {
    check(
      await js(`Array.from(document.querySelectorAll('.google-app-icon img')).every((img) => img.complete && img.naturalWidth > 0)`),
      'every launcher icon decodes from local assets'
    );
    check(
      await js(`Array.from(document.querySelectorAll('.google-app-name')).map((n) => n.textContent).includes('Google Drive')`),
      'service names are shown beneath icons'
    );
  }
  await shot('newtab-controls-dark');

  await js(`document.getElementById('btn-google-apps').click()`);
  await shot('newtab-apps-dark');
  await js(`document.getElementById('btn-google-apps').click()`);

  // --- plus menu + local attachments --------------------------------------

  await js(`document.getElementById('btn-attach-menu').click()`);
  check(
    await js(`document.getElementById('attach-dropdown').hidden === false`),
    'plus button opens the attachment menu'
  );
  check(
    await js(`document.querySelectorAll('#attach-dropdown .attach-dropdown-item').length === 2`),
    'attachment menu contains exactly two options'
  );
  check(
    await js(`
      Array.from(document.querySelectorAll('#attach-dropdown .attach-dropdown-item'))
        .map((el) => el.textContent.trim()).join('|') === 'Add Images|Add Files'
    `),
    'attachment menu offers only Add Images and Add Files'
  );

  await js(`document.getElementById('attach-opt-images').click()`);
  await waitFor(
    `document.querySelectorAll('#attachments-list .attachment-chip').length === 1`,
    'selected image appears in the tray'
  );
  check(pickerCalls.at(-1) === 'images', 'Add Images asks main for the image picker');
  check(
    await js(`document.querySelector('#attachments-list .attachment-name').textContent === 'arctic-frost.png'`),
    'image filename is shown'
  );
  check(
    await js(`!!document.querySelector('#attachments-list .attachment-thumb-img')`),
    'image preview thumbnail is shown'
  );
  check(
    await js(`document.querySelector('#attachments-list .attachment-meta').textContent.includes('PNG')`),
    'image type and size are shown'
  );
  check(navCalls.length === 0, 'adding an image does not navigate or upload anywhere');

  await js(`document.querySelector('#attachments-list .attachment-remove').click()`);
  check(
    await js(`document.getElementById('attachments-tray').hidden === true`),
    'removing the image clears the tray'
  );

  await js(`document.getElementById('btn-attach-menu').click()`);
  await js(`document.getElementById('attach-opt-files').click()`);
  await waitFor(
    `document.querySelectorAll('#attachments-list .attachment-chip').length === 1`,
    'selected file appears in the tray'
  );
  check(pickerCalls.at(-1) === 'files', 'Add Files asks main for the file picker');
  check(
    await js(`document.querySelector('#attachments-list .attachment-name').textContent === 'quarterly-report.pdf'`),
    'file name is shown'
  );
  check(
    await js(`document.querySelector('#attachments-list .attachment-meta').textContent === 'PDF · 2.0 MB'`),
    'file size and type are shown'
  );
  check(
    await js(`document.getElementById('attachments-note').textContent.includes('Attachments stay local')`),
    'tray explains that attachments stay local by default'
  );
  check(navCalls.length === 0, 'adding a file never navigates or uploads');

  await js(`document.querySelector('#attachments-list .attachment-remove').click()`);

  // --- mic: honest unavailable state --------------------------------------

  await js(`document.getElementById('btn-search-mic').click()`);
  check(
    await js(`document.getElementById('voice-dialog').open === true`),
    'microphone button opens an explanation dialog'
  );
  check(
    await js(`document.getElementById('voice-dialog').textContent.includes('Voice search is unavailable')`),
    'voice dialog clearly labels the unavailable state'
  );
  check(
    await js(`document.getElementById('voice-dialog').textContent.includes('not being accessed')`),
    'voice dialog states the microphone is not accessed'
  );
  await js(`document.querySelector('#voice-dialog [data-close-dialog]').click()`);
  check(
    await js(`document.getElementById('voice-dialog').open === false`),
    'voice dialog closes'
  );

  // --- camera: local image preview and consent disclosure ----------------

  await js(`document.getElementById('btn-search-cam').click()`);
  check(
    await js(`document.getElementById('image-dialog').open === true`),
    'camera button opens the local image dialog'
  );
  check(
    await js(`document.getElementById('image-dialog').textContent.includes('after you confirm')`),
    'image dialog explains the upload confirmation'
  );
  await js(`document.getElementById('btn-image-choose').click()`);
  await waitFor(
    `document.getElementById('image-dialog-preview-wrap').hidden === false`,
    'chosen image gets a dialog preview'
  );
  check(
    await js(`document.getElementById('image-dialog-name').textContent === 'arctic-frost.png'`),
    'chosen image filename is shown'
  );
  check(
    await js(`document.getElementById('btn-image-remove').hidden === false`),
    'Remove Image is available'
  );
  await js(`document.getElementById('btn-image-remove').click()`);
  check(
    await js(`document.getElementById('image-dialog-preview-wrap').hidden === true`),
    'Remove Image clears the preview'
  );
  await js(`document.querySelector('#image-dialog [data-close-dialog]').click()`);

  // --- AI Mode: coming soon only -----------------------------------------

  await js(`document.getElementById('btn-ai-mode').click()`);
  check(
    await js(`document.getElementById('ai-mode-tip').hidden === false`),
    'AI Mode click shows the Coming Soon tip'
  );
  check(
    await js(`document.getElementById('ai-mode-tip').textContent.includes('Coming Soon')`),
    'AI Mode tip text is Coming Soon'
  );
  check(navCalls.length === 0 && tabCalls.length === 0, 'AI Mode performs no action');

  // --- search still works --------------------------------------------------

  await js(`
    (() => {
      const input = document.getElementById('q');
      input.value = 'arctic frost browser';
      document.getElementById('search-form').requestSubmit();
    })()
  `);
  check(
    navCalls.length === 1 && navCalls[0].text === 'arctic frost browser',
    'search form still submits to the browser'
  );

  // --- Gmail / Images links ------------------------------------------------

  await js(`document.getElementById('link-gmail').click()`);
  check(tabCalls.at(-1) === 'https://mail.google.com/', 'Gmail opens in a BOBO tab');
  await js(`document.getElementById('link-images').click()`);
  check(tabCalls.at(-1) === 'https://images.google.com/', 'Images opens in a BOBO tab');

  // --- Google Apps launcher ------------------------------------------------

  await js(`document.getElementById('btn-google-apps').click()`);
  check(
    await js(`document.getElementById('google-apps-panel').hidden === false`),
    'apps grid button opens the launcher'
  );
  check(
    await js(`document.getElementById('btn-google-apps').getAttribute('aria-expanded') === 'true'`),
    'launcher sets aria-expanded'
  );

  await js(`document.getElementById('btn-google-apps-manage').click()`);
  check(
    await js(`document.getElementById('google-apps-manage').hidden === false`),
    'Customise opens the manage view'
  );
  check(
    await js(`document.querySelectorAll('.google-apps-manage-row').length === 17`),
    'manage view lists every service'
  );

  // Reorder: move Google Drive (second) down one place.
  await js(`
    (() => {
      const rows = Array.from(document.querySelectorAll('.google-apps-manage-row'));
      const row = rows.find((r) => r.textContent.includes('Google Drive'));
      row.querySelector('button[aria-label="Move Google Drive down"]').click();
    })()
  `);
  check(
    lastAppsPrefs && lastAppsPrefs.order[0] === 'account' && lastAppsPrefs.order[1] === 'gmail',
    'reordering a shortcut persists the new order'
  );

  // Hide Google News.
  await js(`
    (() => {
      const rows = Array.from(document.querySelectorAll('.google-apps-manage-row'));
      const row = rows.find((r) => r.textContent.includes('Google News'));
      row.querySelector('.google-apps-toggle').click();
    })()
  `);
  check(
    lastAppsPrefs && lastAppsPrefs.hidden.includes('news'),
    'hiding a shortcut persists the hidden id'
  );

  // Open-in-new-tab preference.
  await js(`
    (() => {
      const box = document.getElementById('google-apps-open-new');
      box.checked = true;
      box.dispatchEvent(new Event('change', { bubbles: true }));
    })()
  `);
  check(
    lastAppsPrefs && lastAppsPrefs.openInNewTab === true,
    'open-in-new-tab preference is persisted'
  );

  // Restore defaults.
  await js(`document.getElementById('btn-restore-apps').click()`);
  check(
    lastAppsPrefs &&
      lastAppsPrefs.hidden.length === 0 &&
      lastAppsPrefs.openInNewTab === false &&
      lastAppsPrefs.order[0] === 'account' &&
      lastAppsPrefs.order[1] === 'drive',
    'Restore defaults resets order, hidden state and tab preference'
  );

  await js(`document.getElementById('btn-google-apps-manage-close').click()`);
  check(
    await js(`document.querySelectorAll('.google-app-item').length === 17`),
    'all shortcuts are visible again after restore'
  );

  // Launcher navigation: current tab is the default.
  await js(`
    Array.from(document.querySelectorAll('.google-app-item'))
      .find((el) => el.textContent.includes('Google Maps')).click()
  `);
  check(
    navCalls.at(-1) && navCalls.at(-1).text === 'https://maps.google.com/',
    'app shortcut opens Google Maps in the current tab by default'
  );
  check(
    await js(`document.getElementById('google-apps-panel').hidden === true`),
    'launcher closes after opening a service'
  );

  // New-tab preference.
  await js(`document.getElementById('btn-google-apps').click()`);
  await js(`document.getElementById('btn-google-apps-manage').click()`);
  await js(`
    (() => {
      const box = document.getElementById('google-apps-open-new');
      box.checked = true;
      box.dispatchEvent(new Event('change', { bubbles: true }));
    })()
  `);
  await js(`document.getElementById('btn-google-apps-manage-close').click()`);
  await js(`
    Array.from(document.querySelectorAll('.google-app-item'))
      .find((el) => el.textContent.includes('Google Calendar')).click()
  `);
  check(
    tabCalls.at(-1) === 'https://calendar.google.com/',
    'open-in-new-tab preference opens the service in a new BOBO tab'
  );

  // Escape closes.
  await js(`document.getElementById('btn-google-apps').click()`);
  check(
    await js(`document.getElementById('google-apps-panel').hidden === false`),
    'launcher reopens'
  );
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  check(
    await js(`document.getElementById('google-apps-panel').hidden === true`),
    'Escape closes the launcher'
  );

  // Outside click closes.
  await js(`document.getElementById('btn-google-apps').click()`);
  await js(`document.querySelector('.brand-wordmark').click()`);
  check(
    await js(`document.getElementById('google-apps-panel').hidden === true`),
    'clicking outside closes the launcher'
  );

  // --- light theme ---------------------------------------------------------

  await js(`document.getElementById('btn-google-apps').click()`);
  const darkBackground = await js(
    `getComputedStyle(document.getElementById('google-apps-panel')).backgroundColor`
  );
  await js(`document.documentElement.dataset.theme = 'light'`);
  const lightBackground = await js(
    `getComputedStyle(document.getElementById('google-apps-panel')).backgroundColor`
  );
  check(
    darkBackground !== lightBackground,
    `launcher follows light and dark themes (${darkBackground} -> ${lightBackground})`
  );
  await shot('newtab-controls-light');
  await js(`document.getElementById('btn-google-apps').click()`);

  // --- responsive layout at a small window --------------------------------

  win.setContentSize(660, 520);
  await sleep(300);

  await js(`document.getElementById('btn-attach-menu').click()`);
  const smallLayout = await js(`
    (() => {
      const search = document.querySelector('.newtab-chrome-search').getBoundingClientRect();
      const dropdown = document.getElementById('attach-dropdown').getBoundingClientRect();
      return {
        width: window.innerWidth,
        height: window.innerHeight,
        searchLeft: search.left,
        searchRight: search.right,
        searchHeight: search.height,
        dropdownRight: dropdown.right,
      };
    })()
  `);
  check(
    smallLayout.searchLeft >= 0 && smallLayout.searchRight <= smallLayout.width,
    `search bar fits a ${smallLayout.width}px window`
  );
  check(smallLayout.searchHeight >= 44, 'search bar stays usable when narrow');
  check(
    smallLayout.dropdownRight <= smallLayout.width,
    'attachment menu does not overflow the window'
  );
  await js(`document.getElementById('btn-attach-menu').click()`);

  await js(`document.getElementById('btn-google-apps').click()`);
  const panelLayout = await js(`
    (() => {
      const rect = document.getElementById('google-apps-panel').getBoundingClientRect();
      return {
        width: window.innerWidth,
        height: window.innerHeight,
        left: rect.left,
        right: rect.right,
        bottom: rect.bottom,
        scrollable: document.querySelector('.google-apps-scroll-wrap').scrollHeight >
          document.querySelector('.google-apps-scroll-wrap').clientHeight,
        columns: getComputedStyle(document.getElementById('google-apps-grid')).gridTemplateColumns.split(' ').length,
      };
    })()
  `);
  check(
    panelLayout.left >= 0 && panelLayout.right <= panelLayout.width,
    'apps launcher stays inside the window'
  );
  check(panelLayout.bottom <= panelLayout.height, 'apps launcher stays within the viewport height');
  check(panelLayout.columns === 3, 'apps launcher keeps a three-column layout');
  check(panelLayout.scrollable, 'apps launcher remains scrollable when space is tight');
  await js(`document.getElementById('btn-google-apps').click()`);
  win.setContentSize(1180, 840);
  await sleep(200);

  check(consoleErrors.length === 0, `no console errors (${consoleErrors.join(' | ') || 'none'})`);

  // --- existing New Tab content preserved ---------------------------------

  check(await js(`!!document.querySelector('.brand-logo')`), 'BOBO logo is preserved');
  check(
    await js(`document.querySelector('.brand-wordmark').textContent === 'BOBO'`),
    'BOBO wordmark is preserved'
  );
  check(
    await js(`document.getElementById('newtab-bg-layer').style.backgroundImage.includes('BOBO_Arctic_Frost')`),
    'Arctic Frost background is preserved'
  );
  check(
    await js(`document.querySelectorAll('.chrome-shortcut-tile').length >= 6`),
    'existing shortcut tiles are preserved'
  );
  check(
    await js(`!!document.querySelector('.add-tile')`),
    'Add Shortcut control is preserved'
  );
  check(
    await js(`!!document.getElementById('btn-customize-bg')`),
    'page customisation control is preserved'
  );

  win.destroy();

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
  app.exit(ok ? 0 : 1);
});
