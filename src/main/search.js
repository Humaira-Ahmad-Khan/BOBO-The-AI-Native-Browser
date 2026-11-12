'use strict';

/**
 * Search provider catalogue and the default engine.
 *
 * Pure module: no Electron, no network. The address bar, the New Tab page and
 * the Settings panel all resolve their engine here, so switching providers can
 * never produce a different URL in one place than another.
 */

const SEARCH_ENGINES = [
  { id: 'google', label: 'Google', url: 'https://www.google.com/search?q=' },
  { id: 'duckduckgo', label: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
];

const DEFAULT_SEARCH_ENGINE = 'google';

const BY_ID = new Map(SEARCH_ENGINES.map((engine) => [engine.id, engine]));

function isSearchEngine(id) {
  return typeof id === 'string' && BY_ID.has(id);
}

/** Always returns an engine: unknown ids fall back to the default, never throw. */
function searchEngine(id) {
  return BY_ID.get(id) || BY_ID.get(DEFAULT_SEARCH_ENGINE);
}

function searchUrl(id) {
  return searchEngine(id).url;
}

/** Public shape for the renderer: no hidden fields, stable order. */
function publicSearchEngines() {
  return SEARCH_ENGINES.map(({ id, label }) => ({ id, label }));
}

module.exports = {
  DEFAULT_SEARCH_ENGINE,
  SEARCH_ENGINES,
  isSearchEngine,
  publicSearchEngines,
  searchEngine,
  searchUrl,
};
