'use strict';

/**
 * Keyboard shortcut mapping - runs with plain Node, no dependencies.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { shortcutFromInput } = require('../../src/main/shortcuts');

/** Build an Electron `before-input-event`-shaped input object. */
const key = (name, modifiers = {}) => ({
  type: 'keyDown',
  key: name,
  isAutoRepeat: false,
  control: false,
  meta: false,
  alt: false,
  shift: false,
  ...modifiers,
});

describe('shortcutFromInput: shortcuts BOBO handles', () => {
  const cases = [
    [key('t', { control: true }), 'new-tab'],
    [key('T', { control: true }), 'new-tab'],
    [key('t', { control: true, shift: true }), 'reopen-tab'],
    [key('w', { control: true }), 'close-tab'],
    [key('r', { control: true }), 'reload'],
    [key('R', { control: true, shift: true }), 'reload'],
    [key('f', { control: true }), 'find-in-page'],
    [key('F', { control: true }), 'find-in-page'],
    [key('F3'), 'find-next'],
    [key('F3', { shift: true }), 'find-prev'],
    [key('l', { control: true }), 'focus-omnibox'],
    [key('Tab', { control: true }), 'next-tab'],
    [key('Tab', { control: true, shift: true }), 'prev-tab'],
    [key('F5'), 'reload'],
    [key('F6'), 'focus-omnibox'],
    [key('Escape'), 'stop'],
    // Shift doesn't cancel the Escape binding - no browser passes it to the
    // page either (Chrome binds Shift+Esc to its task manager).
    [key('Escape', { shift: true }), 'stop'],
    [key('ArrowLeft', { alt: true }), 'back'],
    [key('ArrowRight', { alt: true }), 'forward'],
    [key('d', { alt: true }), 'focus-omnibox'],
    [key('D', { alt: true }), 'focus-omnibox'],
    [key('b', { control: true, shift: true }), 'toggle-bookmarks-bar'],
    [key('n', { control: true }), 'new-window'],
    [key('n', { control: true, shift: true }), 'new-private-window'],
    [key('p', { control: true }), 'print'],
    [key('F11'), 'toggle-fullscreen'],
    // macOS parity, even though BOBO targets Windows.
    [key('t', { meta: true }), 'new-tab'],
  ];

  for (const [input, expected] of cases) {
    test(`${input.key} -> ${expected}`, () => {
      assert.equal(shortcutFromInput(input), expected);
    });
  }
});

describe('shortcutFromInput: keys that must reach the page untouched', () => {
  const cases = [
    ['plain letter', key('t')],
    ['plain space', key(' ')],
    ['plain Enter', key('Enter')],
    ['plain Tab', key('Tab')],
    ['Ctrl+letter we do not use', key('q', { control: true })],
    ['Shift alone', key('t', { shift: true })],
    ['AltGr = Ctrl+Alt (must not be swallowed)', key('t', { control: true, alt: true })],
    ['AltGr arrow (must not be swallowed)', key('ArrowLeft', { control: true, alt: true })],
    ['Ctrl+Alt+letter', key('d', { control: true, alt: true })],
    ['bare Alt', key('Alt')],
    ['unknown function key', key('F7')],
  ];

  for (const [label, input] of cases) {
    test(`${label} -> null`, () => {
      assert.equal(shortcutFromInput(input), null);
    });
  }
});

describe('shortcutFromInput: malformed input', () => {
  test('rejects non-objects and empty keys', () => {
    assert.equal(shortcutFromInput(null), null);
    assert.equal(shortcutFromInput(undefined), null);
    assert.equal(shortcutFromInput('t'), null);
    assert.equal(shortcutFromInput(42), null);
    assert.equal(shortcutFromInput({}), null);
    assert.equal(shortcutFromInput({ key: 5 }), null);
    assert.equal(shortcutFromInput({ key: '' }), null);
  });
});
