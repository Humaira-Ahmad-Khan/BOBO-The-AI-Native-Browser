'use strict';

/**
 * Branding smoke check - run with `npm run smoke`.
 *
 * Loads every BOBO-owned page in a hidden Electron window and asserts that:
 *   1. every asset path written in the HTML resolves on disk (the original bug
 *      was `../assets/logo.svg`, a file that never existed),
 *   2. every <img> the page actually renders has decoded pixels,
 *   3. the Arctic Frost accent colour is applied in both themes,
 *   4. the Windows .ico is a real multi-resolution ICO and Electron can load it,
 *   5. the pages log no console errors (CSP violations included).
 *
 * Screenshots land in tests/e2e/screenshots/ (git-ignored) as visual evidence.
 * This is a local-only check: no network, no window shown, exit code 1 on failure.
 */

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');

const ROOT = path.resolve(__dirname, '../..');
const RENDERER = path.join(ROOT, 'src/renderer');
const PRELOAD = path.join(ROOT, 'src/preload/preload.js');
const ICON = path.join(ROOT, 'src/assets/logo/BOBO_Arctic_Frost/bobo.ico');
const SHOTS = path.join(__dirname, 'screenshots');

// Arctic Frost: Ice Blue #B8E9FF, and the light-theme accent derived from Steel Blue #5C8AA6.
const ICE_BLUE = 'rgb(184, 233, 255)';
const LIGHT_ACCENT = 'rgb(47, 111, 142)';
const LIGHT_ACCENT_TEXT = 'rgb(43, 102, 132)';

const PAGES = [
  {
    file: 'index.html',
    label: 'chrome',
    accent: { query: '.chip-btn', prop: 'color', dark: ICE_BLUE, light: LIGHT_ACCENT_TEXT },
  },
  {
    file: 'newtab.html',
    label: 'new tab page',
    accent: {
      query: '.newtab-search button',
      prop: 'backgroundColor',
      dark: ICE_BLUE,
      light: LIGHT_ACCENT,
    },
  },
  {
    file: 'error.html',
    label: 'error page',
    query: { code: '-105', desc: 'smoke test', url: 'https://example.com/' },
    accent: {
      query: '.btn-primary',
      prop: 'backgroundColor',
      dark: ICE_BLUE,
      light: LIGHT_ACCENT,
    },
  },
];

