'use strict';

/**
 * Browser keyboard shortcuts, mapped from Electron's `before-input-event`
 * input object.
 *
 * Pure on purpose - no Electron import - so `node --test tests/unit` can cover
 * the mapping without installing anything.
 *
 * Why this lives in the main process instead of a preload keydown listener:
 * a keydown bridge inside the preload had to be IPC-sent from the page, and the
 * IPC sender check (correctly) rejects remote websites - so shortcuts only
 * worked while the BOBO chrome had focus. `before-input-event` is raised by the
 * browser process itself for every WebContents, so shortcuts work regardless of
 * focus, the key can be swallowed before a page sees it, and remote content no
 * longer has any IPC path for triggering browser actions at all.
 *
 * @see src/main/main.js for the wiring and the guards around these combos.
 */

/**
 * Shortcuts the browser acts on. Anything not listed here is passed straight
 * through to the page untouched.
 *
 * Note: none of these require Ctrl+Alt together, which is what makes the
 * AltGr guard below safe.
 */

const SAVED_GROUPS_KEYS = ['g', 'y'];

function shortcutFromInput(input, savedGroupsKey = '') {
  if (!input || typeof input !== 'object') return null;

  const key = typeof input.key === 'string' ? input.key : '';
  if (!key) return null;

  const ctrl = !!input.control || !!input.meta;
  const alt = !!input.alt;

  // Windows reports AltGr as Ctrl+Alt. No BOBO shortcut uses both modifiers, so
  // bail out before an AltGr character (common on non-US layouts) gets swallowed
  // as a browser shortcut and stops reaching the page.
  if (ctrl && alt) return null;

  if (key === 'F5') return 'reload';
  if (key === 'F6') return 'focus-omnibox';
  if (key === 'F11') return 'toggle-fullscreen';
  if (key === 'Escape') return 'stop';
  if (key === 'F3') return input.shift ? 'find-prev' : 'find-next';

  if (alt) {
    if (key === 'ArrowLeft') return 'back';
    if (key === 'ArrowRight') return 'forward';
    if (key === 'd' || key === 'D') return 'focus-omnibox';
    return null;
  }

  if (!ctrl) return null;
  if (input.shift && SAVED_GROUPS_KEYS.includes(savedGroupsKey) && key.toLowerCase() === savedGroupsKey) {
    return 'saved-groups';
  }

  switch (key.toLowerCase()) {
    case 't':
      return input.shift ? 'reopen-tab' : 'new-tab';
    case 'w':
      return 'close-tab';
    case 'r':
      return 'reload';
    case 'f':
      return 'find-in-page';
    case 'l':
      return 'focus-omnibox';
    case 'd':
      return input.shift ? 'bookmark-all-tabs' : 'bookmark-page';
    case 'h':
      return 'history';
    case 'j':
      return 'downloads';
    case 'o':
      return input.shift ? 'bookmarks-manager' : null;
    case 'b':
      return input.shift ? 'toggle-bookmarks-bar' : null;
    case 'n':
      return input.shift ? 'new-private-window' : 'new-window';
    case 'p':
      return 'print';
    case '=':
    case '+':
      return 'zoom-in';
    case '-':
    case '_':
      return 'zoom-out';
    case '0':
      return 'zoom-reset';
    case 'delete':
      return input.shift ? 'clear-browsing-data' : null;
    case 'a':
      // Ctrl+A must keep selecting text in the page.
      return input.shift ? 'tab-search' : null;
    default:
      break;
  }

  if (key === 'Tab') return input.shift ? 'prev-tab' : 'next-tab';
  return null;
}

module.exports = { shortcutFromInput, SAVED_GROUPS_KEYS };
