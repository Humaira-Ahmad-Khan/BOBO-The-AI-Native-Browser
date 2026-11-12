'use strict';

/**
 * Browser data services wired to one directory (the app's userData).
 * Tests pass a throw-away directory and never touch a real profile.
 */

const path = require('node:path');
const { Store } = require('./db');
const { BookmarksService } = require('./bookmarks');
const { HistoryService } = require('./history');
const { DownloadsService } = require('./downloads');
const { SessionStore } = require('./session-store');

function createBrowserServices({ dataDir }) {
  if (typeof dataDir !== 'string' || !dataDir) throw new Error('BOBO: browser data needs a directory');

  const store = new Store({ file: path.join(dataDir, 'bobo.db') });

  return {
    dataDir,
    store,
    bookmarks: new BookmarksService({ store }),
    history: new HistoryService({ store }),
    downloads: new DownloadsService({ store }),
    sessions: new SessionStore({ file: path.join(dataDir, 'session.json') }),
  };
}

module.exports = { createBrowserServices };
