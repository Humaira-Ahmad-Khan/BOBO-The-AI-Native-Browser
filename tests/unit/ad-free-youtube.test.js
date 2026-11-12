'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { alternateWatchUrl } = require('../../src/main/tools/ad-free-youtube');

test('alternate playback forwards only a validated video ID from a YouTube watch URL', () => {
  const expected = 'https://www.yout-ube.com/watch?v=soTfFFIQQ8U';
  assert.equal(alternateWatchUrl('www.youtube.com/watch?v=soTfFFIQQ8U&token=secret#private'), expected);
  assert.equal(alternateWatchUrl('https://m.youtube.com/watch?v=soTfFFIQQ8U'), expected);
  for (const url of [
    'https://www.youtube.com.example/watch?v=soTfFFIQQ8U',
    'https://user:secret@youtube.com/watch?v=soTfFFIQQ8U',
    'https://www.yout-ube.com/watch?v=soTfFFIQQ8U',
    'https://www.youtube.com/watch?v=invalid',
    'https://www.youtube.com/results?search_query=video',
  ]) assert.equal(alternateWatchUrl(url), null);
});
