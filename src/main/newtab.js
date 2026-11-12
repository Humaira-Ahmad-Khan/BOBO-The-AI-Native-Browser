'use strict';

/**
 * Native, user-initiated file selection for the New Tab page.
 *
 * The renderer never receives a local path and never reads a file itself:
 * this module opens the OS picker, validates every returned path, and hands
 * back display metadata plus (for images) a small thumbnail data URL.
 *
 * An image may be sent to Google Lens after a separate native confirmation.
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { dialog, nativeImage } = require('electron');

const MAX_ATTACHMENTS = 8;
const MAX_THUMBNAIL_SOURCE = 24 * 1024 * 1024; // decode limit
const MAX_RAW_PREVIEW = 3 * 1024 * 1024; // for formats nativeImage cannot decode
const MAX_NAME = 180;

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
const FILE_EXTENSIONS = ['.pdf', '.txt', '.csv', '.docx'];

const IMAGE_EXT_SET = new Set(IMAGE_EXTENSIONS);
const FILE_EXT_SET = new Set(FILE_EXTENSIONS);

// The renderer only ever asks for one of these two kinds.
const KIND_IMAGE = 'images';
const KIND_FILE = 'files';

const PICKERS = {
  [KIND_IMAGE]: {
    title: 'Add images',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
      { name: 'All files', extensions: ['*'] },
    ],
    extensions: IMAGE_EXT_SET,
    kind: 'image',
  },
  [KIND_FILE]: {
    title: 'Add files',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Supported files', extensions: ['pdf', 'txt', 'csv', 'docx'] },
      { name: 'All files', extensions: ['*'] },
    ],
    extensions: FILE_EXT_SET,
    kind: 'file',
  },
};

function cleanName(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .slice(0, MAX_NAME);
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 0;
  return Math.round(bytes);
}

/**
 * Produce a data URL safe to show in an <img>. NativeImage gives us a decoded
 * thumbnail for PNG/JPEG; WebP/GIF fall back to a size-capped data URL.
 * Anything that fails validation simply has no preview (never a broken icon
 * pretending to be the user's file).
 */
async function imagePreview(filePath, extension, size) {
  if (size > MAX_THUMBNAIL_SOURCE) return null;
  try {
    const buffer = await fs.readFile(filePath);
    const image = nativeImage.createFromBuffer(buffer);
    if (!image.isEmpty()) {
      const { width } = image.getSize();
      const thumb = width > 160 ? image.resize({ width: 160, quality: 'good' }) : image;
      return thumb.toDataURL();
    }

    // nativeImage does not decode WebP/GIF on every platform; the renderer's
    // Chromium can. Only small files get this path, and only after the dialog.
    if (size <= MAX_RAW_PREVIEW && (extension === '.webp' || extension === '.gif')) {
      const mime = extension === '.webp' ? 'image/webp' : 'image/gif';
      return `data:${mime};base64,${buffer.toString('base64')}`;
    }
  } catch {
    // A file that vanished or cannot be read gets metadata without a preview.
  }
  return null;
}

async function describeFile(filePath, kind) {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;

  const extension = path.extname(filePath).toLowerCase();
  const allowed = kind === 'image' ? IMAGE_EXT_SET : FILE_EXT_SET;
  if (!allowed.has(extension)) return null;

  const item = {
    name: cleanName(path.basename(filePath)),
    size: formatSize(stat.size),
    type: extension.slice(1).toUpperCase(),
    kind,
    preview: null,
  };

  if (kind === 'image') {
    item.preview = await imagePreview(filePath, extension, stat.size);
  }
  return { item, stat };
}

/**
 * @param {{ getWindow?: () => Electron.BrowserWindow|null }} options
 */
