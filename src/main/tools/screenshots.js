'use strict';

/**
 * Screenshot service.
 *
 * Only ever captures a WebContents that the caller passes in - the main
 * process passes the *active tab*, on an explicit user action. Nothing here
 * schedules a capture, watches the screen, or uploads anything.
 */

const fs = require('node:fs/promises');
const { nativeImage, clipboard, ClipboardItem } = require('electron');
const { pngDataUrl } = require('./lib');

/**
 * @param {import('electron').WebContents|null} webContents
 * @returns {Promise<{ok: true, dataUrl: string, width: number, height: number}|{ok: false, error: string}>}
 */
async function capture(webContents) {
  if (!webContents || webContents.isDestroyed()) {
    return { ok: false, error: 'Open a page in a tab first.' };
  }

  try {
    const image = await webContents.capturePage();
    if (!image || image.isEmpty()) {
      return {
        ok: false,
        error: 'This tab returned an empty capture. Protected or blank pages cannot be captured.',
      };
    }

    const { width, height } = image.getSize();
    return {
      ok: true,
      dataUrl: `data:image/png;base64,${image.toPNG().toString('base64')}`,
      width,
      height,
    };
  } catch (error) {
    return { ok: false, error: `BOBO could not capture this page: ${error.message}` };
  }
}

/**
 * Copy an already-captured PNG to the clipboard.
 *
 * Electron 45's clipboard is the async, W3C-shaped API: `writeImage` no longer
 * exists, so the image is handed over as a PNG ClipboardItem.
 */
async function copy(dataUrl) {
  const image = nativeImage.createFromDataURL(pngDataUrl(dataUrl));
  if (image.isEmpty()) return { ok: false, error: 'That screenshot could not be read.' };

  try {
    await clipboard.write([
      new ClipboardItem({
        'image/png': new Blob([image.toPNG()], { type: 'image/png' }),
      }),
    ]);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `BOBO could not copy the screenshot: ${error.message}` };
  }
}

/** Write an already-captured PNG to a file path chosen by the user. */
async function save(dataUrl, file) {
  const base64 = pngDataUrl(dataUrl).slice('data:image/png;base64,'.length);

  try {
    await fs.writeFile(file, Buffer.from(base64, 'base64'));
    return { ok: true, path: file };
  } catch (error) {
    return { ok: false, error: `BOBO could not save the screenshot: ${error.message}` };
  }
}

module.exports = { capture, copy, save };
