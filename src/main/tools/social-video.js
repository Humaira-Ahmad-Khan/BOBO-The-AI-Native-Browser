'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { JsonFile, safeFileName } = require('./lib');

const formats = new Map([
  ['video/mp4', { extension: 'mp4', matches: (bytes) => bytes.toString('ascii', 4, 8) === 'ftyp' }],
  ['video/webm', { extension: 'webm', matches: (bytes) => bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) }],
  ['video/ogg', { extension: 'ogv', matches: (bytes) => bytes.toString('ascii', 0, 4) === 'OggS' }],
]);
const platforms = [
  ['YouTube', ['youtube.com', 'youtu.be']],
  ['Instagram', ['instagram.com']],
  ['Facebook', ['facebook.com', 'fb.watch']],
  ['LinkedIn', ['linkedin.com']],
  ['TikTok', ['tiktok.com']],
  ['X / Twitter', ['x.com', 'twitter.com']],
  ['Reddit', ['reddit.com', 'redd.it']],
];

function pageLinkMessage(platform) {
  return platform === 'YouTube'
    ? 'YouTube watch links are playback pages. Use YouTube’s Download control if offered, or provide an authorised direct video file link.'
    : `${platform} page links need a direct MP4, WebM or Ogg video file URL.`;
}

function classifyVideo(value) {
  let url;
  try { url = new URL(String(value ?? '').trim()); } catch { throw new Error('Enter a valid video URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.href.length > 4096) {
    throw new Error('Use an HTTPS link without embedded credentials.');
  }
  url.hash = '';
  const platform = platforms.find(([, hosts]) => hosts.some((host) =>
    url.hostname === host || url.hostname.endsWith(`.${host}`)))?.[0] || 'Direct media';
  const direct = /\.(mp4|webm|ogv|ogg)$/i.test(url.pathname);
  return { url: url.href, platform, direct, query: Boolean(url.search) };
}

function directVideoSource(value) {
  try {
    const item = classifyVideo(value);
    return item.direct && !item.query ? item.url : null;
  } catch { return null; }
}

function playerVideoSource(value) {
  try {
    const item = classifyVideo(value);
    return item.direct ? item.url : null;
  } catch { return null; }
}

async function findPageVideos(contents) {
  if (!contents || contents.isDestroyed() || !/^https?:\/\//i.test(contents.getURL())) {
    throw new Error('Open a webpage with a video first.');
  }
  const urls = await contents.executeJavaScript(`(() => {
    if (!/^https?:$/.test(location.protocol)) return [];
    const urls = [];
    for (const video of document.querySelectorAll('video')) {
      if (video.mediaKeys) continue;
      urls.push(video.currentSrc, video.src);
      for (const source of video.querySelectorAll('source[src]')) urls.push(source.src);
    }
    return urls.slice(0, 100);
  })()`);
  const candidates = new Map();
  for (const value of urls) {
    try {
      const item = classifyVideo(value);
      if (item.direct && !item.query) {
        candidates.set(item.url, { url: item.url, name: path.posix.basename(new URL(item.url).pathname) });
      }
    } catch {}
  }
  return [...candidates.values()];
}

class SocialVideoQueue {
  #file;
  #state;
  #downloads;
  #changed;
  #fetch;
  #controller;
  #batch = false;
  #stopped = false;

  constructor({ file, downloads, changed, fetchMedia = fetch }) {
    this.#file = new JsonFile(file, { folder: '', tasks: [] });
    this.#downloads = downloads;
    this.#changed = changed;
    this.#fetch = fetchMedia;
    this.#state = this.#file.read().then(async (state) => {
      const tasks = Array.isArray(state.tasks) ? state.tasks : [];
      for (const task of tasks) {
        if (task.status === 'Unsupported' && /\/watch$/.test(task.source) && task.platform === 'YouTube') {
          task.error = pageLinkMessage(task.platform);
        }
        if (task.status === 'Downloading' || task.status === 'Analysing') {
          task.status = 'Failed';
          task.error = 'BOBO closed before the task finished. Retry to start again.';
          if (task.partialPath && path.basename(task.partialPath) === `.bobo-video-${task.id}.part`) {
            await fs.unlink(task.partialPath).catch(() => {});
          }
          delete task.partialPath;
        }
      }
      return { folder: typeof state.folder === 'string' ? state.folder : '', tasks };
    });
  }

  async snapshot() {
    const state = await this.#state;
    return { ...state, running: this.#batch };
  }

  async add(values) {
    if (!Array.isArray(values) || values.length > 200) throw new Error('Import up to 200 URLs at a time.');
    const inputs = values.map(classifyVideo);
    const state = await this.#state;
    const known = new Map(state.tasks.map((task) => [task.source, task]));
    for (const input of inputs) {
      const unsupported = !input.direct || input.query;
      const error = !input.direct ? pageLinkMessage(input.platform)
        : input.query ? 'Use a public direct file URL without a query string.' : '';
      const source = input.query ? input.url.split('?')[0] : input.url;
      const existing = known.get(source);
      if (existing) {
        if (!unsupported && existing.status === 'Unsupported') Object.assign(existing, { status: 'Pending', error: '' });
        continue;
      }
      if (state.tasks.length >= 500) break;
      const task = { id: randomUUID(), source, platform: input.platform, status: unsupported ? 'Unsupported' : 'Pending', error, createdAt: Date.now() };
      known.set(source, task);
      state.tasks.push(task);
    }
    await this.#file.write(state);
    return this.snapshot();
  }

  async setFolder(folder) {
    if (this.#batch) throw new Error('Cancel the batch before changing folders.');
    const state = await this.#state;
    state.folder = folder;
    await this.#file.write(state);
  }

  async remove(id) {
    const state = await this.#state;
    state.tasks = state.tasks.filter((task) => ['Downloading', 'Analysing'].includes(task.status)
      || (id === 'completed' ? task.status !== 'Completed' : task.id !== id));
    await this.#file.write(state);
    return this.snapshot();
  }

  async #request(source, options) {
    const response = await this.#fetch(source, { ...options, credentials: 'omit', redirect: 'manual' });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (response.status >= 300 && response.status < 400) throw new Error('The server redirected the request. Use the public direct file URL.');
      if ([401, 403].includes(response.status)) throw new Error('The file requires login or download permission.');
      if ([404, 410].includes(response.status)) throw new Error('The video file is unavailable.');
      throw new Error(`The server returned HTTP ${response.status}.`);
    }
    const format = formats.get(response.headers.get('content-type')?.split(';')[0].trim().toLowerCase());
    if (!format) {
      await response.body?.cancel().catch(() => {});
      throw new Error('The server did not provide a supported video format.');
    }
    return { response, format };
  }

  async analyse(id) {
    const state = await this.#state;
    const task = state.tasks.find((entry) => entry.id === id);
    if (!task || !['Pending', 'Failed', 'Cancelled'].includes(task.status)) return this.snapshot();
    task.status = 'Analysing';
    task.error = '';
    try {
      const { response, format } = await this.#request(task.source, { method: 'HEAD', signal: AbortSignal.timeout(15000) });
      task.format = format.extension;
      task.total = Number(response.headers.get('content-length')) || 0;
      task.status = 'Pending';
    } catch (error) {
      task.status = 'Failed';
      task.error = error.message;
    }
    await this.#file.write(state);
    return this.snapshot();
  }

  stop() {
    this.#stopped = true;
    this.#controller?.abort();
  }

  async start(retry = false, onlyId, playerSource) {
    if (this.#batch || this.#controller) throw new Error('A batch is already running.');
    this.#batch = true;
    this.#stopped = false;
    try {
      const state = await this.#state;
      if (!state.folder) throw new Error('Choose a download folder first.');
      const queue = state.tasks.filter((task) => (!onlyId || task.id === onlyId) &&
        (task.status === 'Pending' || (retry && ['Failed', 'Cancelled'].includes(task.status))));
      if (!queue.length) throw new Error('No supported videos are ready to download.');
      for (const task of queue) {
        if (this.#stopped) break;
        if (!state.tasks.includes(task) || task.status === 'Analysing') continue;
        await this.#transfer(state, task, playerSource);
      }
    } finally {
      this.#batch = false;
    }
    return this.snapshot();
  }

  async #transfer(state, task, playerSource = task.source) {
    const controller = new AbortController();
    this.#controller = controller;
    let record;
    let handle;
    let received = 0;
    let temporary;
    let ownsTemporary = false;
    task.status = 'Downloading';
    task.error = '';
    task.received = 0;
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30 * 60 * 1000)]);
      const { response, format } = await this.#request(playerSource, { signal });
      if (!response.body) throw new Error('The server returned an empty download.');
      const base = safeFileName(path.posix.basename(new URL(task.source).pathname).replace(/\.[^.]+$/, ''), 'video');
      const name = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(base) ? `_${base}` : base;
      task.format = format.extension;
      task.filename = `${name}.${format.extension}`;
      task.total = Number(response.headers.get('content-length')) || 0;
      const folder = state.folder;
      temporary = path.join(folder, `.bobo-video-${task.id}.part`);
      task.partialPath = temporary;
      record = this.#downloads.start({ url: task.source, filename: task.filename, totalBytes: task.total });
      task.downloadId = record.id;
      this.#downloads.bind(record.id, { cancel: () => controller.abort() });
      await this.#file.write(state);
      this.#changed?.();
      handle = await fs.open(temporary, 'wx');
      ownsTemporary = true;
      let header = Buffer.alloc(0);
      let verified = false;
      let lastUpdate = 0;
      for await (const chunk of response.body) {
        signal.throwIfAborted();
        let bytes = Buffer.from(chunk);
        if (!verified) {
          header = Buffer.concat([header, bytes]);
          if (header.length < 8) continue;
          if (!format.matches(header)) throw new Error('The file contents do not match the advertised video format.');
          verified = true;
          bytes = header;
          header = null;
        }
        await handle.writeFile(bytes);
        received += bytes.length;
        task.received = received;
        if (Date.now() - lastUpdate >= 250) {
          lastUpdate = Date.now();
          this.#downloads.updateLive(record.id, { received });
          this.#changed?.();
        }
      }
      signal.throwIfAborted();
      if (!verified || (task.total && received !== task.total)) throw new Error('The video download was incomplete.');
      await handle.close();
      handle = null;
      for (let suffix = 1; ; suffix++) {
        const filename = `${name}${suffix > 1 ? ` (${suffix})` : ''}.${format.extension}`;
        const destination = path.join(folder, filename);
        try { await fs.link(temporary, destination); } catch (error) {
          if (error.code === 'EEXIST') continue;
          throw error;
        }
        task.filename = filename;
        task.path = destination;
        break;
      }
      task.status = 'Completed';
      task.completedAt = Date.now();
      this.#downloads.finish(record.id, { state: 'completed', path: task.path, received, filename: task.filename });
    } catch (error) {
      task.status = controller.signal.aborted ? 'Cancelled' : 'Failed';
      task.error = error.code === 'ENOSPC' ? 'The download folder is out of disk space.'
        : playerSource !== task.source ? 'Could not save the player file. Try again from the video.' : error.message;
      if (record) this.#downloads.finish(record.id, { state: task.status === 'Cancelled' ? 'cancelled' : 'interrupted', received, error: task.error });
    } finally {
      controller.abort();
      await handle?.close().catch(() => {});
      if (ownsTemporary) await fs.unlink(temporary).catch(() => {});
      delete task.partialPath;
      this.#controller = null;
      await this.#file.write(state);
      this.#changed?.();
    }
  }
}

module.exports = { SocialVideoQueue, classifyVideo, directVideoSource, findPageVideos, playerVideoSource };
