'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pngDataUrl } = require('./lib');

async function recognizeScreenshot(dataUrl) {
  if (process.platform !== 'win32') throw new Error('Screenshot text recognition requires Windows OCR.');
  const base64 = pngDataUrl(dataUrl).slice('data:image/png;base64,'.length);
  const header = Buffer.from(base64.slice(0, 32), 'base64');
  if (header.length < 24 || header.toString('hex', 0, 8) !== '89504e470d0a1a0a' ||
      header.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Invalid screenshot PNG.');
  if (header.readUInt32BE(16) * header.readUInt32BE(20) > 12000000) {
    throw new Error('Crop a smaller area to extract text.');
  }
  const script = await fs.readFile(path.join(__dirname, 'screenshot-ocr.ps1'), 'utf8');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    const child = execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
        if (error) return reject(new Error('Windows could not read this screenshot.'));
        try {
          const result = JSON.parse(stdout);
          if (result.unavailable) throw new Error('Install an OCR language in Windows Settings to extract text.');
          if (result.tooLarge) throw new Error('Crop a smaller area to extract text.');
          resolve(result.text || '');
        } catch (failure) { reject(failure); }
      });
    child.stdin.on('error', () => {});
    child.stdin.end(base64 + '\n');
  });
}

module.exports = { recognizeScreenshot };