const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${message}`);
};

// --- 1. asset paths referenced by the HTML and JS must exist ---------------

function checkAssetPaths() {
  const refs = /(?:src|href)="(\.\.\/assets\/[^"]+)"/g;

  for (const page of PAGES) {
    const html = fs.readFileSync(path.join(RENDERER, page.file), 'utf8');
    const found = [...html.matchAll(refs)].map((match) => match[1]);
    check(found.length > 0, `${page.file} references at least one branding asset`);

    for (const ref of found) {
      const absolute = path.resolve(RENDERER, ref);
      check(fs.existsSync(absolute), `${page.file}: ${ref} exists on disk`);
      check(absolute.startsWith(path.join(ROOT, 'src')), `${page.file}: ${ref} stays inside src/`);
    }

    check(!html.includes('logo.svg'), `${page.file} no longer points at the removed logo.svg`);
  }

  // The tab-strip favicon is built in JS, so the HTML scan cannot see it.
  const appJs = fs.readFileSync(path.join(RENDERER, 'app.js'), 'utf8');
  for (const match of appJs.matchAll(/'(\S*assets\/[^']+)'/g)) {
    check(fs.existsSync(path.resolve(RENDERER, match[1])), `app.js: ${match[1]} exists on disk`);
  }
}

// --- 2. the Windows icon is a genuine multi-resolution ICO -----------------

function checkAppIcon() {
  const ico = fs.readFileSync(ICON);
  check(ico[0] === 0 && ico[1] === 0 && ico[2] === 1 && ico[3] === 0, 'bobo.ico has an ICO header');
  const images = ico.readUInt16LE(4);
  check(images >= 4, `bobo.ico holds ${images} images (multi-resolution)`);
  check(!nativeImage.createFromPath(ICON).isEmpty(), 'Electron can decode bobo.ico');
}

// --- 3. pages render without broken images --------------------------------

let win = null;

function watchConsole(errors) {
  // Handler takes the event params object directly (Electron >= 39 API).
  const listener = (details) => {
    if (details && details.level === 'error') errors.push(details.message);
  };
  win.webContents.on('console-message', listener);
  return () => win.webContents.removeListener('console-message', listener);
}

async function inspect(page) {
  const errors = [];
  const stopWatching = watchConsole(errors);

  await win.loadFile(
    path.join(RENDERER, page.file),
    page.query ? { query: page.query } : undefined
  );

  // A hidden window throttles the compositor, so CSS transitions can be
  // captured half-finished. Turn them off for a deterministic screenshot.
  await win.webContents.insertCSS(
    '*, *::before, *::after { transition: none !important; animation: none !important; }'
  );

  // `complete` only means the bytes arrived; decode() plus two frames means the
  // image is actually rasterised before we look at it or capture it.
  await win.webContents.executeJavaScript(`
    (async () => {
      await Promise.all(Array.from(document.images).map((img) =>
        img.decode ? img.decode().catch(() => {}) : null
      ));
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    })()
  `);

  const report = await win.webContents.executeJavaScript(`
    (() => {
      const accent = document.querySelector(${JSON.stringify(page.accent.query)});
      return {
        // Images with no src render nothing by design (the screenshot preview
        // stays empty until a capture), so they are not branding failures.
        images: Array.from(document.images)
          .filter((img) => img.getAttribute('src'))
          .map((img) => ({
            src: img.getAttribute('src'),
            loaded: img.complete && img.naturalWidth > 0,
            width: img.naturalWidth,
          })),
        accent: accent ? getComputedStyle(accent)[${JSON.stringify(page.accent.prop)}] : null,
      };
    })()
  `);

  check(report.images.length > 0, `${page.label}: renders application images`);
  for (const image of report.images) {
    check(image.loaded, `${page.label}: ${image.src} loaded (${image.width}px wide)`);
  }
  check(
    report.accent === page.accent.dark,
    `${page.label}: dark theme accent is ${page.accent.dark} (got ${report.accent})`
  );

  await shot(page, 'dark');

  await win.webContents.executeJavaScript(`document.documentElement.dataset.theme = 'light'`);
  const lightAccent = await win.webContents.executeJavaScript(
    `getComputedStyle(document.querySelector(${JSON.stringify(page.accent.query)}))[${JSON.stringify(page.accent.prop)}]`
  );
  check(
    lightAccent === page.accent.light,
    `${page.label}: light theme accent is ${page.accent.light} (got ${lightAccent})`
  );
  await shot(page, 'light');

  stopWatching();
  for (const message of errors) check(false, `${page.label}: console error - ${message}`);
}

async function shot(page, theme) {
  // Let the theme switch finish painting: the chrome transitions run ~160ms, so
  // a capture any earlier shows half-transitioned colours.
  await win.webContents.executeJavaScript(
    `new Promise((done) => requestAnimationFrame(() => setTimeout(done, 350)))`
  );
  fs.mkdirSync(SHOTS, { recursive: true });
  const image = await win.webContents.capturePage();
  const file = path.join(SHOTS, `${path.parse(page.file).name}-${theme}.png`);
  fs.writeFileSync(file, image.toPNG());
  console.log(`     screenshot ${path.relative(ROOT, file)}`);
}

// --- harness ---------------------------------------------------------------

function stubIpc() {
  // Same shape the real main process returns, so the renderers take their
  // normal code paths instead of the "no API" fallback.
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
  ipcMain.handle('bobo:chrome:bounds', () => {});
  ipcMain.handle('bobo:ui:theme', (_event, payload) => (payload && payload.theme) || 'dark');

  // The chrome page now hosts BOBO Tools; give it a valid (empty) tool state so
  // the branding check exercises the real startup path instead of a rejected
  // promise. The tools themselves are covered by tools-smoke.js.
  ipcMain.handle('bobo:tools:state', () => ({
    tools: [],
    reader: { fontSize: 17 },
    search: { engine: 'google', options: [] },
    recovered: false,
    storage: '',
  }));
  ipcMain.handle('bobo:notes:list', () => ({ notes: [], recovered: false, storage: '' }));
  ipcMain.handle('bobo:bookmarks:list', () => ({ bookmarks: [] }));
  ipcMain.handle('bobo:settings:browser', () => ({ bookmarks: { barVisible: true } }));
}

async function main() {
  checkAssetPaths();
  checkAppIcon();

  stubIpc();
  win = new BrowserWindow({
    show: false,
    width: 1180,
    height: 780,
    icon: ICON,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });

  for (const page of PAGES) await inspect(page);

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
