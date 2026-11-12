'use strict';

/**
 * The only bridge between page content and the main process.
 *
 * Runs sandboxed with contextIsolation on every WebContents BOBO creates -
 * the chrome UI, the new-tab page, the error page, and remote websites.
 *
 * Because remote sites also receive this preload, this file must never trust
 * its caller: channels are allow-listed here, and the main process independently
 * verifies that the sender URL is one of BOBO's own local pages
 * (see src/main/security.js). A remote site calling any of these gets a
 * rejected promise, not data.
 */

const { contextBridge, ipcRenderer } = require('electron');

const INVOKE_CHANNELS = [
  'bobo:passwords:manage',
  'bobo:get-state',
  'bobo:tabs:create',
  'bobo:tabs:close',
  'bobo:tabs:select',
  'bobo:tabs:pin',
  'bobo:tabs:duplicate',
  'bobo:tabs:mute',
  'bobo:tabs:move',
  'bobo:tabs:menu',
  'bobo:library:open',
  'bobo:settings:open',
  'bobo:zoom:in',
  'bobo:zoom:out',
  'bobo:zoom:reset',
  'bobo:zoom:level',
  'bobo:print',
  'bobo:window:new',
  'bobo:tabs:detach',
  'bobo:tabs:closed-menu',
  'bobo:window:quit',
  'bobo:window:fullscreen',
  'bobo:bookmarks:menu',
  'bobo:ui:overlay',
  'bobo:nav:input',
  'bobo:nav:back',
  'bobo:nav:forward',
  'bobo:nav:reload',
  'bobo:nav:stop',
  'bobo:nav:home',
  'bobo:nav:retry',
  'bobo:chrome:bounds',
  'bobo:ui:theme',
  // Browser settings
  'bobo:settings:search',
  'bobo:settings:browser',
  'bobo:search:suggest',
  'bobo:profiles:choose',
  'bobo:newtab:shortcut-icon',
  'bobo:youtube:theme',
  'bobo:youtube:auto-skip',
  'bobo:database:backup',
  'bobo:database:restart-to-restore',
  'bobo:settings:set-browser',
  'bobo:privacy:clear',
  // Bookmarks, history, downloads
  'bobo:bookmarks:list',
  'bobo:bookmarks:favourites',
  'bobo:bookmarks:find',
  'bobo:bookmarks:toggle',
  'bobo:bookmarks:add',
  'bobo:bookmarks:update',
  'bobo:bookmarks:remove',
  'bobo:bookmarks:folder:add',
  'bobo:bookmarks:folder:rename',
  'bobo:bookmarks:folder:remove',
  'bobo:bookmarks:import',
  'bobo:bookmarks:export',
  'bobo:bookmarks:clear',
  'bobo:history:list',
  'bobo:history:remove',
  'bobo:history:clear',
  'bobo:downloads:list',
  'bobo:downloads:prefs',
  'bobo:downloads:pause',
  'bobo:downloads:resume',
  'bobo:downloads:cancel',
  'bobo:downloads:remove',
  'bobo:downloads:clear',
  'bobo:downloads:open',
  'bobo:downloads:show',
  'bobo:downloads:copy-path',
  'bobo:downloads:choose-folder',
  // BOBO Tools. Each one is validated again in the main process.
  'bobo:daily-receive:download',
  'bobo:tools:state',
  'bobo:tools:configure',
  'bobo:tools:prefs',
  'bobo:tools:copy-text',
  'bobo:tools:clear',
  'bobo:screenshot:capture',
  'bobo:screenshot:ocr',
  'bobo:linkedin:capture',
  'bobo:linkedin:save-text',
  'bobo:screenshot:copy',
  'bobo:screenshot:save',
  'bobo:notes:list',
  'bobo:notes:save',
  'bobo:notes:delete',
  'bobo:notes:export',
  'bobo:reader:extract',
  'bobo:reader:save',
  // Data Export
  'bobo:export:inspect-table',
  'bobo:export:collect-pages',
  'bobo:scraper:extract',
  'bobo:csv-extractor:page',
  'bobo:video:queue',
  'bobo:video:find-page',
  'bobo:video:add',
  'bobo:video:import',
  'bobo:video:analyse',
  'bobo:video:remove',
  'bobo:video:stop',
  'bobo:video:start',
  'bobo:video:folder',
  'bobo:export:save-csv',
  'bobo:export:save-pdf',
  'bobo:export:merge-csv',
  'bobo:export:presets:list',
  'bobo:export:presets:save',
  'bobo:export:presets:delete',
  // Bills History Extraction
  'bobo:bills:create-job',
  'bobo:prints:scan',
  'bobo:prints:folder',
  'bobo:prints:download',
  'bobo:prints:stop',
  'bobo:prints:csv',
  'bobo:bills:get-job',
  'bobo:bills:list-jobs',
  'bobo:bills:get-queue',
  'bobo:bills:process-item',
  'bobo:bills:pause',
  'bobo:bills:resume',
  'bobo:bills:stop',
  'bobo:bills:retry',
  'bobo:bills:retry-empty',
  'bobo:bills:repair-ids',
  'bobo:bills:run-state',
  'bobo:bills:clear-all',
  'bobo:bills:clear',
  'bobo:bills:export-csv',
  'bobo:bills:export-connections',
  // YouTube Transcript
  'bobo:transcript:detect',
  'bobo:transcript:seek',
  'bobo:transcript:export',
  // Tab Groups
  'bobo:tabs:group:create',
  'bobo:tabs:group:update',
  'bobo:tabs:group:toggle',
  'bobo:tabs:group:ungroup',
  'bobo:tabs:group:close',
  'bobo:tabs:group:set',
  'bobo:tabs:group:save',
  'bobo:tabs:group:menu',
  'bobo:tabs:group:saved-list',
  'bobo:tabs:group:saved-edit',
  'bobo:tabs:group:saved-update',
  'bobo:tabs:group:saved-duplicate',
  'bobo:tabs:group:saved-delete',
  'bobo:tabs:group:saved-restore',
  // Find in Page
  'bobo:find:in-page',
  'bobo:find:stop',
  'bobo:find:visibility',
  // Quick Sector Selector
  'bobo:sectors:inspect',
  'bobo:sectors:save',
  'bobo:sectors:list',
  'bobo:sectors:select',
  'bobo:sectors:clear',
  // New Tab page: local file selection + Google services launcher prefs
  'bobo:newtab:pick-attachments',
  'bobo:newtab:lens',
  'bobo:newtab:apps:get',
  'bobo:newtab:apps:set',
];

