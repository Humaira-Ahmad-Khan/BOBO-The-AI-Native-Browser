'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { DownloadsService } = require('../../src/main/downloads');
const { Store } = require('../../src/main/db');
const { SocialVideoQueue, classifyVideo } = require('../../src/main/tools/social-video');

test('classifies social links and rejects unsafe URL schemes and credentials', () => {
  assert.equal(classifyVideo('https://youtu.be/example').platform, 'YouTube');
  assert.equal(classifyVideo('https://youtube.com.example.test/watch').platform, 'Direct media');
  assert.equal(classifyVideo('https://files.example.test/demo.webm').direct, true);
  assert.throws(() => classifyVideo('file:///test.mp4'), /HTTPS/);
  assert.throws(() => classifyVideo('https://user:secret@example.test/demo.mp4'), /credentials/);
});

test('analyses and downloads a batch, validates bytes and restores queue state', async (t) => {
  const root = path.join(__dirname, '..', '.tmp');
  await fs.mkdir(root, { recursive: true });
  const folder = await fs.mkdtemp(path.join(root, 'social-video-'));
  const store = new Store({ file: path.join(folder, 'test.db') });
  t.after(async () => {
    store.close();
    await fs.rm(folder, { recursive: true, force: true });
  });
  const downloads = new DownloadsService({ store });
  const file = path.join(folder, 'queue.json');
  const valid = Buffer.from('0000ftypfixture');
  const options = {
    file, downloads,
    fetchMedia: async (url, request) => {
      assert.equal(request.credentials, 'omit');
      assert.equal(request.redirect, 'manual');
      const body = url.endsWith('/good.mp4') ? valid : Buffer.from('<html>Login</html>');
      return new Response(request.method === 'HEAD' ? null : body, {
        headers: { 'content-type': 'video/mp4', 'content-length': String(body.length) },
      });
    },
  };
  const queue = new SocialVideoQueue(options);
  await queue.setFolder(folder);
  const good = 'https://example.test/good.mp4';
  const { tasks } = await queue.add([good, good, 'https://example.test/bad.mp4', 'https://youtu.be/example']);
  assert.equal(tasks.length, 3);
  assert.equal(tasks[2].status, 'Unsupported');
  const preview = await queue.analyse(tasks[0].id);
  assert.equal(preview.tasks[0].format, 'mp4');
  assert.equal(preview.tasks[0].total, valid.length);
  const result = await queue.start();
  assert.deepEqual(result.tasks.map((task) => task.status), ['Completed', 'Failed', 'Unsupported']);
  assert.deepEqual(await fs.readFile(result.tasks[0].path), valid);
  assert.equal(downloads.get(result.tasks[0].downloadId).state, 'completed');
  assert.equal(downloads.get(result.tasks[1].downloadId).state, 'interrupted');
  assert.equal((await fs.readdir(folder)).some((name) => name.endsWith('.part')), false);
  const restarted = await new SocialVideoQueue(options).snapshot();
  assert.equal(restarted.tasks[0].path, result.tasks[0].path);
  assert.equal(restarted.folder, folder);
});

test('cancels an active transfer and keeps the next item pending', async (t) => {
  const root = path.join(__dirname, '..', '.tmp');
  await fs.mkdir(root, { recursive: true });
  const folder = await fs.mkdtemp(path.join(root, 'social-video-cancel-'));
  const store = new Store({ file: path.join(folder, 'test.db') });
  t.after(async () => {
    store.close();
    await fs.rm(folder, { recursive: true, force: true });
  });
  const downloads = new DownloadsService({ store });
  let markProgress;
  const progressed = new Promise((resolve) => { markProgress = resolve; });
  const queue = new SocialVideoQueue({
    file: path.join(folder, 'queue.json'), downloads,
    changed: () => {
      if (downloads.list().some((item) => item.received > 0)) markProgress();
    },
    fetchMedia: async (_url, { signal }) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from('0000ftypfixture'));
        signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      },
    }), { headers: { 'content-type': 'video/mp4' } }),
  });
  await queue.setFolder(folder);
  await queue.add(['https://example.test/one.mp4', 'https://example.test/two.mp4']);
  const active = queue.start();
  await progressed;
  assert.equal(downloads.list()[0].canPause, false);
  queue.stop();
  const result = await active;
  assert.deepEqual(result.tasks.map((task) => task.status), ['Cancelled', 'Pending']);
  assert.equal(downloads.list()[0].state, 'cancelled');
  assert.equal((await fs.readdir(folder)).some((name) => /\.part$|\.mp4$/.test(name)), false);
});
