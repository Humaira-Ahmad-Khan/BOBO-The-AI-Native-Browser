'use strict';

/**
 * Wires the tool services to a data directory and database store.
 * The app passes `app.getPath('userData')/tools`; tests pass a throw-away directory.
 */

const path = require('node:path');
const { Store } = require('../db');
const { NotesService } = require('./notes');
const { SettingsService } = require('./settings');
const { DataExportService } = require('./export');
const { BillsExtractionService } = require('./bills');
const { YouTubeTranscriptService } = require('./transcript');
const { SectorSelectorService } = require('./sectors');
const reader = require('./reader');
const screenshots = require('./screenshots');

function createToolServices({ dataDir, store }) {
  if (typeof dataDir !== 'string' || !dataDir) throw new Error('BOBO: tools need a data directory');
  const dbStore = store || new Store({ file: path.join(dataDir, 'tools.db') });

  return {
    dataDir,
    store: dbStore,
    settings: new SettingsService({ file: path.join(dataDir, 'settings.json') }),
    notes: new NotesService({ file: path.join(dataDir, 'notes.json') }),
    exportService: new DataExportService({ store: dbStore }),
    billsService: new BillsExtractionService({ store: dbStore }),
    transcriptService: new YouTubeTranscriptService(),
    sectorsService: new SectorSelectorService({ store: dbStore }),
    screenshots,
    reader,
  };
}

module.exports = { createToolServices };
