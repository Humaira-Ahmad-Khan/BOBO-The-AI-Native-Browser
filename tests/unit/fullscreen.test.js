'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fullscreenPermission } = require('../../src/main/security');

test('fullscreen requires an active top-level webpage with a matching origin', () => {
  const contents = { isDestroyed: () => false, getURL: () => 'https://video.test/watch' };
  const details = { isMainFrame: true, requestingUrl: 'https://video.test/watch' };
  assert.equal(fullscreenPermission(contents, 'fullscreen', details, () => true), true);
  assert.equal(fullscreenPermission(contents, 'fullscreen', details, () => false), false);
  assert.equal(fullscreenPermission(contents, 'fullscreen', { ...details, isMainFrame: false }, () => true), false);
  assert.equal(fullscreenPermission(contents, 'fullscreen', { ...details, requestingUrl: 'https://other.test/' }, () => true), false);
  assert.equal(fullscreenPermission(contents, 'fullscreen', {}, () => true), false);
  for (const permission of ['automatic-fullscreen', 'media', 'geolocation', 'clipboard-read', 'notifications']) {
    assert.equal(fullscreenPermission(contents, permission, details, () => true), false);
  }
});
