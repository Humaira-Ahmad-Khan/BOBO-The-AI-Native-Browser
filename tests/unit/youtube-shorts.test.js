'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createYouTubeShorts, channelPath, shortsId } = require('../../src/main/youtube-shorts');
test('channel Home, Videos and Shorts share a channel identity; other origins are denied', () => {
  for (const suffix of ['', '/', '/videos', '/featured', '/shorts']) assert.equal(channelPath('https://www.youtube.com/@fixture' + suffix), '/@fixture/shorts');
  assert.equal(channelPath('https://youtube.com/channel/UCfixture/shorts'), '/channel/UCfixture/shorts');
  for (const url of ['https://youtube.com.evil.test/@fixture', 'http://youtube.com/@fixture', 'https://user:secret@youtube.com/@fixture', 'https://youtube.com/results']) assert.equal(channelPath(url), null);
  assert.equal(shortsId('https://m.youtube.com/shorts/aaaaaaaaaaa'), 'aaaaaaaaaaa');
});
test('queues are tab-bound, validated, expire and survive only approved YouTube navigation', () => {
  let handle, clock = 1000, known = true;
  const service = createYouTubeShorts({ ipcMain: { on: (_name, callback) => { handle = callback; } }, ownerFor: () => known, now: () => clock });
  const contents = { mainFrame: { url: 'https://www.youtube.com/@fixture' } };
  const call = (value, frame = contents.mainFrame, sender = contents) => {
    const event = { sender, senderFrame: frame }; handle(event, value); return event.returnValue;
  };
  const ids = ['aaaaaaaaaaa', 'bbbbbbbbbbb'];
  assert.equal(call({ op: 'capture', ids: ['invalid'], selected: 'invalid' }), null);
  assert.equal(call({ op: 'capture', ids: [ids[0], , ], selected: ids[0] }), null);
  assert.equal(call({ op: 'capture', ids: [ids[0], ids[0]], selected: ids[0] }), null);
  assert.equal(call({ op: 'capture', ids, selected: ids[0] }, { url: contents.mainFrame.url }), null);
  known = false; assert.equal(call({ op: 'capture', ids, selected: ids[0] }), null); known = true;
  assert.deepEqual(call({ op: 'capture', ids, selected: ids[0] }), { channel: 'https://www.youtube.com/@fixture/shorts', ids });
  contents.mainFrame.url = 'https://youtube.com/shorts/' + ids[1]; service.navigated(contents, contents.mainFrame.url);
  assert.deepEqual(call({ op: 'get' }).ids, ids);
  const other = { mainFrame: { url: contents.mainFrame.url } };
  assert.equal(call({ op: 'get' }, other.mainFrame, other), null);
  clock += 6 * 60 * 60 * 1000 + 1; assert.equal(call({ op: 'get' }), null);
  clock = 2000; contents.mainFrame.url = 'https://www.youtube.com/@fixture'; call({ op: 'capture', ids, selected: ids[0] });
  service.navigated(contents, 'https://www.youtube.com/results?search_query=other');
  assert.equal(call({ op: 'get' }), null);
});
