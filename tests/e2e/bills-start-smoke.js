'use strict';

// Run with installed Electron. The billing page is served entirely in-process.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, session } = require('electron');

const temp = path.join(__dirname, '.tmp');
fs.mkdirSync(temp, { recursive: true });
const restartProfile = process.argv.find((arg) => /^--bills-profile=[a-z0-9-]+$/i.test(arg))?.split('=')[1];
const profile = restartProfile ? path.join(temp, `bills-restart-${restartProfile}`)
  : fs.mkdtempSync(path.join(temp, 'bills-start-'));
const history = path.join(profile, 'history');
fs.mkdirSync(history, { recursive: true });
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [history] });
const merged = path.join(history, 'merged.csv');
dialog.showSaveDialog = async (_window, options) => ({
  canceled: false,
  filePath: process.argv.includes('--stage2-security') && options?.filters?.[0]?.extensions.includes('pdf')
    ? path.join(history, 'stage2.pdf') : merged,
});
for (const key of ['userData', 'sessionData', 'crashDumps']) app.setPath(key, profile);
app.setAppLogsPath(profile);
app.commandLine.appendSwitch('disable-background-networking');
app.disableHardwareAcceleration();

const origin = 'https://elgcd.punjab.gov.pk';
const target = origin + '/e-billing/water-bill-history';
const slowBills = origin + '/slow-bills';
const consumers = origin + '/e-billing/consumers-list';
const pdfs = [origin + '/bill-one.pdf', origin + '/bill-two.pdf'];
const billView = origin + '/view-bill';
let directPdfPending = false;
let pdfsOverlapped = false;
const video = 'https://www.youtube.com/watch?v=abcdefghijk';
const youtubeHome = 'https://www.youtube.com/';
const youtubeResults = 'https://www.youtube.com/results?search_query=fixture';
const channelFixture = 'https://www.youtube.com/@fixture/shorts';
const channelShorts = ['https://www.youtube.com/shorts/aaaaaaaaaaa', 'https://www.youtube.com/shorts/bbbbbbbbbbb'];
const alternateVideo = 'https://www.yout-ube.com/watch?v=abcdefghijk';
const shortcutSite = 'https://shortcut.test/';
const shortcutFavicon = shortcutSite + 'favicon.png';
const linkedin = 'https://www.linkedin.com/feed/';
const liveYouTube = process.argv.includes('--youtube-live-skip');
let observedUserAgent;
app.whenReady().then(() => {
  if (liveYouTube) return;
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] },
    ({ url }, done) => done({ cancel: ![target, slowBills, consumers, billView, video, youtubeHome, youtubeResults, channelFixture, ...channelShorts, alternateVideo, shortcutSite, shortcutFavicon, linkedin, ...pdfs].includes(url) }));
  session.defaultSession.protocol.handle('https', async (request) => {
    if (request.url === channelFixture || channelShorts.includes(request.url)) {
      const body = request.url === channelFixture ?
        `<main>${channelShorts.map((url, i) => `<ytm-shorts-lockup-view-model><a id="short${i}" href="${url}">Short ${i}</a></ytm-shorts-lockup-view-model>`).join('<br>')}</main>` :
        '<ytd-shorts>Shorts player</ytd-shorts><button aria-label="Next video">Native Next only</button>';
      return new Response('<!doctype html><style>a{display:block;margin:30px}</style>' + body,
        { headers: { 'Content-Type': 'text/html' } });
    }
    if (request.url === target) observedUserAgent = request.headers.get('user-agent');
    if (request.url === shortcutSite) return new Response('<link rel="icon" href="/favicon.png">Shortcut fixture',
      { headers: { 'Content-Type': 'text/html' } });
    if (request.url === shortcutFavicon) return new Response(
      fs.readFileSync(path.join(__dirname, '../../src/assets/logo/BOBO_Arctic_Frost/favicon-32.png')),
      { headers: { 'Content-Type': 'image/png' } });
    if (request.url === youtubeHome || request.url === youtubeResults) return new Response(
      '<a href="/watch?v=abcdefghijk" onclick="event.preventDefault(); history.pushState({}, \'\', this.href)">Video</a>',
      { headers: { 'Content-Type': 'text/html' } }
    );
    if (request.url === linkedin) return new Response(`
      <main style="height:520px;overflow:auto"><article class="feed-shared-update-v2" style="width:320px;height:1200px;background:#369">
      <p class="update-components-text">Selected LinkedIn fixture post</p></article>
      <article>Neighbouring post</article></main>
    `, { headers: { 'Content-Type': 'text/html' } });
    if (request.url === slowBills) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } });
    }
    if (request.url === pdfs[0]) {
      directPdfPending = true;
      await new Promise((resolve) => setTimeout(resolve, 800));
      directPdfPending = false;
    }
    if (request.url === pdfs[1]) pdfsOverlapped = directPdfPending;
    return request.url === billView
    ? new Response(null, { status: 302, headers: { Location: '/bill-two.pdf' } })
    : pdfs.includes(request.url)
    ? new Response('%PDF-1.7 fixture', { headers: { 'Content-Type': 'application/pdf' } })
    : new Response(`
    <script>window.fixtureInitialDark = document.documentElement.hasAttribute('dark');</script>
    <label for="account">Connection No</label><input id="account">
    <button>Show History</button><div id="result">No Records Found</div>
    <select id="area"><option value="">Select Sector</option><option value="7">North Area</option><option value="8">South Area</option></select>
    <script>
      document.querySelector('button').onclick = () => {
        const account = document.querySelector('input').value;
        if (account === '009997') return; // client-side miss with no DOM change
        if (account === '001236') {
          // Slow real request: it must not be marked empty while in flight.
          (window.submittedAccounts ||= []).push(account);
          fetch(${JSON.stringify(slowBills)}).then(() => {
            document.querySelector('#result').innerHTML =
              'Sector: Sector B<br><table><tr><th>Bill No</th></tr>'
              + '<tr><td>1</td><td>2</td><td>3</td><td>4</td><td>5</td></tr></table>';
          });
          return;
        }
        if (account === '009999') {
          // Real portal shape: a no-data toast plus an empty table, with no
          // network request at all for the lookup.
          const toast = document.createElement('div');
          toast.className = 'mat-snack-bar-container';
          toast.textContent = 'No Data Found';
          document.body.appendChild(toast);
          document.querySelector('#result').innerHTML = 'No Records Found';
          return;
        }
        if (!['001234', '001235'].includes(account) && !${process.argv.includes('--bills-recovery')}) return;
        (window.submittedAccounts ||= []).push(account);
        document.querySelector('#result').innerHTML =
          'Sector: Sector A<br><table><tr><th>Bill No</th></tr><tr><td>1</td><td>2</td><td>3</td><td>4</td><td>5</td></tr></table>';
      };
    </script>
  `, { headers: { 'Content-Type': 'text/html' } });
  });
});

const handlers = new Map();
if (process.argv.includes('--stage2-security')) {
  const register = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, handler) => {
    handlers.set(channel, handler);
    return register(channel, handler);
  };
}
const restoreFixture = process.argv.includes('--bobo-restore-database');
if (restoreFixture) {
  const { createBrowserServices } = require('../../src/main/data');
  const { makeBackup } = require('../../src/main/database-backup');
  const fixture = createBrowserServices({ dataDir: profile });
  fixture.bookmarks.add({ url: 'https://restore.test/backup', title: 'From backup' });
  const snapshot = makeBackup(fixture.store, history).then((result) => {
    fixture.bookmarks.add({ url: 'https://restore.test/newer', title: 'After backup' });
    fixture.store.close();
    return result;
  });
  dialog.showOpenDialog = async () => {
    assert.equal(BrowserWindow.getAllWindows().length, 0);
    return { canceled: false, filePaths: [(await snapshot).file] };
  };
  dialog.showMessageBox = async () => ({ response: 1 });
}
require('../../src/main/main');