function createNewTabService({ getWindow } = {}) {
  const pickedImages = new WeakMap();
  const searching = new WeakSet();

  async function pickAttachments(kind, sender) {
    const picker = PICKERS[kind];
    if (!picker) throw new Error('BOBO: unknown attachment type');

    const parent = typeof getWindow === 'function' ? getWindow() : null;
    const result = parent && !parent.isDestroyed()
      ? await dialog.showOpenDialog(parent, {
          title: picker.title,
          buttonLabel: 'Add',
          properties: picker.properties,
          filters: picker.filters,
        })
      : await dialog.showOpenDialog({
          title: picker.title,
          buttonLabel: 'Add',
          properties: picker.properties,
          filters: picker.filters,
        });

    if (result.canceled || !Array.isArray(result.filePaths) || result.filePaths.length === 0) {
      return { canceled: true, items: [], truncated: false };
    }

    const selected = result.filePaths.slice(0, MAX_ATTACHMENTS);
    const items = [];
    for (const filePath of selected) {
      if (typeof filePath !== 'string' || !filePath) continue;
      const described = await describeFile(filePath, picker.kind);
      if (!described) continue;
      const { item, stat } = described;
      if (sender && item.kind === 'image' && item.preview && item.size <= MAX_THUMBNAIL_SOURCE) {
        let picks = pickedImages.get(sender);
        if (!picks) pickedImages.set(sender, picks = new Map());
        if (picks.size >= 32) picks.delete(picks.keys().next().value);
        item.imageId = randomUUID();
        picks.set(item.imageId, { filePath, name: item.name, stat });
      }
      items.push(item);
    }

    return {
      canceled: false,
      items,
      truncated: result.filePaths.length > MAX_ATTACHMENTS,
      rejected: selected.length - items.length,
    };
  }

  async function searchImage(sender, imageId, stillAllowed) {
    const picked = pickedImages.get(sender)?.get(imageId);
    if (!picked) throw new Error('Choose the image again before searching.');
    if (searching.has(sender)) throw new Error('An image search is already in progress.');
    searching.add(sender);
    try {
      const file = await fs.open(picked.filePath, 'r');
      let image;
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size !== picked.stat.size || stat.mtimeMs !== picked.stat.mtimeMs ||
          stat.ino !== picked.stat.ino || stat.dev !== picked.stat.dev || stat.size > MAX_THUMBNAIL_SOURCE) {
          throw new Error('The selected image changed. Choose it again.');
        }
        const bytes = Buffer.alloc(stat.size);
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        if (bytesRead !== bytes.length) throw new Error('Could not read the selected image.');
        image = nativeImage.createFromBuffer(bytes);
      } finally {
        await file.close();
      }
      if (image.isEmpty()) throw new Error('Choose a PNG or JPEG image that BOBO can decode.');
      const { width, height } = image.getSize();
      if (Math.max(width, height) > 2048) {
        image = image.resize(width >= height ? { width: 2048 } : { height: 2048 });
      }
      const png = image.toPNG();
      const parent = getWindow?.();
      const options = {
        type: 'question',
        title: 'Search with Google Lens',
        message: `Send “${picked.name}” to Google Lens?`,
        detail: 'BOBO will send a PNG copy of this image to Google for visual search. Other attachments and local file paths stay on this PC.',
        buttons: ['Cancel', 'Send to Google'],
        defaultId: 0,
        cancelId: 0,
      };
      const result = parent && !parent.isDestroyed()
        ? await dialog.showMessageBox(parent, options)
        : await dialog.showMessageBox(options);
      if (result.response !== 1 || !stillAllowed()) return { canceled: true };

      const form = new FormData();
      form.append('encoded_image', new Blob([png], { type: 'image/png' }), 'image.png');
      const endpoint = 'https://lens.google.com/v3/upload';
      const response = await fetch(endpoint, {
        method: 'POST', body: form, credentials: 'omit', redirect: 'manual', signal: AbortSignal.timeout(30000),
      });
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => {});
      if (!location || ![301, 302, 303].includes(response.status)) {
        throw new Error('Google Lens did not return a search results link.');
      }
      const url = new URL(location, endpoint);
      if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        !['lens.google.com', 'www.google.com'].includes(url.hostname) || url.pathname !== '/search') {
        throw new Error('Google Lens returned an unexpected results link.');
      }
      return { url: url.href };
    } finally {
      searching.delete(sender);
    }
  }

  return { pickAttachments, searchImage };
}

module.exports = {
  FILE_EXTENSIONS,
  IMAGE_EXTENSIONS,
  MAX_ATTACHMENTS,
  createNewTabService,
};
