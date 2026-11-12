'use strict';

/**
 * The BOBO Tools registry: the single list the main process, the sidebar, the
 * toolbar and the settings panel all read.
 *
 * Adding a tool means adding an entry here (plus its service and its view);
 * nothing else in the browser needs restructuring.
 */

const { DEFAULT_SEARCH_ENGINE } = require('../search');
const { normalizeLauncherPrefs } = require('../google-apps');

const TOOLS = [
  {
    id: 'screenshot',
    label: 'Screenshot',
    description: 'Capture what you can see in the active tab.',
    icon: 'i-camera',
    pinnedByDefault: true,
    permissions: [
      'Reads the pixels of the active tab, only when you press Capture',
      'Writes an image to the clipboard, only when you press Copy',
      'Writes a PNG to the folder you pick in the save dialog',
    ],
  },
  {
    id: 'notes',
    label: 'Notes',
    description: 'Quick notes, saved locally, optionally tied to the page.',
    icon: 'i-note',
    pinnedByDefault: false,
    permissions: [
      'Stores your notes in a local JSON file on this PC',
      'Reads the current tab URL and title when you press "Link to this page"',
      'Writes an export file only where you choose in the save dialog',
    ],
  },
  {
    id: 'reader',
    label: 'Reader',
    description: 'Extract the readable text of the current page.',
    icon: 'i-book',
    pinnedByDefault: false,
    permissions: [
      'Reads the visible article text of the active tab, only when you press Read',
      'Never reads input fields, passwords, cookies or hidden values',
      'Refuses sign-in, webmail, banking and password-manager pages',
    ],
  },
  {
    id: 'social-video',
    label: 'Social Video Downloader',
    description: 'Queue authorised public direct video files and save them locally.',
    icon: 'i-download',
    pinnedByDefault: false,
    permissions: ['Contacts the media host on request and saves files in your chosen folder'],
  },
  {
    id: 'web-scraper',
    label: 'Web Scraper',
    description: 'Collect structured information from the active webpage.',
    icon: 'i-search',
    pinnedByDefault: false,
    permissions: [
      'Reads the active webpage when you choose an extractor',
      'Saves results to a CSV file you choose',
    ],
  },
  {
    id: 'linkedin-capture',
    label: 'LinkedIn Post Capture',
    description: 'Copy or save a selected LinkedIn post as an image or text.',
    icon: 'i-camera',
    pinnedByDefault: false,
    permissions: ['Reads or captures only the LinkedIn post you select'],
  },
  {
    id: 'youtube-auto-skip',
    label: 'YouTube Auto Skip',
    description: 'Clicks YouTube’s Skip button when a skippable ad is playing.',
    icon: 'i-search',
    pinnedByDefault: false,
    permissions: ['Watches for the visible Skip button in the YouTube player when enabled'],
  },
  {
    id: 'ad-free-youtube',
    label: 'Ad Free YouTube',
    description: 'Open YouTube video pages on yout-ube.com when enabled.',
    icon: 'i-youtube',
    pinnedByDefault: false,
    permissions: ['Sends the video ID to yout-ube.com when enabled'],
  },
  {
    id: 'transcript',
    label: 'YouTube Transcript',
    description: 'Extract, preview and download YouTube video captions in TXT, SRT, VTT, CSV or PDF.',
    icon: 'i-youtube',
    pinnedByDefault: false,
    permissions: [
      'Reads video metadata and captions from the active YouTube tab',
      'Supports timestamp seek control in the video player',
      'Exports transcript files to your chosen local folder',
    ],
  },
  {
    id: 'sectors',
    label: 'Quick Sector Selector',
    description: 'Fast searchable dropdown and auto-selector for municipal sector options.',
    icon: 'i-search',
    pinnedByDefault: false,
    permissions: [
      'Reads available sector dropdown options from supported municipal pages on user request',
      'Selects sector options on the web page when you choose them',
      'Stores sector list in your local database for fast offline search',
    ],
  },
];

const TOOL_IDS = TOOLS.map((tool) => tool.id);

const DEFAULT_SETTINGS = {
  version: 2,
  tools: Object.fromEntries(
    TOOLS.map((tool) => [tool.id, { enabled: true, pinned: tool.pinnedByDefault }])
  ),
  reader: { fontSize: 17 },
  search: { engine: DEFAULT_SEARCH_ENGINE },
  browser: {
    youtubeAutoSkip: false,
    youtubeTheme: 'default',
    tabs: { restoreSession: true, savedGroupsShortcut: '' },
    startup: { mode: 'continue', urls: [] },
    bookmarks: { barVisible: true },
    // Empty directory means "the OS Downloads folder", resolved in main.
    downloads: { ask: true, directory: '' },
    // 0 means keep history until the user clears it.
    history: { retentionDays: 0 },
  },
  // Google services launcher shortcuts (locally managed, not Google-synced).
  launcher: normalizeLauncherPrefs(),
};

function publicTool(tool, settings) {
  const config = settings.tools?.[tool.id] || {};
  return {
    id: tool.id,
    label: tool.label,
    description: tool.description,
    icon: tool.icon,
    enabled: config.enabled !== false,
    pinned: config.pinned === true,
    sidebar: config.sidebar !== false,
    permissions: tool.permissions,
  };
}

module.exports = { DEFAULT_SETTINGS, TOOLS, TOOL_IDS, publicTool };