async function until(read, expected) {
  let actual;
  for (let attempt = 0; attempt < 150; attempt++) {
    actual = await read();
    if (actual === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert.equal(actual, expected);
}

app.whenReady().then(async () => {
  await until(() => BrowserWindow.getAllWindows()[0]?.webContents.getURL().endsWith('/index.html'), true);
  const win = BrowserWindow.getAllWindows()[0];
  win.show();
  const run = (js) => win.webContents.executeJavaScript(js);
  const content = () => win.contentView.children.find((view) => view.webContents !== win.webContents)?.webContents;
  const read = (id) => run(`document.getElementById('${id}').textContent`);
  if (process.argv.includes('--settings-navigation')) {
    assert.equal(await run("document.getElementById('sidebar-settings').textContent.trim()"), 'Settings');
    await run("document.getElementById('sidebar-settings').click()");
    await until(() => content()?.getURL().includes('/settings.html?view=search'), true);
    await run("document.querySelector('[data-action=menu-passwords]').click()");
    await until(() => content()?.getURL().includes('/settings.html?view=passwords'), true);
    console.log('PASS Settings navigation: sidebar Settings and Passwords and Autofill open their existing full Settings pages.');
    return;
  }
  if (process.argv.includes('--youtube-channel')) {
    await run(`bobo.createTab(${JSON.stringify(channelFixture)})`);
    await until(() => content()?.getURL(), channelFixture);
    const wc = content();
    await until(() => wc.isLoading(), false);
    // Exercise real TabManager ownership and preload IPC here. Trusted input is
    // exercised separately in youtube-navigation-smoke.js, without chrome focus.
    const event = { sender: wc, senderFrame: wc.mainFrame };
    ipcMain.listeners('bobo:youtube:channel-shorts')[0](event,
      { op: 'capture', ids: ['aaaaaaaaaaa', 'bbbbbbbbbbb'], selected: 'aaaaaaaaaaa' });
    assert.equal(event.returnValue.ids.length, 2);
    const controls = "document.getElementById('bobo-channel-shorts-controls')?.shadowRoot";
    await wc.loadURL(channelShorts[0]);
    await until(() => wc.getURL(), channelShorts[0]);
    await until(() => wc.executeJavaScript(`!!(${controls})`), true);
    assert.equal(await wc.executeJavaScript(`${controls}.getElementById('previous').disabled`), true);
    await wc.loadURL(channelShorts[1]);
    await until(() => wc.getURL(), channelShorts[1]);
    await until(() => wc.executeJavaScript(`!!(${controls})`), true);
    assert.equal(await wc.executeJavaScript(`${controls}.getElementById('previous').disabled`), false);
    await wc.loadURL(channelShorts[0]);
    await until(() => wc.getURL(), channelShorts[0]);
    assert.equal(content(), wc, 'channel navigation keeps the original tab');
    console.log('PASS production channel Shorts wiring: authorized tab queue, preload IPC across document loads, visible Previous/Next and missing native Previous.');
    return;
  }
  if (process.argv.includes('--video-fullscreen')) {
    await run(`bobo.createTab(${JSON.stringify(target)})`);
    await until(() => content()?.getURL(), target);
    await until(() => content().executeJavaScript('!!document.querySelector("#account")'), true);
    const page = content();
    await page.executeJavaScript(`document.body.innerHTML = '<div id="player" style="background:green"><button id="full">Full screen</button></div>';
      document.querySelector('#full').onclick = () => document.querySelector('#player').requestFullscreen(); void 0;`);
    const enter = async () => {
      const point = await page.executeJavaScript(`(() => {
        const r = document.querySelector('#full').getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`);
      win.focus();
      page.focus();
      page.sendInputEvent({ ...point, type: 'mouseDown', button: 'left', clickCount: 1 });
      page.sendInputEvent({ ...point, type: 'mouseUp', button: 'left', clickCount: 1 });
      await until(() => page.executeJavaScript('document.fullscreenElement?.id'), 'player');
      await until(() => {
        const bounds = win.contentView.children.find((view) => view.webContents === page).getBounds();
        const [width, height] = win.getContentSize();
        return bounds.x === 0 && bounds.y === 0 && bounds.width === width && bounds.height === height;
      }, true);
    };
    await enter();
    assert.equal(win.isFullScreen(), true);
    page.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    await until(() => page.executeJavaScript('!!document.fullscreenElement'), false);
    await until(() => win.isFullScreen(), false);
    await until(() => win.contentView.children.find((view) => view.webContents === page).getBounds().y > 0, true);
    await run('bobo.toggleFullScreen()');
    await until(() => win.isFullScreen(), true);
    await enter();
    await page.executeJavaScript('document.exitFullscreen()');
    await until(() => page.executeJavaScript('!!document.fullscreenElement'), false);
    assert.equal(win.isFullScreen(), true);
    console.log('Video fullscreen covered browser controls, Escape restored layout and browser fullscreen was preserved');
    return;
  }
  if (process.argv.includes('--browser-identity')) {
    await run(`bobo.createTab(${JSON.stringify(target)})`);
    await until(() => content()?.getURL(), target);
    await until(() => content().executeJavaScript('!!document.querySelector("#account")'), true);
    const userAgent = await content().executeJavaScript('navigator.userAgent');
    assert.equal(userAgent, observedUserAgent);
    assert.ok(userAgent.includes('Chrome/' + process.versions.chrome));
    assert.ok(!/Electron\/|bobo\//i.test(userAgent));
    assert.equal(await content().executeJavaScript('typeof window.bobo'), 'undefined');
    console.log('Webpage and request used the installed Chromium identity without Electron application tokens');
    return;
  }
  if (process.argv.includes('--shortcut-favicon')) {
    await run(`bobo.createTab(${JSON.stringify(shortcutSite)})`);
    await until(() => run(`(async () => (await bobo.getState()).tabs.tabs.some(tab => tab.favicon === ${JSON.stringify(shortcutFavicon)}))()`), true);
    await run('bobo.createTab()');
    await until(() => content()?.getURL().endsWith('/newtab.html'), true);
    const items = [{ title: 'Shortcut fixture', url: shortcutSite }, { title: 'Instagram', url: 'https://www.instagram.com/' }];
    await content().executeJavaScript(`localStorage.setItem('bobo:custom-shortcuts', ${JSON.stringify(JSON.stringify(items))});
      window.dispatchEvent(new Event('focus'));`);
    await until(() => content().executeJavaScript('!!document.querySelector(".tile-icon-img[src^=\'data:image/png\']")'), true);
    assert.equal(await content().executeJavaScript('!!document.querySelector(".tile-icon-img[src$=\'instagram.svg\']")'), true);
    console.log('New Tab loaded a same-origin favicon and the bundled Instagram icon');
    return;
  }
  if (process.argv.includes('--alternate-youtube')) {
    await run('bobo.setBrowserSettings({ alternateYouTube: true })');
    await run(`bobo.createTab(${JSON.stringify(youtubeHome)})`);
    await until(() => content()?.getURL(), youtubeHome);
    await run(`bobo.navigate(null, ${JSON.stringify(youtubeResults)})`);
    await until(() => content()?.getURL(), youtubeResults);
    await until(() => content().executeJavaScript('!!document.querySelector("a")'), true);
    assert.equal(content().getURL(), youtubeResults);
    const sourcePage = content();
    await until(() => sourcePage.executeJavaScriptInIsolatedWorld(1105,
      [{ code: 'globalThis.boboAlternateVideoClicks' }]), true);
    const point = await sourcePage.executeJavaScript('(() => { const r = document.querySelector("a").getBoundingClientRect(); return { x: Math.round(r.x + 4), y: Math.round(r.y + 4) }; })()');
    sourcePage.focus();
    sourcePage.sendInputEvent({ ...point, type: 'mouseDown', button: 'left', clickCount: 1 });
    sourcePage.sendInputEvent({ ...point, type: 'mouseUp', button: 'left', clickCount: 1 });
    await until(() => content()?.getURL(), alternateVideo);
    assert.equal(sourcePage.getURL(), youtubeResults);
    await run('bobo.setBrowserSettings({ alternateYouTube: false })');
    await run(`bobo.navigate(null, ${JSON.stringify(video)})`);
    await until(() => content()?.getURL(), video);
    console.log('YouTube home stayed on YouTube, a video click routed to the alternate domain, and disabling preserved the original URL');
    return;
  }
  if (liveYouTube) {
    await run('bobo.setYouTubeAutoSkip(true)');
    await run('bobo.createTab("https://www.youtube.com/watch?v=dQw4w9WgXcQ")');
    await until(() => content()?.getURL().startsWith('https://www.youtube.com/watch?'), true);
    const page = content();
    let installed = false;
    for (let attempt = 0; attempt < 25; attempt++) {
      const result = await page.executeJavaScriptInIsolatedWorld(1103, [{ code: `(() => {
        if (!globalThis.liveSkipProbe) {
          globalThis.liveSkipProbe = { clicks: 0 };
          document.addEventListener('click', (event) => {
            if (event.target.closest('button.ytp-skip-ad-button, button.ytp-ad-skip-button, button.ytp-ad-skip-button-modern')) {
              globalThis.liveSkipProbe.clicks++;
            }
          }, true);
        }
        const player = document.querySelector('#movie_player');
        const video = player?.querySelector('video');
        if (video?.paused) void video.play().catch(() => {});
        return { installed: !!globalThis.boboSkipObserver, clicks: globalThis.liveSkipProbe.clicks,
          playing: !!video && video.currentTime > 0, player: !!player };
      })()` }]);
      installed ||= result.installed;
      if (result.clicks) {
        console.log('Public YouTube skip button click observed');
        return;
      }
      if (attempt === 24) console.log('Live YouTube sample:', { ...result, installed });
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return;
  }
  if (process.argv.includes('--youtube-auto-skip')) {
    await run(`bobo.createTab(${JSON.stringify(video)})`);
    await until(() => content()?.getURL(), video);
    await until(() => run('!!document.querySelector(\'[data-tool-open="youtube-auto-skip"]\')'), true);
    await run('document.querySelector(\'[data-tool-open="youtube-auto-skip"]\').click()');
    await until(() => run('!document.querySelector("#youtube-auto-skip").disabled'), true);
    const page = content();
    await page.executeJavaScript(`document.body.innerHTML =
      '<div id="movie_player" class="ad-showing"><button class="ytp-skip-ad-button" disabled>Skip</button></div>';
      window.skips = 0; document.querySelector('button').onclick = () => window.skips++; void 0;`);
    await run('document.querySelector("#youtube-auto-skip").click()');
    await until(() => read('youtube-auto-skip-status'), 'Auto Skip is on.');
    assert.equal(await page.executeJavaScript('window.skips'), 0);
    await page.executeJavaScript('document.querySelector("button").disabled = false');
    await until(() => page.executeJavaScript('window.skips'), 1);
    await page.executeJavaScript(`(() => {
      const player = document.querySelector('#movie_player');
      player.className = '';
      player.innerHTML = '<button>Skip</button><div class="ytp-ad-module">' +
        '<div role="button" aria-label="Skip ad" aria-disabled="true">Skip</div></div>';
      player.firstElementChild.onclick = () => window.skips += 100;
      player.querySelector('[role="button"]').onclick = () => window.skips++;
    })()`);
    assert.equal(await page.executeJavaScript('window.skips'), 1);
    await page.executeJavaScript('document.querySelector("[role=button]").setAttribute("aria-disabled", "false")');
    await until(() => page.executeJavaScript('window.skips'), 2);
    win.focus();
    page.focus();
    await page.executeJavaScript(`(() => {
      const player = document.querySelector('#movie_player');
      player.className = 'ad-showing';
      player.innerHTML = '<button class="ytp-skip-ad-button">Skip</button>';
      player.firstElementChild.onclick = (event) => { if (event.isTrusted) window.skips++; };
    })()`);
    await until(() => page.executeJavaScript('window.skips'), 3);
    await run('bobo.reload()');
    await until(() => page.executeJavaScript('typeof window.skips'), 'undefined');
    await until(() => page.executeJavaScriptInIsolatedWorld(1103, [{ code: '!!globalThis.boboSkipObserver' }]), true);
    await run('document.querySelector("#youtube-auto-skip").click()');
    await until(() => read('youtube-auto-skip-status'), 'Auto Skip is off.');
    await until(() => page.executeJavaScriptInIsolatedWorld(1103, [{ code: '!globalThis.boboSkipObserver' }]), true);
    console.log('Auto Skip clicked once when enabled and detached when switched off');
    return;
  }
  if (process.argv.includes('--linkedin-capture')) {
    dialog.showSaveDialog = async (_window, options) => ({
      canceled: false, filePath: path.join(history, 'linkedin.' + options.filters[0].extensions[0]),
    });
    await assert.rejects(run('bobo.captureLinkedIn("text")'), /Open a LinkedIn tab first/);
    await run(`bobo.createTab(${JSON.stringify(linkedin)})`);
    await until(() => content()?.getURL(), linkedin);
    await until(() => content().executeJavaScript('!!document.querySelector("article")'), true);
    await until(() => run('!!document.querySelector(\'[data-tool-open="linkedin-capture"]\')'), true);
    await run('document.querySelector(\'[data-tool-open="linkedin-capture"]\').click()');
    const clickPost = async (mode) => {
      await run(`document.querySelector('#linkedin-${mode}').click()`);
      const page = content();
      page.focus();
      for (let attempt = 0; attempt < 20; attempt++) {
        page.sendInputEvent({ type: 'mouseMove', x: 30 + attempt, y: 40 });
        if (await page.executeJavaScript('!!document.querySelector("article").style.outline')) break;
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      page.sendInputEvent({ type: 'mouseDown', x: 40, y: 40, button: 'left', clickCount: 1 });
      page.sendInputEvent({ type: 'mouseUp', x: 40, y: 40, button: 'left', clickCount: 1 });
      await until(() => read('linkedin-status'), 'Post captured.');
    };
    await clickPost('text');
    assert.equal(await run('document.querySelector("#linkedin-preview-text").value'), 'Selected LinkedIn fixture post');
    await run('document.querySelector("#linkedin-save").click()');
    await until(() => read('linkedin-status'), 'Saved.');
    assert.equal(fs.readFileSync(path.join(history, 'linkedin.txt'), 'utf8'), 'Selected LinkedIn fixture post');
    await clickPost('image');
    await until(() => run('document.querySelector("#linkedin-preview-image").naturalHeight'), 1200);
    await run('document.querySelector("#linkedin-save").click()');
    await until(() => read('linkedin-status'), 'Saved.');
    assert.equal(nativeImage.createFromPath(path.join(history, 'linkedin.png')).getSize().height, 1200);
    assert.equal(await content().executeJavaScript('scrollY'), 0);
    assert.equal(await content().executeJavaScript('document.querySelector("main").scrollTop'), 0);
    assert.equal(await content().executeJavaScript('typeof window.bobo'), 'undefined');
    console.log('LinkedIn text and stitched image captured through the tools panel');
    return;
  }
  if (process.argv.includes('--youtube-theme')) {
    await run(`bobo.createTab(${JSON.stringify(video)})`);
    await until(() => content()?.getURL(), video);
    await content().executeJavaScript(`(() => {
      const style = document.createElement('style');
      style.textContent = ':root { --yt-spec-base-background: #ffffff } ' +
        ':root[dark] { --yt-spec-base-background: #0f0f0f } ' +
        'body { background: var(--yt-spec-base-background) }';
      document.head.append(style);
    })()`);
    assert.equal(await run('bobo.setYouTubeTheme("dark")'), 'dark');
    assert.equal(await content().executeJavaScript('getComputedStyle(document.body).backgroundColor'), 'rgb(15, 15, 15)');
    assert.equal(await run('(async () => (await bobo.browserSettings()).youtubeTheme)()'), 'dark');
    const reloaded = new Promise(resolve => content().once('did-finish-load', resolve));
    content().reload(); await reloaded;
    assert.equal(await content().executeJavaScript('window.fixtureInitialDark'), true,
      'saved mode reaches the document-start preload through the production IPC handler');
    assert.equal(await run('bobo.setYouTubeTheme("light")'), 'light');
    assert.equal(await content().executeJavaScript('getComputedStyle(document.body).backgroundColor'), 'rgb(255, 255, 255)');
    await content().executeJavaScript(`document.body.insertAdjacentHTML(
      'beforeend', '<ytd-app style="display:block;background-color:white">Watch page</ytd-app>')`);
    assert.equal(await run('bobo.setYouTubeTheme("dark")'), 'dark');
    assert.equal(await content().executeJavaScript('getComputedStyle(document.querySelector("ytd-app")).backgroundColor'), 'rgb(15, 15, 15)');
    assert.equal(await run('bobo.setYouTubeTheme("default")'), 'default');
    assert.equal(await content().executeJavaScript('getComputedStyle(document.querySelector("ytd-app")).backgroundColor'), 'rgb(255, 255, 255)');
    await run(`bobo.navigate(null, ${JSON.stringify(target)})`);
    await until(() => content()?.getURL(), target);
    await assert.rejects(run('bobo.setYouTubeTheme("dark")'), /select a theme on a YouTube tab/);
    console.log('YouTube theme changed fixture colors, saved the choice and rejected an unrelated website');
    return;
  }
  if (process.argv.includes('--bookmarks-menu')) {
    let menu;
    Menu.prototype.popup = function () { menu = this; };
    dialog.showMessageBox = async () => ({ response: 1 });
    await run(`bobo.createTab(${JSON.stringify(target)})`);
    await until(() => content()?.getURL(), target);
    await run('bobo.openBookmarkMenu()');
    const item = (label) => menu.items.find((entry) => entry.label === label);
    assert.ok(item('Import bookmarks and settings…'));
    assert.ok(item('Open bookmarks manager'));
    item('Bookmark all tabs…').click();
    await until(() => run('(async () => (await bobo.listBookmarks()).folders.some(f => f.name === "Bookmarked tabs"))()'), true);
    item('Reading list').submenu.items[0].click();
    await until(() => run('(async () => (await bobo.listBookmarks()).folders.some(f => f.name === "Reading list"))()'), true);
    item('Show bookmarks in side panel').click();
    await until(() => run('!document.querySelector("#sidebar-bookmarks").hidden'), true);
    item('Show bookmarks bar').submenu.items.find((entry) => entry.label === 'Always hide').click();
    await until(() => run('(async () => (await bobo.browserSettings()).bookmarks.barVisible)()'), 'never');
    await run(`(async () => {
      const { tabs } = await bobo.getState();
      await bobo.createTabGroup({ name: 'Original name', color: 'blue', tabIds: [tabs.activeId] });
      document.querySelector('.tab-group-label').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    })()`);
    await until(() => Boolean(item('Rename Group…')), true);
    item('Rename Group…').click();
    await until(() => run('document.querySelector("#rename-group-dialog").open'), true);
    await run(`document.querySelector('#rename-group-name').value = 'New group name';
      document.querySelector('#rename-group-dialog button[value="save"]').click();`);
    await until(() => run('document.querySelector(".tab-group-label").textContent.includes("New group name")'), true);
    console.log('Bookmark menu, all tabs, reading list, side panel and visibility passed');
    return;
  }
  if (process.argv.includes('--bookmarks-overflow')) {
    win.setSize(900, 740);
    let menu;
    Menu.prototype.popup = function () { menu = this; };
    await run(`(async () => {
      await bobo.addBookmark({ url: 'https://fixture.test/first', title: 'First bookmark' });
      const folder = await bobo.addBookmarkFolder('Work folder', 1);
      await bobo.addBookmark({ url: 'https://fixture.test/inside', title: 'Nested bookmark', folderId: folder.id });
      for (let i = 0; i < 16; i++) await bobo.addBookmark({
        url: 'https://fixture.test/' + i, title: 'Long bookmark title ' + i,
      });
    })()`);
    await until(() => run('document.querySelector("#bookmarks-overflow")?.hidden === false'), true);
    const labels = await run('[...document.querySelectorAll("#bookmarks-bar .bm-item:not([hidden])")].map(node => node.textContent)');
    assert.match(labels[0], /First bookmark/);
    assert.equal(labels[1], 'Work folder');
    assert.equal(labels.at(-1), '»');
    const start = await run('Number(document.querySelector("#bookmarks-overflow").dataset.start)');
    await run('document.querySelector("#bookmarks-overflow").click()');
    await until(() => Boolean(menu), true);
    assert.equal(menu.items[0].label, 'Long bookmark title ' + (start - 2));
    await run('document.querySelector("#bookmarks-bar .bm-folder").click()');
    await until(() => run('document.querySelector("#bm-folder-menu").textContent.includes("Nested bookmark")'), true);
    console.log('Bookmarks stayed readable and folder and overflow menus exposed their contents');
    return;
  }
  if (process.argv.includes('--local-suggestions')) {
    await run(`bobo.addBookmark({ url: ${JSON.stringify(video)}, title: 'YouTube fixture' })`);
    const type = (id, query) => `(() => {
      const field = document.getElementById(${JSON.stringify(id)});
      field.focus();
      field.value = ${JSON.stringify(query)};
      field.dispatchEvent(new Event('input', { bubbles: true }));
    })()`;
    await until(() => content()?.getURL().includes('/newtab.html'), true);
    await content().executeJavaScript(type('q', 'YouTube'));
    await until(() => content().executeJavaScript(
      'document.querySelector("#newtab-suggestions").textContent.includes("YouTube fixture")'), true);
    await run(type('omnibox-input', 'YouTube'));
    await until(() => run(
      'document.querySelector("#omnibox-suggestions").textContent.includes("YouTube fixture")'), true);
    await run(`for (const key of ['ArrowDown', 'Enter']) {
      document.querySelector('#omnibox-input').dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    }`);
    await until(() => content()?.getURL(), video);
    await until(() => run('!document.querySelector("#btn-youtube-appearance").hidden'), true);
    assert.equal(await content().executeJavaScript('typeof window.bobo'), 'undefined');
    await run(`bobo.navigate(null, ${JSON.stringify(target)})`);
    await until(() => run('document.querySelector("#btn-youtube-appearance").hidden'), true);
    console.log('Local suggestions appeared in both search fields and the theme help was YouTube-only');
    return;
  }
  if (process.argv.includes('--page-zoom')) {
    await run(`bobo.createTab(${JSON.stringify(target)})`);
    await until(() => content()?.getURL(), target);
    assert.equal(await run('bobo.zoomIn()'), 110);
    assert.equal(await run('bobo.zoomIn()'), 125);
    assert.equal(await run('bobo.zoomOut()'), 110);
    content().emit('zoom-changed', {}, 'out');
    await until(() => run('bobo.zoomLevel()'), 100);
    content().emit('zoom-changed', {}, 'in');
    await until(() => read('menu-zoom-reset'), '110%');
    await until(() => read('btn-page-zoom'), '110%');
    assert.equal(await run('document.querySelector("#btn-page-zoom").hidden'), false);
    content().sendInputEvent({ type: 'keyDown', keyCode: '0', modifiers: ['control'] });
    await until(() => run('bobo.zoomLevel()'), 100);
    await until(() => run('document.querySelector("#btn-page-zoom").hidden'), true);
    assert.equal(win.webContents.getZoomFactor(), 1);
    console.log('Page zoom steps, wheel event, Ctrl+0 and chrome isolation passed');
    return;
  }
  if (restoreFixture) {
    const bookmarks = await run('bobo.listBookmarks()');
    assert.ok(bookmarks.bookmarks.some(({ url }) => url === 'https://restore.test/backup'));
    assert.ok(!bookmarks.bookmarks.some(({ url }) => url === 'https://restore.test/newer'));
    assert.ok(fs.readdirSync(profile).some((name) => name.startsWith('before-restore-')));
    console.log('Startup restored the selected backup before opening browser windows');
    return;
  }
  if (process.argv.includes('--screenshot-crop')) {
    await run(`bobo.createTab(${JSON.stringify(target)})`);
    await until(() => content()?.getURL(), target);
    await until(() => content().executeJavaScript('!!document.querySelector("#account")'), true);
    const image = nativeImage.createFromDataURL(await run(`(() => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 512;
      const context = canvas.getContext('2d');
      context.fillStyle = 'white';
      context.fillRect(0, 0, 512, 512);
      context.fillStyle = 'black';
      context.font = 'bold 32px Arial';
      context.fillText('BOBO TEXT', 160, 250);
      return canvas.toDataURL('image/png');
    })()`));
    assert.equal(image.isEmpty(), false);
    content().capturePage = async () => image;
    await until(() => run(`!!document.querySelector('[data-tool-open="screenshot"]')`), true);
    await run(`document.querySelector('[data-tool-open="screenshot"]').click();
      document.querySelector('#shot-capture').click()`);
    await until(() => run('document.querySelector("#shot-preview").naturalWidth'), 512);
    await run('document.querySelector("#shot-crop").click()');
    const [start, end] = await run(`{
      const rect = document.querySelector('#shot-preview').getBoundingClientRect();
      [0.25, 0.75].map(f => ({ x: Math.round(rect.left + rect.width * f), y: Math.round(rect.top + rect.height * f) }));
    }`);
    win.webContents.sendInputEvent({ type: 'mouseDown', ...start, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseMove', ...end, button: 'left' });
    win.webContents.sendInputEvent({ type: 'mouseUp', ...end, button: 'left', clickCount: 1 });
    await until(() => run('!document.querySelector("#shot-crop-apply").disabled'), true);
    await run('document.querySelector("#shot-crop-apply").click()');
    await until(async () => (await read('shot-status')).includes('Crop applied'), true);
    await until(() => run('document.querySelector("#shot-text").value.includes("BOBO TEXT")'), true);
    await run('document.querySelector("#shot-save").click()');
    await until(async () => (await read('shot-status')).includes('Saved to'), true);
    const size = nativeImage.createFromBuffer(fs.readFileSync(merged)).getSize();
    assert.ok(Math.abs(size.width - 256) < 8 && Math.abs(size.height - 256) < 8);
    await run('document.querySelector("#shot-crop-reset").click()');
    await until(() => run('document.querySelector("#shot-preview").naturalWidth'), 512);
    assert.equal(await run('document.querySelector("#shot-text").hidden'), true);
    await run('document.querySelector("#sidebar-manage-tools").click()');
    await until(() => run('!!document.querySelector(\'[data-tool-sidebar="notes"]\')'), true);
    await run('document.querySelector(\'[data-tool-sidebar="notes"]\').click()');
    await until(() => run('!document.querySelector(\'[data-side-tools] [data-tool-open="notes"]\')'), true);
    assert.equal(await run('!!document.querySelector(\'[data-tool="notes"]\')'), true);
    assert.equal(await run('(async () => (await bobo.toolsState()).tools.find(t => t.id === "notes").sidebar)()'), false);
    assert.equal(await run('!!document.querySelector(\'[data-menu-tools] [data-tool-open="notes"]\')'), true);
    await run('document.querySelector("#btn-menu").click()');
    await run('document.querySelector(\'[data-menu-tools] [data-tool-open="notes"]\').click()');
    assert.equal(await run('document.querySelector("#chrome-menu").hidden'), true);
    assert.equal(await run('document.querySelector(\'[data-view="notes"]\').hidden'), false);
    await run('document.querySelector("#sidebar-manage-tools").click()');
    await run('document.querySelector(\'[data-tool-sidebar="notes"]\').click()');
    await until(() => run('!!document.querySelector(\'[data-side-tools] [data-tool-open="notes"]\')'), true);
    console.log('Screenshot drag crop saved the selected pixels and restored the original');
    return;
  }
  if (process.argv.includes('--stage2-security')) {
    const watchdog = setTimeout(() => { console.error('Stage 2 smoke timed out'); app.exit(1); }, 20000);
    const fixtureTab = async (window, marker) => {
      const chrome = window.webContents;
      await until(() => chrome.getURL().endsWith('/index.html'), true);
      await chrome.executeJavaScript(`bobo.createTab(${JSON.stringify(target)})`);
      const active = () => window.contentView.children.find((view) => view.webContents !== chrome)?.webContents;
      await until(() => active()?.getURL(), target);
      await until(() => active().executeJavaScript('!!document.querySelector("#account")'), true);
      const contents = active();
      await contents.executeJavaScript(`document.body.innerHTML =
        '<table><thead><tr><th>Marker</th></tr></thead><tbody><tr><td>${marker}</td></tr></tbody></table>'; void 0;`);
      return contents;
    };
    const first = await fixtureTab(win, 'FIRST_WINDOW');
    console.log('Stage 2 first window ready');
    assert.equal(await first.executeJavaScript('typeof window.bobo'), 'undefined');
    await first.executeJavaScript(`document.body.insertAdjacentHTML('beforeend', '<iframe src="about:blank"></iframe>')`);
    await until(() => first.mainFrame.frames.length, 1);
    const call = (channel, sender, senderFrame, payload) =>
      Promise.resolve().then(() => handlers.get(channel)({ sender, senderFrame }, payload));
    await assert.rejects(call('bobo:get-state', first, first.mainFrame), /untrusted/);
    await assert.rejects(call('bobo:get-state', first, first.mainFrame.frames[0]), /untrusted/);
    console.log('Stage 2 remote frames denied');
    await run('bobo.newWindow()');
    await until(() => BrowserWindow.getAllWindows().length, 2);
    const secondWindow = BrowserWindow.getAllWindows().find((window) => window !== win);
    const second = await fixtureTab(secondWindow, 'SECOND_WINDOW');
    console.log('Stage 2 second window ready');
    const data = await run('bobo.inspectTable()');
    assert.deepEqual(data.rows, [['FIRST_WINDOW']]);
    assert.deepEqual((await secondWindow.webContents.executeJavaScript('bobo.inspectTable()')).rows, [['SECOND_WINDOW']]);
    let captured;
    first.capturePage = async () => { captured = 'first'; return null; };
    second.capturePage = async () => { captured = 'second'; return null; };
    await run('bobo.captureScreenshot()');
    assert.equal(captured, 'first');
    await assert.rejects(call('bobo:tabs:create', win.webContents, win.webContents.mainFrame, []), /invalid IPC payload/);
    await run('bobo.openSettings("tabs")');
    await until(() => content()?.getURL().includes('/settings.html'), true);
    const settings = content();
    await until(() => settings.executeJavaScript('typeof window.bobo?.browserSettings'), 'function');
    assert.equal(await settings.executeJavaScript('typeof window.bobo?.inspectTable'), 'undefined');
    await assert.rejects(call('bobo:export:inspect-table', settings, settings.mainFrame), /not allowed/);
    const unowned = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    try {
      await unowned.loadFile(path.resolve(__dirname, '../../src/renderer/index.html'));
      await assert.rejects(call('bobo:get-state', unowned.webContents, unowned.webContents.mainFrame), /untrusted/);
    } finally {
      unowned.destroy();
    }
    const transitioningId = await run('bobo.createTab()');
    await until(() => content()?.getURL().endsWith('/newtab.html'), true);
    const transitioning = content();
    await until(() => transitioning.executeJavaScript('typeof window.bobo?.pickAttachments'), 'function');
    await run(`bobo.navigate(${transitioningId}, ${JSON.stringify(target)})`);
    await until(() => transitioning.getURL(), target);
    await until(() => transitioning.executeJavaScript('typeof window.bobo'), 'undefined');
    console.log('Stage 2 page roles verified');
    await run(`bobo.transcriptExport({format:'pdf',title:'<script>title</script>',segments:[{start:1,text:'<img src=x onerror=alert(1)> & "quotes"'}]})`);
    assert.equal(fs.readFileSync(path.join(history, 'stage2.pdf')).subarray(0, 5).toString(), '%PDF-');
    clearTimeout(watchdog);
    console.log('Stage 2 fixture verified remote and nested denial, page roles, two-window exports and real transcript PDF');
    return;
  }
  if (process.argv.includes('--database-backup')) {
    assert.equal(await run('typeof bobo.backupDatabase'), 'undefined');
    await run('bobo.openSettings("privacy")');
    await until(() => content()?.getURL().includes('/settings.html'), true);
    await content().executeJavaScript('document.querySelector("#set-btn-backup").click()');
    await until(async () => (await content().executeJavaScript(
      'document.querySelector("#set-backup-status").textContent'
    )).startsWith('Backup saved to '), true);
    const file = fs.readdirSync(history).find((name) => name.endsWith('.sqlite'));
    assert.ok(file);
    const snapshot = fs.readFileSync(path.join(history, file));
    const manifest = JSON.parse(fs.readFileSync(path.join(history, file + '.json'), 'utf8'));
    assert.equal(manifest.sha256, require('node:crypto').createHash('sha256').update(snapshot).digest('hex'));
    console.log('Settings exported a SQLite snapshot and matching checksum');
    return;
  }
  if (process.argv.includes('--scraper-layout')) {
    await until(() => run(`!!document.querySelector('[data-tool-open="web-scraper"]')`), true);
    await run(`document.querySelector('[data-tool-open="web-scraper"]').click()`);
    assert.equal(await run(`[...document.querySelectorAll('#scraper-tools button')].every((card) => {
      const box = card.getBoundingClientRect();
      const description = card.querySelector('span').getBoundingClientRect();
      return description.height > 0 && description.bottom <= box.bottom;
    })`), true);
    await run(`document.querySelector('[data-scraper-view="runs"]').click()`);
    assert.equal(await run(`document.querySelector('[data-scraper-view="runs"]').getAttribute('aria-pressed')`), 'true');
    console.log('Web Scraper descriptions fit inside their cards');
    return;
  }
  if (process.argv.includes('--transcript-only')) {
    await run(`bobo.createTab(${JSON.stringify(video)})`);
    await until(() => content()?.getURL(), video);
    await until(() => content().executeJavaScript('!!document.querySelector("#account")'), true);
    await content().executeJavaScript(`document.body.innerHTML =
      '<section role="dialog"><input placeholder="Search transcript">' +
      '<div>1:05</div><div>नमस्ते fixture caption</div>' +
      '<div>1:12 Segunda línea</div></section>';
    `);
    await until(() => run(`!!document.querySelector('[data-tool-open="transcript"]')`), true);
    await run(`document.querySelector('[data-tool-open="transcript"]').click();
      document.querySelector('#transcript-btn-fetch').click()`);
    await until(async () => (await read('transcript-status')).includes('Extracted 2'), true);
    await run('document.querySelector("#transcript-btn-export").click()');
    await until(() => fs.existsSync(merged), true);
    await until(() => fs.readFileSync(merged, 'utf8').includes('नमस्ते fixture caption'), true);
    assert.match(fs.readFileSync(merged, 'utf8'), /\[01:12\] Segunda línea/);
    await content().executeJavaScript(`document.body.innerHTML =
      '<transcript-segment-view-model><span class="ytTranscriptSegmentViewModelTimestamp">0:36</span>' +
      '<yt-core-attributed-string>Gracias por el viaje, campeón.</yt-core-attributed-string></transcript-segment-view-model>'; void 0;`);
    await run('document.querySelector("#transcript-btn-fetch").click()');
    await until(async () => (await read('transcript-status')).includes('Extracted 1'), true);
    await run('document.querySelector("#transcript-btn-export").click()');
    await until(() => fs.readFileSync(merged, 'utf8').includes('[00:36] Gracias por el viaje, campeón.'), true);
    console.log('YouTube transcript exported from visible timestamped rows without legacy elements');
    return;
  }
  if (restartProfile) {
    const billingId = await run(`bobo.createTab(${JSON.stringify(target)})`);
    await until(() => content()?.getURL(), target);
    const billing = content();
    await until(() => billing.executeJavaScript('!!document.querySelector("#account")'), true);
    await until(() => run(`!!document.querySelector('[data-tool-open="bills"]')`), true);
    await run(`document.querySelector('[data-tool-open="bills"]').click()`);
    if (!process.argv.includes('--verify-restart')) {
      await run(`document.querySelector('#bills-paste-area').value = '001234,001235';
        document.querySelector('#bills-import-btn').click()`);
      await until(() => read('bills-stat-pending'), '2');
      await run('document.querySelector("#bills-btn-start").click()');
      await until(() => billing.executeJavaScript('window.submittedAccounts?.length'), 2);
      assert.equal(await read('bills-stat-done'), '1');
      console.log('Exiting with one completed lookup and one in progress');
      return;
    }
    await until(() => read('bills-stat-total'), '2');
    assert.equal(await read('bills-stat-done'), '1');
    assert.equal(await read('bills-stat-pending'), '1');
    assert.equal(await billing.executeJavaScript('window.submittedAccounts?.length || 0'), 0);
    await run('document.querySelector("#bills-btn-start").click()');
    await until(() => read('bills-stat-done'), '2');
    assert.deepEqual(await billing.executeJavaScript('window.submittedAccounts'), ['001235']);
    assert.equal((await run('bobo.getState()')).tabs.activeId, billingId);
    console.log('Bills History restored its selected queue and retried only the interrupted lookup');
    return;
  }
  if (process.argv.includes("--consumer-only")) {
    await run(`bobo.createTab(${JSON.stringify(consumers)})`);
    await until(() => content()?.getURL(), consumers);
    await until(() => content().executeJavaScript("!!document.querySelector('#account')"), true);
    await content().executeJavaScript(`document.body.innerHTML = \`
      <table><thead><tr><th>Sr #</th><th>Connection No</th><th>Actions</th></tr></thead>
      <tbody><tr><td>2</td><td>2000</td><td>View</td></tr></tbody></table>
      <div class="mat-mdc-paginator-range-label">2 – 2 of 2</div>
      <button aria-label="First page">First</button><button aria-label="Next page">Next</button>
    \`;
    const turn = (number) => {
      document.querySelector('.mat-mdc-paginator-range-label').textContent = number + ' – ' + number + ' of 2';
      document.querySelector('tbody td').textContent = number;
      setTimeout(() => document.querySelector('tbody td:nth-child(2)').textContent = number * 1000, 300);
    };
    document.querySelector('[aria-label="First page"]').onclick = () => turn(1);
    document.querySelector('[aria-label="Next page"]').onclick = () => turn(2); void 0;`);
    await run(`document.querySelector('[data-tool-open="csv-extractor"]').click();
      document.querySelector('#consumer-csv-start').click()`);
    const source = content();
    await until(() => source.executeJavaScript('document.querySelector("tbody td").textContent'), '1');
    const other = await run('bobo.createTab()');
    await until(async () => (await read('consumer-csv-status')).includes('Saved 2 records'), true);
    const consumerCsv = fs.readFileSync(merged, 'utf8');
    assert.match(consumerCsv, /"1","1000"\r?\n"2","2000"/);
    assert.doesNotMatch(consumerCsv, /Actions|View/);
    assert.equal((await run('bobo.getState()')).tabs.activeId, other);
    await run('bobo.saveExportPdf({ title: "Captured report", columns: ["Connection No"], rows: [["2000"]] })');
    assert.equal(fs.readFileSync(merged).subarray(0, 5).toString(), '%PDF-');
    console.log('Consumer List CSV continued after switching tabs, and captured rows exported to PDF');
    return;
  }
  if (process.argv.includes('--bills-recovery')) {
    await run(`bobo.createTab(${JSON.stringify(target)})`);
    await until(() => content()?.getURL(), target);
    await until(() => content()?.isLoading(), false);
    await run(`document.querySelector('[data-tool-open="bills"]').click();
      document.querySelector('#bills-paste-area').value = ${JSON.stringify(Array.from({ length: 12 }, (_, i) => '="' + String(i + 1).padStart(8, '0') + '"').join('\n'))};
      document.querySelector('#bills-import-btn').click();`);
    await until(() => read('bills-stat-total'), '12');
    await run(`document.querySelector('#bills-btn-repair').click()`);
    await until(async () => (await read('bills-live-status')).includes('Completed results unchanged'), true);
    const started = Date.now();
    await run(`document.querySelector('#bills-delay').value = '0'; document.querySelector('#bills-btn-start').click()`);
    await until(() => run(`!!document.querySelector('#bills-recent-rows tr[data-status="processing"]')`), true);
    assert.equal(await run(`document.querySelector('#bills-btn-clear').disabled`), true);
    await until(() => read('bills-stat-done'), '12');
    await until(async () => (await read('bills-live-status')).includes('Extraction complete'), true);
    const elapsed = Date.now() - started;
    assert.equal(await run(`document.querySelectorAll('#bills-recent-rows tr').length`), 10);
    const values = await content().executeJavaScript('window.submittedAccounts');
    assert.equal(new Set(values).size, 12);
    assert.ok(values.every(value => /^0\d+$/.test(value)));
    await run(`document.querySelector('#bills-btn-start').click()`);
    assert.equal((await content().executeJavaScript('window.submittedAccounts')).length, 12);
    await until(() => run(`!document.querySelector('#bills-btn-clear').disabled`), true);
    await run(`document.querySelector('#bills-recent-title').scrollIntoView({block:'start'})`);
    await new Promise(resolve => setTimeout(resolve, 100));
    fs.writeFileSync(path.join(profile, 'live-connections.png'), (await win.webContents.capturePage()).toPNG());
    // Export the reusable list of connections that were not empty.
    await run(`document.querySelector('#bills-btn-non-empty').click()`);
    await until(async () => (await read('bills-live-status')).includes('non-empty connection'), true);
    const listCsv = fs.readFileSync(merged, 'utf8');
    assert.equal(listCsv.trim().split(/\r?\n/).length, 13);
    assert.match(listCsv, /Connection No/);
    // Verify the user-visible clear-all confirmation after completion.
    dialog.showMessageBox = async () => ({ response: 0 });
    await run(`document.querySelector('#bills-btn-clear-all').click()`);
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(await read('bills-stat-total'), '12');
    dialog.showMessageBox = async () => ({ response: 1 });
    await run(`document.querySelector('#bills-btn-clear-all').click()`);
    await until(() => read('bills-stat-total'), '0');
    await until(async () => (await read('bills-jobs-list')).includes('No past extraction jobs'), true);
    console.log(`PASS Bills recovery UI: 12 wrapper imports, live 10 rows, active clear disabled, completed rows not repeated; ${elapsed} ms (${Math.round(720000 / elapsed)}/min local fixture).`);
    return;
  }
  if (process.argv.includes('--bills-empty')) {
    await run(`bobo.createTab(${JSON.stringify(target)})`);
    await until(() => content()?.getURL(), target);
    await until(() => content()?.isLoading(), false);
    await run(`document.querySelector('[data-tool-open="bills"]').click();
      document.querySelector('#bills-paste-area').value = '001234\\n009999\\n009997\\n001236\\n001235';
      document.querySelector('#bills-import-btn').click();`);
    await until(() => read('bills-stat-total'), '5');
    const started = Date.now();
    await run(`document.querySelector('#bills-delay').value = '0'; document.querySelector('#bills-btn-start').click()`);
    await until(() => read('bills-stat-empty'), '2');
    await until(() => read('bills-stat-done'), '3');
    await until(async () => (await read('bills-live-status')).includes('Extraction complete'), true);
    const elapsed = Date.now() - started;
    assert.deepEqual(await content().executeJavaScript('window.submittedAccounts'), ['001234', '001236', '001235']);
    assert.equal(await read('bills-stat-fail'), '0');
    assert.ok(elapsed < 6000, `empty skips took ${elapsed} ms`);
    console.log(`PASS empty skip: two no-request misses marked EMPTY, slow in-flight request kept, ${elapsed} ms total.`);
    return;
  }
  if (process.argv.includes('--background-bills')) {
    await run(`bobo.createTab(${JSON.stringify(target)})`);
    await until(() => content()?.getURL(), target);
    const billing = content();
    await until(() => billing.executeJavaScript('!!document.querySelector("#account")'), true);
    await run(`
      document.querySelector('[data-tool-open="bills"]').click();
      document.querySelector('#bills-paste-area').value = '001234,001235';
      document.querySelector('#bills-import-btn').click();
    `);
    await until(() => read('bills-stat-pending'), '2');
    await run('document.querySelector("#bills-btn-start").click()');
    await until(() => billing.executeJavaScript('window.submittedAccounts?.length'), 1);
    const other = await run(`bobo.createTab(${JSON.stringify(consumers)})`);
    await until(() => content()?.getURL(), consumers);
    await run(`document.querySelector('[data-tool-open="web-scraper"]').click();
      document.querySelector('[data-scrape="text"]').click()`);
    await until(async () => (await read('scraper-preview')).includes('Show History'), true);
    await until(() => read('bills-stat-done'), '2');
    assert.deepEqual(await billing.executeJavaScript('window.submittedAccounts'), ['001234', '001235']);
    assert.equal((await run('bobo.getState()')).tabs.activeId, other);
    console.log('Bills History completed in its original tab while Web Scraper ran in another tab');
    return;
  }
  const initial = (await run('bobo.getState()')).tabs.activeId;
  await run(`{
    document.querySelector('#bills-paste-area').value = '001234';
    document.querySelector('#bills-import-btn').click();
  }`);
  await until(() => read('bills-stat-total'), '1');
  await until(() => read('bills-stat-pending'), '1');
  await run('document.querySelector("#bills-btn-start").click()');
  await until(async () => (await read('bills-live-status')).includes('Open Water Sanitation Bill History'), true);
  assert.equal(await read('bills-stat-pending'), '1');

  const page = await run(`bobo.createTab(${JSON.stringify(target)})`);
  await until(() => content()?.getURL(), target);
  await until(() => content().executeJavaScript('!!document.querySelector("#account")'), true);
  await until(() => run('!document.querySelector("#bills-btn-start").disabled'), true);
  await run(`document.querySelector('[data-delay="800"]').click()`);
  assert.equal(await run('document.querySelector("#bills-delay").value'), '800');
  await run('document.querySelector("#bills-btn-start").click()');
  await until(() => read('bills-stat-done'), '1');
  assert.match(await read('bills-elapsed'), /^00:00:0[1-9]$/);
  assert.equal(await content().executeJavaScript('document.querySelector("#account").value'), '001234');
  await until(async () => (await read('bills-live-status')).includes('Extraction complete'), true);
  assert.match(await read('bills-speed'), /^\d+\/min$/);
  assert.equal(await read('bills-eta'), '0 min');
  await run('document.querySelector("#bills-btn-export").click()');
  await until(async () => (await read('bills-live-status')).includes('Saved 1 CSVs'), true);
  const [folder] = fs.readdirSync(history);
  assert.match(folder, /^\d{2}-\d{2}-\d{2} receiving amount history$/);
  const csv = path.join(history, folder, 'Sector A', '001234.csv');
  const original = fs.readFileSync(csv, 'utf8');
  assert.match(original, /001234/);
  await run('document.querySelector("#bills-btn-export").click()');
  await until(async () => (await read('bills-live-status')).includes('Existing: 1'), true);
  assert.equal(fs.readFileSync(csv, 'utf8'), original);
  await run('document.querySelector("#bills-btn-merged").click()');
  await until(() => fs.existsSync(merged), true);
  await until(async () => (await read('bills-live-status')).includes('Saved merged CSV'), true);
  assert.match(fs.readFileSync(merged, 'utf8'), /001234/);
  await run('document.querySelector("[data-action=menu-sectors]").click()');
  await until(() => run('!document.querySelector("[data-view=sectors]").hidden'), true);
  await run('document.querySelector("#sectors-btn-refresh").click()');
  await until(() => read('sectors-count-badge'), '2 Sectors');
  await run(`{
    const input = document.querySelector('#sectors-filter-input');
    input.value = 'North';
    input.dispatchEvent(new Event('input'));
  }`);
  await until(() => read('sectors-list'), 'North Area');
  await run('document.querySelector("#sectors-list button").click()');
  await until(() => content().executeJavaScript('document.querySelector("#area").value'), '7');
  await content().executeJavaScript(`document.body.innerHTML = \`
    <mat-table role="table">
      <mat-header-row role="row"><mat-header-cell>Connection No</mat-header-cell><mat-header-cell>Sector</mat-header-cell></mat-header-row>
      <mat-row role="row"><mat-cell>1234</mat-cell><mat-cell>North Area</mat-cell></mat-row>
      <mat-row role="row"><mat-cell>5678</mat-cell><mat-cell>South Area</mat-cell></mat-row>
    </mat-table>
    <div class="mat-mdc-paginator-range-label">1 – 2 of 6</div>
  \``);
  await run(`document.querySelector('[data-tool-open="export"]').click()`);
  await run('document.querySelector("#export-inspect-btn").click()');
  await until(async () => (await read('export-table-subtitle')).includes('Total records: 6 (2 visible)'), true);
  await run('document.querySelector("#export-preview-btn").click()');
  assert.match(await read('export-preview-table-wrap'), /1234North Area/);
  await run('document.querySelector("#export-start-btn").click()');
  await until(() => fs.readFileSync(merged, 'utf8').includes('"5678","South Area"'), true);
  await content().executeJavaScript(`document.body.innerHTML = \`
    <table><thead><tr><th>Locality</th><th>Sector</th><th>Bill Count</th><th>Billing Period</th><th>Url</th></tr></thead><tbody>
      <tr><td>North</td><td>Sector A</td><td>10</td><td>January</td><td><a href="/bill-one.pdf">View</a></td></tr>
      <tr><td>South</td><td>Sector B</td><td>20</td><td>January</td><td><button id="bill-view">View</button></td></tr>
    </tbody></table>
  \`; document.querySelector('#bill-view').addEventListener('click', () => window.open('/view-bill'))`);
  await run(`document.querySelector('[data-tool-open="bill-prints"]').click()`);
  await run('document.querySelector("#prints-scan").click()');
  await until(async () => (await read('prints-summary')).startsWith('0 / 2'), true);
  await run('document.querySelector("#prints-delay").value = 0; document.querySelector("#prints-parallel").value = "2"; document.querySelector("#prints-start").click()');
  await until(async () => (await read('prints-summary')).startsWith('2 / 2'), true);
  assert.equal(pdfsOverlapped, true, 'both PDF requests were in flight at once');
  await until(() => content().executeJavaScript('document.querySelectorAll("[data-bobo-print-saved]").length'), 2);
  assert.equal(await run('document.querySelectorAll("#prints-list input:checked:disabled").length'), 2);
  const printFolder = path.join(history, fs.readdirSync(history).find((entry) => entry.endsWith('Bill Prints Download')));
  assert.equal(fs.readFileSync(path.join(printFolder, 'North.pdf'), 'utf8'), '%PDF-1.7 fixture');
  assert.equal(fs.readFileSync(path.join(printFolder, 'South.pdf'), 'utf8'), '%PDF-1.7 fixture');
  await run('document.querySelector("#prints-csv").click()');
  await until(() => fs.readFileSync(merged, 'utf8').includes('"South","Sector B","","20"'), true);
  if (process.argv.includes('--bill-prints-only')) {
    await run('document.querySelector("#prints-add").click()');
    await until(async () => (await read('prints-status')).includes('already queued'), true);
    await content().executeJavaScript(`document.querySelector('tbody').innerHTML =
      '<tr><td>South</td><td>Sector B</td><td>20</td><td>February</td><td><button>View</button></td></tr>'`);
    await run('document.querySelector("#prints-add").click()');
    await until(async () => (await read('prints-summary')).startsWith('2 / 3'), true);
    console.log('Bill Prints downloaded both PDFs, skipped the same page, and appended a different billing period');
    return;
  }
  await content().executeJavaScript(`document.body.innerHTML = \`
    <main><h1>Scraper fixture</h1><ul><li>First item</li></ul>
    <a href="mailto:info@example.test">Contact</a><a href="tel:+12025550123">Call</a>
    <a href="https://www.linkedin.com/company/example">Profile</a>
    <img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" alt="Fixture">
    <script type="application/ld+json">{"@type":"Product","name":"Fixture product"}</script>
    </main>
  \``);
  await run(`document.querySelector('[data-tool-open="web-scraper"]').click()`);
  for (const [mode, expected] of [
    ['list', 'First item'], ['page', 'Scraper fixture'], ['images', 'Image URL'],
    ['email', 'info@example.test'], ['phone', '+12025550123'], ['social', 'linkedin.com/company/example'],
    ['products', 'Fixture product'], ['text', 'First item'],
  ]) {
    await run(`document.querySelector('[data-scraper-view="menu"]').click();
      document.querySelector('[data-scrape="${mode}"]').click()`);
    await until(async () => (await read('scraper-preview')).includes(expected)
      && await run('!document.querySelector("#scraper-data").hidden'), true);
  }
  await run(`document.querySelector('[data-scraper-view="runs"]').click();
    [...document.querySelectorAll('#scraper-runs button')].find(button => button.textContent.includes('Email Extractor')).click();
    document.querySelector('#scraper-export').click()`);
  await until(() => fs.readFileSync(merged, 'utf8').includes('info@example.test'), true);
  const point = await content().executeJavaScript(`{
    document.querySelector('ul').innerHTML = '<li>Picked one</li><li>Picked two</li>';
    document.querySelector('li').scrollIntoView({ block: 'center' });
    const rect = document.querySelector('li').getBoundingClientRect();
    ({ x: Math.round(rect.left + 8), y: Math.round(rect.top + 8) });
  }`);
  await run(`document.querySelector('[data-scraper-view="menu"]').click();
    document.querySelector('[data-scrape="pick-list"]').click()`);
  await new Promise((resolve) => setTimeout(resolve, 150));
  content().sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
  content().sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
  await until(async () => (await read('scraper-preview')).includes('Picked two'), true);
  await run(`bobo.selectTab(${initial}); bobo.closeTab(${page});`);
  console.log('Billing tools smoke check passed, including direct and View-button Bill Prints downloads');
}).then(() => app.exit(0), (error) => {
  console.error(error);
  app.exit(1);
});
