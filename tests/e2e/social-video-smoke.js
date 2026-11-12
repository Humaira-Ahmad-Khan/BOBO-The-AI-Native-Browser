'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, dialog, session } = require('electron');

const root = path.join(__dirname, '.tmp');
fs.mkdirSync(root, { recursive: true });
const profile = fs.mkdtempSync(path.join(root, 'video-'));
const destination = path.join(profile, 'videos');
fs.mkdirSync(destination);
for (const key of ['userData', 'sessionData', 'crashDumps']) app.setPath(key, profile);
app.setAppLogsPath(profile);
app.commandLine.appendSwitch('disable-background-networking');
app.disableHardwareAcceleration();
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [destination] });
dialog.showMessageBox = async () => ({ response: 1 });

const url = 'https://video.test/fixture.mp4';
const playerPage = 'https://www.instagram.com/player';
const found = 'https://www.instagram.com/detected.mp4';
const overlayVideo = 'https://www.instagram.com/overlay.mp4?signature=fixture-secret';
const media = '0000ftypfixture';
global.fetch = async (source, options) => {
  assert.ok([url, found, overlayVideo].includes(source));
  assert.equal(options.credentials, 'omit');
  return new Response(options.method === 'HEAD' ? null : media, {
    headers: { 'content-type': 'video/mp4', 'content-length': String(media.length) },
  });
};
app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] },
    ({ url: requested }, done) => done({ cancel: requested !== playerPage }));
  session.defaultSession.protocol.handle('https', () => new Response(
    '<video preload="none"><source src="/detected.mp4"></video><video preload="none" src="/playlist.m3u8"></video>',
    { headers: { 'Content-Type': 'text/html' } }
  ));
});

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
  await until(() => run(`!!document.querySelector('[data-tool-open="social-video"]')`), true);
  await run(`
    document.querySelector('[data-tool-open="social-video"]').click();
    document.querySelector('#social-video-urls').value = ${JSON.stringify(url)};
  `);
  await run('document.querySelector("#social-video-start").click()');
  await until(() => run('document.querySelector("#social-video-queue").textContent.includes("Completed")'), true);
  assert.equal(fs.readFileSync(path.join(destination, 'fixture.mp4'), 'utf8'), media);
  const downloads = await run('bobo.listDownloads()');
  assert.equal(downloads.find((item) => item.filename === 'fixture.mp4').state, 'completed');
  await run(`document.querySelector('#social-video-urls').value = 'https://www.youtube.com/watch?v=example';
    document.querySelector('#social-video-start').click()`);
  await until(() => run('document.querySelector("#social-video-queue").textContent.includes("YouTube watch links are playback pages")'), true);
  await run(`bobo.addSocialVideos(['https://video.test/leave-pending.mp4'])`);
  await run(`bobo.createTab(${JSON.stringify(playerPage)})`);
  const page = () => win.contentView.children.find((view) => view.webContents !== win.webContents)?.webContents;
  await until(() => page()?.getURL(), playerPage);
  await until(() => page().executeJavaScript('!!document.querySelector("video source")'), true);
  await run('document.querySelector("#social-video-find").click()');
  await until(() => run('document.querySelector("#social-video-found").textContent'), 'Download detected.mp4');
  await run('document.querySelector("#social-video-found button").click()');
  await until(() => fs.existsSync(path.join(destination, 'detected.mp4')), true);
  const queue = await run('bobo.socialVideoQueue()');
  assert.equal(queue.tasks.find((task) => task.source.endsWith('leave-pending.mp4')).status, 'Pending');
  const player = page();
  await until(() => run('!document.querySelector("#social-video-buttons").disabled'), true);
  await run('document.querySelector("#social-video-buttons").click()');
  await player.executeJavaScript(`(() => {
    const video = document.querySelector('video');
    video.src = ${JSON.stringify(overlayVideo)};
    video.style.width = '350px';
    video.style.height = '220px';
    const stream = document.querySelectorAll('video')[1];
    stream.style.width = '250px';
    stream.style.height = '180px';
  })()`);
  player.focus();
  await until(() => player.executeJavaScript('[...document.querySelectorAll("button")].some(b => b.textContent === "Download video" && !b.disabled)'), true);
  await until(() => player.executeJavaScript('[...document.querySelectorAll("button")].some(b => b.textContent === "Download unavailable" && b.disabled)'), true);
  const point = await player.executeJavaScript(`(() => {
    const button = [...document.querySelectorAll('button')].find((node) => node.textContent === 'Download video');
    const rect = button.getBoundingClientRect();
    return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
  })()`);
  player.sendInputEvent({ ...point, type: 'mouseDown', button: 'left', clickCount: 1 });
  player.sendInputEvent({ ...point, type: 'mouseUp', button: 'left', clickCount: 1 });
  await until(() => fs.existsSync(path.join(destination, 'overlay.mp4')), true);
  assert.equal(fs.readFileSync(path.join(destination, 'overlay.mp4'), 'utf8'), media);
  assert.ok(!JSON.stringify(await run('bobo.socialVideoQueue()')).includes('fixture-secret'));
  await run('document.querySelector("#social-video-buttons").click()');
  await until(() => player.executeJavaScript('![...document.querySelectorAll("button")].some(b => b.textContent.startsWith("Download "))'), true);
  console.log('Social Video Downloader smoke check passed');
}).then(() => app.exit(0), (error) => {
  console.error(error);
  app.exit(1);
});
