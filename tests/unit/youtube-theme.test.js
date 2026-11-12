'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isYouTube, applyYouTubeTheme } = require('../../src/main/youtube-theme');
test('YouTube appearance is confined to exact HTTPS origins without credentials', async () => {
  for (const url of ['https://www.youtube.com/watch?v=aaaaaaaaaaa', 'https://youtube.com/', 'https://m.youtube.com/shorts/aaaaaaaaaaa']) {
    assert.equal(isYouTube(url), true);
  }
  for (const url of ['https://youtube.com.evil.test/', 'http://youtube.com/', 'https://user:secret@youtube.com/',
    'https://www.youtube.com:8443/', 'https://evil.youtube.com/', 'file:///youtube.com', 'bad']) {
    assert.equal(isYouTube(url), false);
  }
  let injected = false;
  assert.equal(await applyYouTubeTheme({ isDestroyed: () => false, getURL: () => 'https://example.test/',
    executeJavaScriptInIsolatedWorld: () => { injected = true; } }, 'dark'), false);
  assert.equal(injected, false);
});
