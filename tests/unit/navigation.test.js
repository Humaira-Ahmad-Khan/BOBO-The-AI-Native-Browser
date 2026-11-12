'use strict';

/**
 * Milestone 1 unit checks: run with `npm test` (plain Node, no dependencies).
 *
 * Covers the two pure policy functions BOBO depends on:
 *   - resolveInput:            address bar -> URL vs. search query
 *   - isLocalRendererUrl:      the IPC sender trust boundary
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  DEFAULT_SEARCH_URL,
  LOCAL_RENDERER_DIR,
  MAX_INPUT,
  isAllowedNavigationUrl,
  isLocalRendererUrl,
  resolveInput,
} = require('../../src/main/navigation');
const { DEFAULT_SEARCH_ENGINE, searchUrl } = require('../../src/main/search');

const search = (query) => `${DEFAULT_SEARCH_URL}${encodeURIComponent(query)}`;

describe('search provider defaults', () => {
  test('Google is the default search engine', () => {
    assert.equal(DEFAULT_SEARCH_ENGINE, 'google');
    assert.equal(DEFAULT_SEARCH_URL, 'https://www.google.com/search?q=');
  });

  test('DuckDuckGo is still a first-class option', () => {
    const result = resolveInput('bobo browser', searchUrl('duckduckgo'));
    assert.equal(result.kind, 'search');
    assert.equal(result.url, `https://duckduckgo.com/?q=${encodeURIComponent('bobo browser')}`);
  });

  test('an unknown engine id falls back to Google instead of throwing', () => {
    assert.equal(searchUrl('bing'), 'https://www.google.com/search?q=');
    assert.equal(searchUrl(undefined), 'https://www.google.com/search?q=');
  });
});

describe('resolveInput: values that are URLs', () => {
  const cases = [
    ['example.com', 'https://example.com/'],
    ['www.example.com', 'https://www.example.com/'],
    ['sub.domain.co.uk:8080/path?q=1', 'https://sub.domain.co.uk:8080/path?q=1'],
    ['192.168.1.10:3000', 'https://192.168.1.10:3000/'],
    ['localhost:5173', 'http://localhost:5173/'],
    ['127.0.0.1', 'http://127.0.0.1/'],
    ['[::1]:8080', 'http://[::1]:8080/'],
    ['https://example.com/x', 'https://example.com/x'],
    ['HTTPS://EXAMPLE.COM/Path', 'https://example.com/Path'],
    ['//cdn.example.com/lib.js', 'https://cdn.example.com/lib.js'],
    ['example.com/a b', 'https://example.com/a%20b'],
  ];

  for (const [input, expected] of cases) {
    test(`${input} -> ${expected}`, () => {
      const result = resolveInput(input);
      assert.equal(result.kind, 'url');
      assert.equal(result.url, expected);
    });
  }
});

describe('resolveInput: values that are searches', () => {
  const cases = [
    'electron browser tutorial',
    'what is a browser',
    'example',
    'why does my code fail?',
    // Dangerous schemes must never be navigated to from the address bar.
    'javascript:alert(1)',
    'data:text/html,<h1>hi</h1>',
    'file:///C:/Windows/System32',
    'mailto:someone@example.com',
    'ftp://files.example.com/pub',
    // Scheme-looking local input is a search, not a navigation.
    'localhost is not a scheme here',
  ];

  for (const input of cases) {
    test(`${JSON.stringify(input)} -> search`, () => {
      const result = resolveInput(input);
      assert.equal(result.kind, 'search');
      assert.equal(result.url, search(input));
    });
  }
});

describe('resolveInput: edge cases', () => {
  test('empty and non-string input returns null', () => {
    assert.equal(resolveInput(''), null);
    assert.equal(resolveInput('    '), null);
    assert.equal(resolveInput(null), null);
    assert.equal(resolveInput(undefined), null);
    assert.equal(resolveInput(42), null);
    assert.equal(resolveInput({}), null);
  });

  test('input over MAX_INPUT is rejected', () => {
    assert.equal(resolveInput('a'.repeat(MAX_INPUT + 1)), null);
    assert.notEqual(resolveInput('a'.repeat(MAX_INPUT)), null);
  });

  test('a custom search engine is honoured and its query is encoded', () => {
    const result = resolveInput('two words & symbols', 'https://s.example/?q=');
    assert.equal(result.kind, 'search');
    assert.equal(result.url, 'https://s.example/?q=two%20words%20%26%20symbols');
  });
});

describe('isAllowedNavigationUrl: http(s) only', () => {
  test('allows http and https', () => {
    assert.equal(isAllowedNavigationUrl('https://example.com'), true);
    assert.equal(isAllowedNavigationUrl('http://example.com'), true);
  });

  test('rejects every other scheme and bad input', () => {
    for (const value of [
      'javascript:alert(1)',
      'data:text/html,x',
      'file:///C:/Windows',
      'chrome://settings',
      'about:blank',
      'ftp://example.com',
      'not a url',
      '',
      null,
      undefined,
      7,
    ]) {
      assert.equal(isAllowedNavigationUrl(value), false, `should reject ${String(value)}`);
    }
  });
});

describe('isLocalRendererUrl: the IPC sender trust boundary', () => {
  const local = (file) => `file:///${path.join(LOCAL_RENDERER_DIR, file).split(path.sep).join('/')}`;

  test('accepts BOBO pages inside src/renderer', () => {
    assert.equal(isLocalRendererUrl(local('index.html')), true);
    assert.equal(isLocalRendererUrl(local('newtab.html')), true);
    assert.equal(isLocalRendererUrl(local('error.html')), true);
  });

  test('rejects remote pages', () => {
    assert.equal(isLocalRendererUrl('https://evil.example.com/index.html'), false);
    assert.equal(isLocalRendererUrl('http://evil.example.com/'), false);
  });

  test('rejects other local files and directory traversal', () => {
    assert.equal(isLocalRendererUrl('file:///C:/Windows/System32/cmd.exe'), false);
    assert.equal(isLocalRendererUrl(local('../main/main.js')), false);
    assert.equal(isLocalRendererUrl(local('../../secrets.txt')), false);
    assert.equal(isLocalRendererUrl('file:///'), false);
    assert.equal(isLocalRendererUrl(''), false);
    assert.equal(isLocalRendererUrl(null), false);
  });
});
