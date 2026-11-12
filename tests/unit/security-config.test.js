'use strict';

/**
 * Milestone 1 / Phase 2 security regression tripwire.
 *
 * These are STATIC assertions over the source, on purpose: they run with plain
 * Node and no installed dependencies, so they work before Electron is present
 * and fail CI-style the moment a security-critical setting is removed or
 * inverted.
 *
 * They do NOT prove runtime behaviour - see docs/SECURITY-CONFIG.md, which
 * lists what is verified statically versus what still needs a running app.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const MAIN_SOURCES = ['src/main/main.js', 'src/main/security.js', 'src/main/tabs.js'];

describe('renderer process options: sandboxing and isolation', () => {
  const files = ['src/main/main.js', 'src/main/tabs.js'];

  for (const file of files) {
    test(`${file} creates hardened webPreferences`, () => {
      const src = read(file);
      assert.ok(
        src.includes('webPreferences:'),
        `${file} must set webPreferences explicitly rather than inherit defaults`
      );
      assert.match(src, /sandbox:\s*true/, 'sandbox must be on');
      assert.match(src, /contextIsolation:\s*true/, 'context isolation must be on');
      assert.match(src, /nodeIntegration:\s*false/, 'node integration must be off');
      assert.match(src, /webviewTag:\s*false/, '<webview> tag must be off');
    });

    test(`${file} never inverts those settings`, () => {
      const src = read(file);
      assert.doesNotMatch(src, /sandbox:\s*false/);
      assert.doesNotMatch(src, /contextIsolation:\s*false/);
      assert.doesNotMatch(src, /nodeIntegration:\s*true/);
      assert.doesNotMatch(src, /webviewTag:\s*true/);
      assert.doesNotMatch(src, /nodeIntegrationInWorker:\s*true/);
      assert.doesNotMatch(src, /enableRemoteModule:\s*true/);
    });
  }
});

describe('no source file weakens Chromium security', () => {
  const FORBIDDEN = [
    [/webSecurity:\s*false/, 'webSecurity must never be disabled'],
    [/allowRunningInsecureContent:\s*true/, 'insecure content must stay blocked'],
    [/allowPopupsFromWebContent\s*=\s*true/, 'web content must not create windows'],
    [/ignoreCertif/i, 'certificate errors must not be ignored'],
    [/ERR_CERT_[A-Z_]*PROCEED/i, 'no proceed-through-certificate-error path'],
  ];

  function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (entry.name.endsWith('.js')) out.push(full);
    }
    return out;
  }

  test('across every JS file in src/', () => {
    const files = walk(path.join(ROOT, 'src'));
    assert.ok(files.length >= 8, 'expected the BOBO source tree to be present');
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      for (const [pattern, why] of FORBIDDEN) {
        assert.doesNotMatch(src, pattern, `${path.relative(ROOT, file)}: ${why}`);
      }
    }
  });
});

describe('certificate errors are never bypassed', () => {
  test('main process has no certificate-acceptance path', () => {
    const src = MAIN_SOURCES.map(read).join('\n');

    // Electron's built-in default for `certificate-error` is REJECT. BOBO relies
    // on that default and deliberately installs no acceptance handler. If one is
    // ever added, it must reject explicitly - never accept.
    const hasHandler = /app\.on\(\s*['"]certificate-error['"]/.test(src);
    if (hasHandler) {
      assert.match(
        src,
        /certificate-error[\s\S]{0,600}callback\(\s*false\s*\)/,
        'a certificate-error handler must reject via callback(false)'
      );
    }
    assert.doesNotMatch(
      src,
      /certificate-error[\s\S]{0,600}callback\(\s*true\s*\)/,
      'a certificate-error handler must never accept the certificate'
    );
  });

  test('certificate failures surface to the local error page', () => {
    const errorPage = read('src/renderer/error.js');
    assert.match(errorPage, /'-107'/, 'ERR_CERT_AUTHORITY_INVALID must be explained');
    assert.match(errorPage, /certificate/i);
    const tabs = read('src/main/tabs.js');
    assert.match(tabs, /did-fail-load/, 'navigation failures must be surfaced');
    assert.match(tabs, /error\.html/, 'failures must render the local error page');
  });
});

describe('web permissions are denied by default', () => {
  test('security.js installs both permission handlers with default deny', () => {
    const src = read('src/main/security.js');
    assert.match(src, /setPermissionRequestHandler/, 'permission requests must be filtered');
    assert.match(src, /setPermissionCheckHandler/, 'permission checks must be filtered');
    assert.match(src, /permission !== 'fullscreen'/, 'only fullscreen is eligible for permission');
    assert.match(src, /callback\(allowed\)/, 'requests must use the validated permission decision');
  });
});

describe('webContents hardening in security.js', () => {
  test('<webview> is blocked', () => {
    assert.match(read('src/main/security.js'), /will-attach-webview[\s\S]*?preventDefault/);
  });

  test('navigation is restricted to validated URLs, including redirects', () => {
    const src = read('src/main/security.js');
    assert.match(src, /will-navigate[\s\S]*?isAllowedNavigationUrl/);
    assert.match(src, /will-redirect[\s\S]*?isAllowedNavigationUrl/);
  });

  test('window.open never creates a window and is routed through the tab manager', () => {
    const src = read('src/main/security.js');
    assert.match(src, /setWindowOpenHandler/);
    assert.match(src, /action:\s*'deny'/);
    assert.match(src, /onNewWindow/);
  });

  test('drag-and-drop navigation is disabled', () => {
    assert.match(read('src/main/tabs.js'), /navigateOnDragDrop:\s*false/);
  });
});

describe('IPC trust boundary', () => {
  // Tool channels are registered from their own module through main.js's
  // sender-validated wrapper, so all three files make up the IPC surface.
  const IPC_SOURCES = ['src/main/main.js', 'src/main/tools/ipc.js', 'src/main/browser-ipc.js', 'src/features/password-manager/service.js'];

  function arrayItems(source, name) {
    const match = source.match(new RegExp(`${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`));
    if (!match) return null;
    return [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
  }

  function handledChannels() {
    const channels = [];
    for (const file of IPC_SOURCES) {
      for (const match of read(file).matchAll(/handle\('([^']+)'/g)) channels.push(match[1]);
    }
    return channels;
  }

  test('preload only exposes namespaced bobo: channels', () => {
    const src = read('src/preload/preload.js');
    const invoke = arrayItems(src, 'INVOKE_CHANNELS');
    const events = arrayItems(src, 'EVENT_CHANNELS');
    assert.ok(invoke && invoke.length >= 10, 'INVOKE_CHANNELS must be present');
    assert.ok(events && events.length >= 3, 'EVENT_CHANNELS must be present');
    for (const channel of [...invoke, ...events]) {
      assert.match(channel, /^bobo:[a-z0-9:-]+$/, `${channel} must be namespaced`);
    }
    assert.match(src, /exposeInMainWorld/);
  });

  test('every channel the preload can invoke is handled in the main process', () => {
    const invoke = arrayItems(read('src/preload/preload.js'), 'INVOKE_CHANNELS');
    const handled = new Set(handledChannels());
    for (const channel of invoke) {
      assert.ok(handled.has(channel), `the main process has no handler for ${channel}`);
    }
  });

  test('every handler is namespaced and goes through the sender-checked wrapper', () => {
    const channels = handledChannels();
    assert.ok(channels.length >= 10, 'expected the full IPC surface');
    for (const channel of channels) {
      assert.match(channel, /^bobo:/, `${channel} must be namespaced`);
    }
    assert.match(read('src/main/main.js'), /assertTrusted\(event\)/, 'handlers must assert the sender');
    // Tool modules must never reach ipcMain directly: they receive `handle`
    // from main.js, which is where assertTrusted lives.
    assert.doesNotMatch(read('src/main/tools/ipc.js'), /ipcMain\.(handle|on)\(/);
    assert.doesNotMatch(read('src/main/main.js'), /bobo:shortcut/, 'remote pages must have no shortcut IPC path');
  });

  test('sender validation resolves to files inside src/renderer', () => {
    const src = read('src/main/navigation.js');
    assert.match(src, /function isLocalRendererUrl/);
    assert.match(src, /file:/);
    assert.match(src, /LOCAL_RENDERER_DIR/);
    // path.relative(..) startswith .. check is what blocks traversal
    assert.match(src, /startsWith\('\.\.'\)/);
  });
});