const EVENT_CHANNELS = [
  'bobo:export:progress',
  'bobo:daily-receive:progress',
  'bobo:tabs',
  'bobo:theme',
  'bobo:ui',
  'bobo:bookmarks',
  'bobo:history',
  'bobo:downloads',
  'bobo:settings',
  'bobo:saved-groups:changed',
  'bobo:find:result',
];

function invoke(channel, payload) {
  if (!INVOKE_CHANNELS.includes(channel)) {
    return Promise.reject(new Error(`BOBO: blocked channel ${channel}`));
  }
  return ipcRenderer.invoke(channel, payload);
}

function subscribe(channel, callback) {
  if (!EVENT_CHANNELS.includes(channel) || typeof callback !== 'function') return () => {};
  const listener = (_event, data) => {
    try {
      callback(data);
    } catch {
      // A broken listener must never break the browser.
    }
  };
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

// NOTE: keyboard shortcuts are deliberately NOT handled here. Browser shortcuts
// are wired in the main process via `before-input-event` (src/main/main.js), so
// they work regardless of focus and remote pages get no IPC path to trigger
// browser actions. A preload keydown bridge would be dead code - and a hazard.

const bridge = {
  passwordManager: (payload) => invoke('bobo:passwords:manage', payload),
  openProfiles: () => invoke('bobo:profiles:choose'),
  shortcutIcon: (origin) => invoke('bobo:newtab:shortcut-icon', { origin }),
  setYouTubeTheme: (mode) => invoke('bobo:youtube:theme', { mode }),
  setYouTubeAutoSkip: (enabled) => invoke('bobo:youtube:auto-skip', { enabled }),
  suggestSearch: (query) => invoke('bobo:search:suggest', { query }),
  platform: process.platform,

  getState: () => invoke('bobo:get-state'),

  createTab: (url) =>
    invoke('bobo:tabs:create', typeof url === 'string' ? { url } : undefined),
  closeTab: (id) => invoke('bobo:tabs:close', { id }),
  selectTab: (id) => invoke('bobo:tabs:select', { id }),
  pinTab: (id) => invoke('bobo:tabs:pin', { id }),
  duplicateTab: (id) => invoke('bobo:tabs:duplicate', { id }),
  muteTab: (id) => invoke('bobo:tabs:mute', { id }),
  moveTab: (id, index) => invoke('bobo:tabs:move', { id, index }),
  tabMenu: (id) => invoke('bobo:tabs:menu', { id }),
  openLibrary: (view) => invoke('bobo:library:open', { view: String(view ?? '') }),
  openSettings: (view) => invoke('bobo:settings:open', { view: String(view ?? '') }),
  openBookmarkMenu: (folderId, overflowStart) => invoke('bobo:bookmarks:menu', { folderId, overflowStart }),
  setOverlay: (open) => invoke('bobo:ui:overlay', { open: open === true }),
  zoomIn: () => invoke('bobo:zoom:in'),
  zoomOut: () => invoke('bobo:zoom:out'),
  zoomReset: () => invoke('bobo:zoom:reset'),
  zoomLevel: () => invoke('bobo:zoom:level'),
  printPage: () => invoke('bobo:print'),
  newWindow: () => invoke('bobo:window:new'),
  detachTab: (id) => invoke('bobo:tabs:detach', { id }),
  recentlyClosedTabs: () => invoke('bobo:tabs:closed-menu'),
  quitApp: () => invoke('bobo:window:quit'),
  toggleFullScreen: () => invoke('bobo:window:fullscreen'),

  navigate: (id, text) => invoke('bobo:nav:input', { id, text }),
  back: (id) => invoke('bobo:nav:back', { id }),
  forward: (id) => invoke('bobo:nav:forward', { id }),
  reload: (id) => invoke('bobo:nav:reload', { id }),
  stop: (id) => invoke('bobo:nav:stop', { id }),
  home: (id) => invoke('bobo:nav:home', { id }),
  retry: (id) => invoke('bobo:nav:retry', { id }),

  setBounds: (bounds) => invoke('bobo:chrome:bounds', bounds),
  setTheme: (theme) => invoke('bobo:ui:theme', { theme }),
  setSearchEngine: (engine) => invoke('bobo:settings:search', { engine: String(engine ?? '') }),
  browserSettings: () => invoke('bobo:settings:browser'),
  backupDatabase: () => invoke('bobo:database:backup'),
  restartToRestoreDatabase: () => invoke('bobo:database:restart-to-restore'),
  setBrowserSettings: (patch) =>
    invoke('bobo:settings:set-browser', patch && typeof patch === 'object' ? patch : {}),
  clearPrivacy: (what) => invoke('bobo:privacy:clear', { what: String(what ?? '') }),

  // --- Bookmarks ----------------------------------------------------------
  listBookmarks: () => invoke('bobo:bookmarks:list'),
  favouriteBookmarks: () => invoke('bobo:bookmarks:favourites'),
  findBookmark: (url) => invoke('bobo:bookmarks:find', { url: String(url ?? '') }),
  toggleBookmark: (url, title) =>
    invoke('bobo:bookmarks:toggle', { url: String(url ?? ''), title: String(title ?? '') }),
  addBookmark: (bookmark) => invoke('bobo:bookmarks:add', bookmark && typeof bookmark === 'object' ? bookmark : {}),
  updateBookmark: (bookmark) =>
    invoke('bobo:bookmarks:update', bookmark && typeof bookmark === 'object' ? bookmark : {}),
  removeBookmark: (id) => invoke('bobo:bookmarks:remove', { id }),
  addBookmarkFolder: (name, parentId) => invoke('bobo:bookmarks:folder:add', { name, parentId }),
  renameBookmarkFolder: (id, name) => invoke('bobo:bookmarks:folder:rename', { id, name }),
  removeBookmarkFolder: (id) => invoke('bobo:bookmarks:folder:remove', { id }),
  importBookmarks: () => invoke('bobo:bookmarks:import'),
  exportBookmarks: () => invoke('bobo:bookmarks:export'),
  clearBookmarks: () => invoke('bobo:bookmarks:clear'),

  // --- History ------------------------------------------------------------
  listHistory: (query, limit, offset) =>
    invoke('bobo:history:list', { query: String(query ?? ''), limit, offset }),
  removeHistory: (id) => invoke('bobo:history:remove', { id }),
  clearHistory: (range) => invoke('bobo:history:clear', { range: String(range ?? 'all') }),

  // --- Downloads ----------------------------------------------------------
  listDownloads: () => invoke('bobo:downloads:list'),
  downloadPrefs: () => invoke('bobo:downloads:prefs'),
  pauseDownload: (id) => invoke('bobo:downloads:pause', { id }),
  resumeDownload: (id) => invoke('bobo:downloads:resume', { id }),
  cancelDownload: (id) => invoke('bobo:downloads:cancel', { id }),
  removeDownload: (id) => invoke('bobo:downloads:remove', { id }),
  clearDownloads: () => invoke('bobo:downloads:clear'),
  openDownload: (id) => invoke('bobo:downloads:open', { id }),
  showDownload: (id) => invoke('bobo:downloads:show', { id }),
  copyDownloadPath: (id) => invoke('bobo:downloads:copy-path', { id }),
  chooseDownloadFolder: () => invoke('bobo:downloads:choose-folder'),

  // --- BOBO Tools ---------------------------------------------------------
  downloadDailyReceive: () => invoke('bobo:daily-receive:download'),
  onDailyReceiveProgress: (callback) => subscribe('bobo:daily-receive:progress', callback),
  // Tools state: which tools exist, whether they are enabled/pinned, prefs.
  toolsState: () => invoke('bobo:tools:state'),
  configureTool: (id, patch) =>
    invoke('bobo:tools:configure', { id, ...(patch && typeof patch === 'object' ? patch : {}) }),
  setToolPrefs: (prefs) =>
    invoke('bobo:tools:prefs', prefs && typeof prefs === 'object' ? prefs : {}),
  copyText: (text) => invoke('bobo:tools:copy-text', { text: String(text ?? '') }),
  clearToolData: (what) => invoke('bobo:tools:clear', { what }),

  // Screenshot
  captureScreenshot: () => invoke('bobo:screenshot:capture'),
  recognizeScreenshot: (dataUrl) => invoke('bobo:screenshot:ocr', { dataUrl }),
  captureLinkedIn: (mode) => invoke('bobo:linkedin:capture', { mode }),
  saveLinkedInText: (text) => invoke('bobo:linkedin:save-text', { text }),
  copyScreenshot: (dataUrl) => invoke('bobo:screenshot:copy', { dataUrl }),
  saveScreenshot: (dataUrl) => invoke('bobo:screenshot:save', { dataUrl }),

  // Notes
  listNotes: () => invoke('bobo:notes:list'),
  saveNote: (note) => invoke('bobo:notes:save', { note }),
  deleteNote: (id) => invoke('bobo:notes:delete', { id }),
  exportNote: (id) => invoke('bobo:notes:export', id ? { id } : {}),

  // Reader
  extractReader: () => invoke('bobo:reader:extract'),
  saveReader: (doc) => invoke('bobo:reader:save', { doc }),

  // Data Export
  inspectTable: () => invoke('bobo:export:inspect-table'),
  collectExportPages: (payload) => invoke('bobo:export:collect-pages', payload),
  onExportProgress: (callback) => subscribe('bobo:export:progress', callback),
  scrapePage: (mode) => invoke('bobo:scraper:extract', { mode }),
  consumerCsvPage: (direction, pageId, tabId) => invoke('bobo:csv-extractor:page', { direction, pageId, tabId }),
  socialVideoQueue: () => invoke('bobo:video:queue'),
  findPageVideos: () => invoke('bobo:video:find-page'),
  addSocialVideos: (urls) => invoke('bobo:video:add', { urls }),
  importSocialVideos: (text, csv) => invoke('bobo:video:import', { text, csv }),
  analyseSocialVideo: (id) => invoke('bobo:video:analyse', { id }),
  removeSocialVideo: (id) => invoke('bobo:video:remove', { id }),
  stopSocialVideos: () => invoke('bobo:video:stop'),
  startSocialVideos: (retry, id) => invoke('bobo:video:start', { retry, id }),
  chooseSocialVideoFolder: () => invoke('bobo:video:folder'),
  saveExportCsv: (payload) => invoke('bobo:export:save-csv', payload),
  saveExportPdf: (payload) => invoke('bobo:export:save-pdf', payload),
  mergeExportCsv: (payload) => invoke('bobo:export:merge-csv', payload),
  listColumnPresets: (domain) => invoke('bobo:export:presets:list', { domain }),
  saveColumnPreset: (preset) => invoke('bobo:export:presets:save', preset),
  deleteColumnPreset: (id) => invoke('bobo:export:presets:delete', { id }),

  // Bills History Extraction
  billsCreateJob: (payload) => invoke('bobo:bills:create-job', payload),
  scanBillPrints: (append) => invoke('bobo:prints:scan', { append }),
  chooseBillPrintsFolder: () => invoke('bobo:prints:folder'),
  downloadBillPrint: (id, minutes) => invoke('bobo:prints:download', { id, minutes }),
  stopBillPrints: () => invoke('bobo:prints:stop'),
  exportBillPrintsCsv: () => invoke('bobo:prints:csv'),
  billsGetJob: (jobId) => invoke('bobo:bills:get-job', { jobId }),
  billsListJobs: () => invoke('bobo:bills:list-jobs'),
  billsGetQueue: (jobId, recent = false) => invoke('bobo:bills:get-queue', { jobId, recent }),
  billsProcessItem: (jobId, queueItemId, tabId) =>
    invoke('bobo:bills:process-item', { jobId, queueItemId, tabId }),
  billsPause: () => invoke('bobo:bills:pause'),
  billsResume: () => invoke('bobo:bills:resume'),
  billsStop: () => invoke('bobo:bills:stop'),
  billsRetry: (jobId) => invoke('bobo:bills:retry', { jobId }),
  billsRetryEmpty: (jobId) => invoke('bobo:bills:retry-empty', { jobId }),
  billsRepairIds: (jobId) => invoke('bobo:bills:repair-ids', { jobId }),
  billsSetRunning: (jobId, running) => invoke('bobo:bills:run-state', { jobId, running }),
  billsClearAll: () => invoke('bobo:bills:clear-all'),
  billsClear: (jobId) => invoke('bobo:bills:clear', { jobId }),
  billsExportCsv: (jobId, connectionNo, merged = false) =>
    invoke('bobo:bills:export-csv', { jobId, connectionNo, merged }),
  billsExportAllJobs: () => invoke('bobo:bills:export-csv', { allJobs: true }),
  billsExportConnections: (jobId, mode) =>
    invoke('bobo:bills:export-connections', { jobId, mode }),

  // YouTube Transcript
  transcriptDetect: (language) =>
    invoke('bobo:transcript:detect', { language: language ? String(language) : 'auto' }),
  transcriptSeek: (seconds, tabId, url) => invoke('bobo:transcript:seek', { seconds, tabId, url }),
  transcriptExport: (payload) => invoke('bobo:transcript:export', payload),

  // Tab Groups
  createTabGroup: (payload) => invoke('bobo:tabs:group:create', payload),
  updateTabGroup: (groupId, updates) => invoke('bobo:tabs:group:update', { groupId, ...(updates || {}) }),
  toggleTabGroup: (groupId) => invoke('bobo:tabs:group:toggle', { groupId }),
  ungroupTabGroup: (groupId) => invoke('bobo:tabs:group:ungroup', { groupId }),
  closeTabGroup: (groupId) => invoke('bobo:tabs:group:close', { groupId }),
  setTabGroup: (id, groupId) => invoke('bobo:tabs:group:set', { id, groupId }),
  saveTabGroup: (payload) => invoke('bobo:tabs:group:save', payload),
  tabGroupMenu: (groupId) => invoke('bobo:tabs:group:menu', { groupId }),
  listSavedTabGroups: () => invoke('bobo:tabs:group:saved-list'),
  editSavedTabGroup: (id, name, color) => invoke('bobo:tabs:group:saved-edit', { id, name, color }),
  updateSavedTabGroup: (id) => invoke('bobo:tabs:group:saved-update', { id }),
  duplicateSavedTabGroup: (id) => invoke('bobo:tabs:group:saved-duplicate', { id }),
  deleteSavedTabGroup: (id) => invoke('bobo:tabs:group:saved-delete', { id }),
  restoreSavedTabGroup: (id, switchExisting) => invoke('bobo:tabs:group:saved-restore', { id, switchExisting }),
  onSavedTabGroups: (callback) => subscribe('bobo:saved-groups:changed', callback),

  // Find in Page
  ...(location.protocol === 'file:' && location.pathname.endsWith('/renderer/index.html') ? {
    findInPage: (payload) => invoke('bobo:find:in-page', payload),
    stopFindInPage: (id) => invoke('bobo:find:stop', { id }),
    setFindVisibility: (open, restoreFocus) => invoke('bobo:find:visibility', { open, restoreFocus }),
    onFindResult: (callback) => subscribe('bobo:find:result', callback),
  } : {}),

  // Quick Sector Selector
  inspectSectors: () => invoke('bobo:sectors:inspect'),
  saveSectors: (sectors, domain) => invoke('bobo:sectors:save', { sectors, domain }),
  listSectors: (query, domain) => invoke('bobo:sectors:list', { query, domain }),
  selectSector: (payload) => invoke('bobo:sectors:select', payload),
  clearSectors: (domain) => invoke('bobo:sectors:clear', { domain }),

  // New Tab page: native file picker (metadata + image thumbnails only)
  pickAttachments: (kind) => invoke('bobo:newtab:pick-attachments', { kind: String(kind ?? '') }),
  searchImageWithLens: (imageId) => invoke('bobo:newtab:lens', { imageId }),
  googleApps: () => invoke('bobo:newtab:apps:get'),
  setGoogleAppsPrefs: (prefs) =>
    invoke('bobo:newtab:apps:set', prefs && typeof prefs === 'object' ? prefs : {}),

  onTabs: (callback) => subscribe('bobo:tabs', callback),
  onTheme: (callback) => subscribe('bobo:theme', callback),
  onUi: (callback) => subscribe('bobo:ui', callback),
  onBookmarks: (callback) => subscribe('bobo:bookmarks', callback),
  onHistory: (callback) => subscribe('bobo:history', callback),
  onDownloads: (callback) => subscribe('bobo:downloads', callback),
  onSettings: (callback) => subscribe('bobo:settings', callback),
};

const pageMethods = {
  newtab: ["createTab","getState","googleApps","navigate","onTheme","pickAttachments","searchImageWithLens","setGoogleAppsPrefs","shortcutIcon","suggestSearch","toolsState"],
  settings: ["passwordManager","backupDatabase","browserSettings","chooseDownloadFolder","clearBookmarks","clearDownloads","clearPrivacy","clearToolData","deleteSavedTabGroup","downloadPrefs","duplicateSavedTabGroup","editSavedTabGroup","exportBookmarks","getState","importBookmarks","listSavedTabGroups","onSavedTabGroups","onTheme","restoreSavedTabGroup","restartToRestoreDatabase","setBrowserSettings","setSearchEngine","setTheme","setToolPrefs","toolsState","updateSavedTabGroup"],
  library: ["addBookmark","addBookmarkFolder","cancelDownload","chooseDownloadFolder","clearDownloads","clearHistory","createTab","downloadPrefs","exportBookmarks","importBookmarks","listBookmarks","listDownloads","listHistory","onBookmarks","onDownloads","onHistory","onTheme","openDownload","pauseDownload","removeBookmark","removeBookmarkFolder","removeDownload","removeHistory","renameBookmarkFolder","resumeDownload","setBrowserSettings","showDownload","updateBookmark"],
  error: ["back","closeTab","getState","home","retry"],
};
const page = location.pathname.match(/\/renderer\/(index|newtab|settings|library|error)\.html$/)?.[1];
if (process.isMainFrame && location.protocol === 'file:' && page) {
  const exposed = page === 'index' ? Object.fromEntries(Object.entries(bridge).filter(([key]) =>
    !['passwordManager', 'backupDatabase', 'restartToRestoreDatabase', 'pickAttachments', 'searchImageWithLens', 'googleApps', 'setGoogleAppsPrefs', 'shortcutIcon'].includes(key)))
    : Object.fromEntries(pageMethods[page].map((key) => [key, bridge[key]]));
  contextBridge.exposeInMainWorld('bobo', exposed);
}

// Remote pages receive no callable password API. This code runs only in the
// sandboxed isolated world and accepts real user events in the top-level frame.
if (process.isMainFrame && location.protocol === 'https:') {
  let enabled = false;
  let requesting = false;
  let captureTimer = null;
  const rendered = field => {
    const box = field.getBoundingClientRect();
    return field.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
      box.width >= 8 && box.height >= 8;
  };
  const visible = field => {
    const box = field.getBoundingClientRect();
    return !field.disabled && !field.readOnly && rendered(field) &&
      box.top >= 0 && box.left >= 0 && box.bottom <= innerHeight && box.right <= innerWidth;
  };
  const controlName = field => {
    const name = field.getAttribute('formcontrolname') || '';
    return /^[A-Za-z0-9_.-]{1,128}$/.test(name) ? name : '';
  };
  // Preserve existing name/ID bindings; Angular fills the previously unnamed case.
  const identity = field => field.name || field.id || (controlName(field) ? `formcontrol:${controlName(field)}` : '');
  const signature = field => `${field.type}:${identity(field)}:${field.autocomplete || ''}`;
  function inspect(form) {
    if (!(form instanceof HTMLFormElement) || form.target && form.target !== '_self') return null;
    if ([...form.elements].some(field => ['formaction', 'formmethod', 'formtarget'].some(name => field.hasAttribute(name)))) return null;
    const action = new URL(form.action, location.href);
    if (action.origin !== location.origin || action.protocol !== 'https:' || action.username || action.password) return null;
    const inputs = [...form.elements].filter(field => field instanceof HTMLInputElement);
    const passwords = inputs.filter(field => field.type === 'password');
    if (passwords.length !== 1 || passwords[0].autocomplete === 'new-password' || !visible(passwords[0])) return null;
    const password = passwords[0];
    const candidates = inputs.filter(field => ['text', 'email', 'tel', 'number'].includes(field.type) &&
      visible(field) && (field.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING));
    const named = candidates.filter(field => field.autocomplete === 'username' ||
      /user|email|cnic|login|identity|identifier/i.test(`${field.name} ${field.id} ${field.getAttribute('aria-label') || ''} ${field.placeholder}`));
    const username = named.length === 1 ? named[0] : candidates.length === 1 ? candidates[0] : null;
    if (!username || !identity(username) || !identity(password)) return null;
    const post = form.method.toLowerCase() === 'post';
    // Unnamed Angular controls are not serialized by a native GET. A cancelled
    // trusted submit is required before capturing this JavaScript-only form.
    const javascriptForm = !form.hasAttribute('method') && !form.hasAttribute('action') &&
      !username.name && !password.name && !!controlName(username) && !!controlName(password);
    if (!post && !javascriptForm) return null;
    return { username, password, form, javascriptForm: !post, description: { action: action.origin + action.pathname,
      usernameField: signature(username), passwordField: signature(password) } };
  }
  const status = async () => {
    try { enabled = (await ipcRenderer.invoke('bobo:passwords:page', { op: 'status' })).enabled === true; }
    catch { enabled = false; }
  };
  const ready = () => {
    // No credential data is included in this document-state signal.
    void ipcRenderer.invoke('bobo:passwords:page', { op: 'ready',
      hasLogin: [...document.querySelectorAll('input[type="password"]')].some(field => rendered(field)) }).catch(() => {});
  };
  addEventListener('DOMContentLoaded', () => { void status(); setTimeout(ready, 1200); }, { once: true });
  addEventListener('focus', () => { void status(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void status(); });
  addEventListener('submit', event => {
    if (!event.isTrusted || !enabled) return;
    const fields = inspect(event.target);
    if (!fields || !fields.username.value || !fields.password.value || fields.username.value.length > 512 || fields.password.value.length > 4096) return;
    const submitter = event.submitter;
    if (submitter && (submitter.hasAttribute('formaction') || submitter.hasAttribute('formmethod') || submitter.hasAttribute('formtarget'))) return;
    const candidate = { form: fields.description, username: fields.username.value, password: fields.password.value };
    const capture = () => {
      clearInterval(captureTimer);
      ipcRenderer.send('bobo:passwords:candidate', candidate);
      // SPAs may remove the form without navigating. No polling of secret values.
      let attempts = 0;
      captureTimer = setInterval(() => {
        if (++attempts >= 60) { clearInterval(captureTimer); captureTimer = null; return; }
        if (![...document.querySelectorAll('input[type="password"]')].some(field => rendered(field))) {
          clearInterval(captureTimer); captureTimer = null; ready();
        }
      }, 1000);
    };
    if (fields.javascriptForm) setTimeout(() => { if (event.defaultPrevented) capture(); }, 0);
    else capture();
  }, true);
  const offerAccount = async event => {
    if (!event.isTrusted || requesting || !(event.target instanceof HTMLInputElement)) return;
    const fields = inspect(event.target.form);
    if (!fields || ![fields.username, fields.password].includes(event.target) ||
        fields.password.value || fields.username.value.length > 512) return;
    requesting = true;
    const originalURL = location.href;
    const originalUsername = fields.username.value;
    try {
      await status();
      if (!enabled) return;
      const result = await ipcRenderer.invoke('bobo:passwords:page', {
        op: 'fill', form: fields.description, username: originalUsername,
      });
      const current = inspect(fields.form);
      if (location.href !== originalURL || !current || current.username !== fields.username || current.password !== fields.password ||
          JSON.stringify(current.description) !== JSON.stringify(fields.description) || fields.username.value !== originalUsername || fields.password.value ||
          typeof result.username !== 'string' || typeof result.password !== 'string' ||
          originalUsername && result.username !== originalUsername) return;
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(fields.username, result.username);
      set.call(fields.password, result.password);
      for (const field of [fields.username, fields.password]) {
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.dispatchEvent(new Event('change', { bubbles: true }));
      }
    } catch { /* A failed or stale fill never submits or modifies another form. */ }
    finally { requesting = false; }
  };
  addEventListener('focusin', offerAccount, true);
  addEventListener('click', offerAccount, true);
}
