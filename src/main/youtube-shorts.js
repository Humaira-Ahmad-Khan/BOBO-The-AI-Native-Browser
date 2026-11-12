'use strict';

const { isYouTube } = require('./youtube-theme');
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{11}$/.test(value);
function shortsId(value) {
  try { return isYouTube(value) ? new URL(value).pathname.match(/^\/shorts\/([A-Za-z0-9_-]{11})\/?$/)?.[1] || null : null; }
  catch { return null; }
}
function channelPath(value) {
  try {
    if (!isYouTube(value)) return null;
    const base = new URL(value).pathname.match(/^(\/@[^/]+|\/(?:channel|c|user)\/[^/]+)(?:\/(?:shorts|featured|videos))?\/?$/)?.[1];
    return base ? base + '/shorts' : null;
  } catch { return null; }
}

// Public video IDs only, owned by one tab. Survives document/canonical-host changes
// without relying on YouTube's storage or copying state into other tabs.
function createYouTubeShorts({ ipcMain, ownerFor, now = Date.now }) {
  const queues = new WeakMap();
  ipcMain.on('bobo:youtube:channel-shorts', (event, value) => {
    let response = null;
    try {
      const contents = event.sender, frame = event.senderFrame;
      if (['capture', 'get'].includes(value?.op) && frame === contents.mainFrame && ownerFor(contents) && isYouTube(frame?.url)) {
        const current = channelPath(frame.url);
        if (value?.op === 'capture' && current && Array.isArray(value.ids) && value.ids.length > 0 &&
            value.ids.length <= 500 && [...value.ids].every(validId) && new Set(value.ids).size === value.ids.length &&
            validId(value.selected) && value.ids.includes(value.selected)) {
          queues.set(contents, { channel: new URL(current, frame.url).href, ids: [...value.ids], at: now() });
        }
        const queue = queues.get(contents);
        if (queue && now() - queue.at <= 6 * 60 * 60 * 1000 &&
            (current === channelPath(queue.channel) || queue.ids.includes(shortsId(frame.url)))) {
          response = { channel: queue.channel, ids: [...queue.ids] };
        }
      }
    } catch { response = null; }
    event.returnValue = response;
  });
  return {
    navigated(contents, url) {
      const queue = queues.get(contents);
      if (!queue) return;
      if (!isYouTube(url) || (!shortsId(url) && channelPath(url) !== channelPath(queue.channel))) queues.delete(contents);
    },
  };
}

module.exports = { createYouTubeShorts, shortsId, channelPath };
