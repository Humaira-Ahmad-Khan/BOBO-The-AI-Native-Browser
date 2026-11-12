'use strict';

/**
 * BOBO Library: the in-tab manager for bookmarks, history and downloads.
 *
 * A local page, like the new-tab page: no inline scripts or styles, no network
 * requests of its own. Every privileged action goes through the narrow
 * `window.bobo` bridge into the main process, which re-validates it.
 */

(() => {
  const api = window.bobo;
  if (!api || typeof api.listBookmarks !== 'function') return;

  const SVG = 'http://www.w3.org/2000/svg';
  const byId = (id) => document.getElementById(id);
  const VIEWS = ['bookmarks', 'history', 'downloads'];
  const HISTORY_PAGE = 100;
  const STATE_LABELS = {
    progressing: 'Downloading',
    paused: 'Paused',
    completed: 'Completed',
    cancelled: 'Cancelled',
    interrupted: 'Interrupted',
  };

  const dom = {
    tree: byId('bm-tree'),
    bmSearch: byId('bm-search'),
    bmAdd: byId('bm-add'),
    bmAddFolder: byId('bm-add-folder'),
    bmImport: byId('bm-import'),
    bmExport: byId('bm-export'),
    bmStatus: byId('bm-status'),
    bmForm: byId('bm-form'),
    bmFormTitle: byId('bm-form-title'),
    bmFormUrl: byId('bm-form-url'),
    bmFormFolder: byId('bm-form-folder'),
    bmFolderForm: byId('bm-folder-form'),
    bmFolderName: byId('bm-folder-name'),
    bmFolderParent: byId('bm-folder-parent'),

    hsSearch: byId('hs-search'),
    hsRange: byId('hs-range'),
    hsClear: byId('hs-clear'),
    hsStatus: byId('hs-status'),
    hsList: byId('hs-list'),
    hsMore: byId('hs-more'),

    dlFolder: byId('dl-folder'),
    dlChoose: byId('dl-choose'),
    dlClear: byId('dl-clear'),
    dlStatus: byId('dl-status'),
    dlList: byId('dl-list'),
  };

  const state = {
    view: '',
    bookmarks: null,
    bmQuery: '',
    history: [],
    historyTotal: 0,
    hsQuery: '',
    downloads: [],
    prefs: null,
    armed: null,
  };

  // --- small DOM helpers ----------------------------------------------------

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function icon(name) {
    const svg = document.createElementNS(SVG, 'svg');
    const use = document.createElementNS(SVG, 'use');
    use.setAttribute('href', `#${name}`);
    svg.appendChild(use);
    return svg;
  }

  function iconButton(iconName, label, onClick) {
    const button = el('button', 'library-icon-btn');
    button.type = 'button';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.appendChild(icon(iconName));
    if (onClick) button.addEventListener('click', onClick);
    return button;
  }

  function describe(error) {
    const raw = error && error.message ? error.message : String(error || 'Something went wrong.');
    return raw.replace(/^Error invoking remote method '[^']+':\s*/, '');
  }

  function byPosition(a, b) {
    return a.position - b.position || a.id - b.id;
  }

  function applyTheme(value) {
    document.documentElement.dataset.theme = value === 'light' ? 'light' : 'dark';
  }

  function setStatus(node, message) {
    if (node) node.textContent = message || '';
  }

  /** Arm a destructive button: the first click asks, the second acts. */
  function armButton(button, label, action) {
    if (state.armed && state.armed.button === button) {
      state.armed = null;
      button.textContent = label;
      action();
      return;
    }
    if (state.armed) {
      state.armed.button.textContent = state.armed.label;
      clearTimeout(state.armed.timer);
    }
    button.textContent = `${label} — click again`;
    const timer = setTimeout(() => {
      if (state.armed && state.armed.button === button) {
        button.textContent = label;
        state.armed = null;
      }
    }, 4000);
    state.armed = { button, label, timer };
  }

  // --- view switching -------------------------------------------------------

  function showView(view) {
    const next = VIEWS.includes(view) ? view : 'bookmarks';
    if (next === state.view) return;
    state.view = next;

    document.querySelectorAll('[data-section]').forEach((section) => {
      section.hidden = section.dataset.section !== next;
    });
    document.querySelectorAll('[data-view]').forEach((tab) => {
      const active = tab.dataset.view === next;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-current', active ? 'page' : 'false');
    });

    if (next === 'bookmarks') loadBookmarks();
    if (next === 'history') loadHistory();
    if (next === 'downloads') loadDownloads();
  }

  // --- bookmarks ------------------------------------------------------------

  const isRoot = (folder) => folder && folder.parentId == null;

  function folderById(id) {
    if (!state.bookmarks) return null;
    return state.bookmarks.folders.find((folder) => folder.id === id) || null;
  }

  function folderChoices(select, selected) {
    const data = state.bookmarks;
    if (!data) return;
    const options = [];
    const walk = (parentId, depth) => {
      for (const folder of data.folders.filter((item) => (item.parentId ?? null) === parentId).sort(byPosition)) {
        const option = document.createElement('option');
        option.value = String(folder.id);
        option.textContent = `${'\u00a0\u00a0'.repeat(depth)}${folder.name}`;
        options.push(option);
        walk(folder.id, depth + 1);
      }
    };
    walk(null, 0);
    select.replaceChildren(...options);
    select.value = String(selected || 1);
  }

  function refreshFolderSelects() {
    folderChoices(dom.bmFormFolder, Number(dom.bmFormFolder.value) || 1);
    folderChoices(dom.bmFolderParent, Number(dom.bmFolderParent.value) || 1);
  }

  function openBookmarkForm(folderId) {
    dom.bmFolderForm.hidden = true;
    dom.bmForm.hidden = false;
    refreshFolderSelects();
    if (folderId) dom.bmFormFolder.value = String(folderId);
    dom.bmFormTitle.value = '';
    dom.bmFormUrl.value = '';
    dom.bmFormTitle.focus();
  }

  function openFolderForm(parentId) {
    dom.bmForm.hidden = true;
    dom.bmFolderForm.hidden = false;
    refreshFolderSelects();
    if (parentId) dom.bmFolderParent.value = String(parentId);
    dom.bmFolderName.value = '';
    dom.bmFolderName.focus();
  }

  function hideForms() {
    dom.bmForm.hidden = true;
    dom.bmFolderForm.hidden = true;
  }

  async function loadBookmarks() {
    try {
      const data = await api.listBookmarks();
      if (!data) return;
      state.bookmarks = data;
      refreshFolderSelects();
      renderBookmarks();
    } catch (error) {
      setStatus(dom.bmStatus, describe(error));
    }
  }

  function bookmarkRow(bookmark) {
    const row = el('li', 'library-row');

    const main = el('div', 'library-row-main');
    const title = el('button', 'library-row-title', bookmark.title);
    title.type = 'button';
    title.title = bookmark.url;
    title.addEventListener('click', () => api.createTab(bookmark.url));
    const sub = el('span', 'library-row-sub', bookmark.url);
    main.append(title, sub);

    const actions = el('div', 'library-row-actions');
    const star = iconButton(
      'lib-star',
      bookmark.favourite ? 'Remove from favourites' : 'Add to favourites',
      async () => {
        try {
          await api.updateBookmark({ id: bookmark.id, favourite: !bookmark.favourite });
          await loadBookmarks();
          renderBookmarks();
        } catch (error) {
          setStatus(dom.bmStatus, describe(error));
        }
      }
    );
    if (bookmark.favourite) star.classList.add('is-on');
    actions.append(
      iconButton('lib-open', `Open ${bookmark.title} in a new tab`, () => api.createTab(bookmark.url)),
      star,
      iconButton('lib-pencil', `Edit ${bookmark.title}`, () => beginEdit(bookmark, row)),
      iconButton('lib-trash', `Delete ${bookmark.title}`, async () => {
        try {
          await api.removeBookmark(bookmark.id);
          await loadBookmarks();
          renderBookmarks();
          setStatus(dom.bmStatus, 'Bookmark deleted.');
        } catch (error) {
          setStatus(dom.bmStatus, describe(error));
        }
      })
    );

    row.append(main, actions);
    return row;
  }

  /** Swap a bookmark row for an inline title/folder editor. */
  function beginEdit(bookmark, row) {
    const form = el('form', 'library-row');
    const title = el('input', 'tp-input');
    title.type = 'text';
    title.value = bookmark.title;
    title.setAttribute('aria-label', 'Bookmark title');
    const folder = el('select', 'tp-select');
    folder.setAttribute('aria-label', 'Bookmark folder');
    folderChoices(folder, bookmark.folderId);
    const save = el('button', 'btn primary', 'Save');
    save.type = 'submit';
    const cancel = el('button', 'btn', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', renderBookmarks);

    form.append(title, folder, save, cancel);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        await api.updateBookmark({
          id: bookmark.id,
          title: title.value,
          folderId: Number(folder.value),
        });
        await loadBookmarks();
        renderBookmarks();
        setStatus(dom.bmStatus, 'Bookmark updated.');
      } catch (error) {
        setStatus(dom.bmStatus, describe(error));
      }
    });

    row.replaceChildren(form);
    title.focus();
    title.select();
  }

  function emptyState(title, detail) {
    const box = el('div', 'library-empty');
    box.appendChild(el('strong', '', title));
    box.appendChild(el('span', '', detail || ''));
    return box;
  }

  function folderBlock(folder) {
    const block = el('div', 'library-folder-block');
    const head = el('div', 'library-folder-head');
    head.appendChild(icon('lib-folder'));
    head.appendChild(el('span', '', folder.name));

    const actions = el('div', 'library-row-actions');
    actions.append(
      iconButton('lib-plus', `Add a bookmark to ${folder.name}`, () => openBookmarkForm(folder.id)),
      iconButton('lib-folder', `Add a subfolder to ${folder.name}`, () => openFolderForm(folder.id))
    );
    if (!isRoot(folder)) {
      actions.append(
        iconButton('lib-pencil', `Rename ${folder.name}`, () => beginRenameFolder(folder, head)),
        iconButton('lib-trash', `Delete ${folder.name}`, async () => {
          try {
            await api.removeBookmarkFolder(folder.id);
            await loadBookmarks();
            renderBookmarks();
            setStatus(dom.bmStatus, 'Folder deleted, along with the bookmarks inside it.');
          } catch (error) {
            setStatus(dom.bmStatus, describe(error));
          }
        })
      );
    }
    head.appendChild(actions);
    block.appendChild(head);

    const data = state.bookmarks;
    const bookmarks = data.bookmarks.filter((bookmark) => bookmark.folderId === folder.id).sort(byPosition);
    if (bookmarks.length) {
      const list = el('ul', 'library-list');
      for (const bookmark of bookmarks) list.appendChild(bookmarkRow(bookmark));
      block.appendChild(list);
    }

    for (const child of data.folders.filter((item) => item.parentId === folder.id).sort(byPosition)) {
      block.appendChild(folderBlock(child));
    }

    if (!bookmarks.length && !data.folders.some((item) => item.parentId === folder.id)) {
      block.appendChild(el('p', 'library-hint', 'Empty folder.'));
    }
    return block;
  }

  function beginRenameFolder(folder, head) {
    const form = el('form', 'library-toolbar');
    const input = el('input', 'tp-input');
    input.type = 'text';
    input.value = folder.name;
    input.setAttribute('aria-label', 'Folder name');
    const save = el('button', 'btn primary', 'Save');
    save.type = 'submit';
    const cancel = el('button', 'btn', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', renderBookmarks);

    form.append(input, save, cancel);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        await api.renameBookmarkFolder(folder.id, input.value);
        await loadBookmarks();
        renderBookmarks();
        setStatus(dom.bmStatus, 'Folder renamed.');
      } catch (error) {
        setStatus(dom.bmStatus, describe(error));
      }
    });

    head.replaceChildren(form);
    input.focus();
    input.select();
  }

  function renderBookmarks() {
    const data = state.bookmarks;
    if (!data) {
      dom.tree.replaceChildren(emptyState('No bookmark data', 'BOBO could not read the local bookmark store.'));
      return;
    }

    const query = state.bmQuery.trim().toLowerCase();
    if (query) {
      const matches = data.bookmarks
        .filter(
          (bookmark) =>
            bookmark.title.toLowerCase().includes(query) || bookmark.url.toLowerCase().includes(query)
        )
        .sort(byPosition);
      if (!matches.length) {
        dom.tree.replaceChildren(emptyState('No bookmarks match that', 'Try a shorter search.'));
        return;
      }
      const list = el('ul', 'library-list');
      for (const bookmark of matches) list.appendChild(bookmarkRow(bookmark));
      dom.tree.replaceChildren(list);
      return;
    }

    const nodes = [];
    for (const rootId of [1, 2]) {
      const root =
        folderById(rootId) || { id: rootId, parentId: null, name: rootId === 1 ? 'Bookmarks bar' : 'Other bookmarks' };
      nodes.push(folderBlock(root));
    }
    dom.tree.replaceChildren(...nodes);
  }

  async function addBookmark(event) {
    event.preventDefault();
    try {
      const url = dom.bmFormUrl.value.trim();
      if (!url) throw new Error('Enter an address to bookmark.');
      await api.addBookmark({
        url,
        title: dom.bmFormTitle.value.trim(),
        folderId: Number(dom.bmFormFolder.value) || 1,
      });
      hideForms();
      await loadBookmarks();
      renderBookmarks();
      setStatus(dom.bmStatus, 'Bookmark added.');
    } catch (error) {
      setStatus(dom.bmStatus, describe(error));
    }
  }

  async function addFolder(event) {
    event.preventDefault();
    try {
      const name = dom.bmFolderName.value.trim();
      if (!name) throw new Error('Enter a folder name.');
      await api.addBookmarkFolder(name, Number(dom.bmFolderParent.value) || 1);
      hideForms();
      await loadBookmarks();
      renderBookmarks();
      setStatus(dom.bmStatus, 'Folder created.');
    } catch (error) {
      setStatus(dom.bmStatus, describe(error));
    }
  }

  async function importBookmarks() {
    try {
      const result = await api.importBookmarks();
      if (!result || result.canceled) {
        setStatus(dom.bmStatus, 'Import canceled. Nothing was changed.');
        return;
      }
      await loadBookmarks();
      renderBookmarks();
      setStatus(
        dom.bmStatus,
        `Imported ${result.added} bookmark${result.added === 1 ? '' : 's'} in ${result.folders} new folder${
          result.folders === 1 ? '' : 's'
        }. Skipped ${result.skipped} duplicate${result.skipped === 1 ? '' : 's'}.`
      );
    } catch (error) {
      setStatus(dom.bmStatus, describe(error));
    }
  }

  async function exportBookmarks() {
    try {
      const result = await api.exportBookmarks();
      setStatus(
        dom.bmStatus,
        result && result.path ? `Exported to ${result.path}` : 'Export canceled.'
      );
    } catch (error) {
      setStatus(dom.bmStatus, describe(error));
    }
  }

  // --- history --------------------------------------------------------------

  function historyRow(entry) {
    const row = el('li', 'library-row');
    const main = el('div', 'library-row-main');
    const title = el('button', 'library-row-title', entry.title || entry.url);
    title.type = 'button';
    title.title = entry.url;
    title.addEventListener('click', () => api.createTab(entry.url));
    const sub = el(
      'span',
      'library-row-sub',
      `${new Date(entry.visitedAt).toLocaleString()} \u00b7 ${entry.url}`
    );
    main.append(title, sub);

    const actions = el('div', 'library-row-actions');
    actions.append(
      iconButton('lib-open', `Reopen ${entry.title || entry.url}`, () => api.createTab(entry.url)),
      iconButton('lib-trash', 'Delete this visit', async () => {
        try {
          await api.removeHistory(entry.id);
          await loadHistory();
        } catch (error) {
          setStatus(dom.hsStatus, describe(error));
        }
      })
    );

    row.append(main, actions);
    return row;
  }

  function renderHistory() {
    if (!state.history.length) {
      const detail = state.hsQuery
        ? 'Try a shorter search.'
        : 'Pages you visit in BOBO will appear here.';
      const item = el('li', '');
      item.appendChild(emptyState(state.hsQuery ? 'No history matches that' : 'No history yet', detail));
      dom.hsList.replaceChildren(item);
      dom.hsMore.hidden = true;
      setStatus(dom.hsStatus, '');
      return;
    }

    dom.hsList.replaceChildren(...state.history.map(historyRow));
    dom.hsMore.hidden = state.history.length >= state.historyTotal;
    setStatus(dom.hsStatus, `${state.historyTotal} visit${state.historyTotal === 1 ? '' : 's'} stored.`);
  }

  async function loadHistory({ append = false } = {}) {
    try {
      const offset = append ? state.history.length : 0;
      const result = await api.listHistory(state.hsQuery, HISTORY_PAGE, offset);
      if (!result) return;
      state.history = append ? [...state.history, ...result.entries] : result.entries;
      state.historyTotal = result.total;
      renderHistory();
    } catch (error) {
      setStatus(dom.hsStatus, describe(error));
    }
  }

  async function clearHistory() {
    try {
      const result = await api.clearHistory(dom.hsRange.value);
      if (result && result.canceled) {
        setStatus(dom.hsStatus, 'Canceled. Nothing was cleared.');
        return;
      }
      await loadHistory();
      setStatus(dom.hsStatus, `Cleared ${result ? result.removed : 0} visit${result && result.removed === 1 ? '' : 's'}.`);
    } catch (error) {
      setStatus(dom.hsStatus, describe(error));
    }
  }

  // --- downloads ------------------------------------------------------------

  function formatBytes(value) {
    const bytes = Number(value) || 0;
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let size = bytes / 1024;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
      size /= 1024;
      unit += 1;
    }
    return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unit]}`;
  }

  function downloadRow(download) {
    const row = el('li', 'library-row');
    const main = el('div', 'library-row-main');
    main.appendChild(el('span', 'library-row-title', download.filename));

    const stateLabel = STATE_LABELS[download.state] || download.state;
    const size = download.total
      ? `${formatBytes(download.received)} of ${formatBytes(download.total)}`
      : formatBytes(download.received);
    main.appendChild(el('span', 'library-row-sub', `${stateLabel} \u00b7 ${size}`));
    if (download.error) main.appendChild(el('span', 'library-row-sub', download.error));

    if (download.state === 'progressing' || download.state === 'paused') {
      const progress = el('progress', 'library-progress');
      progress.max = 100;
      progress.value = download.total
        ? Math.min(100, Math.round((download.received / download.total) * 100))
        : 0;
      main.appendChild(progress);
    }

    const actions = el('div', 'library-row-actions');
    if (download.danger) {
      const flag = el('span', 'library-danger', 'Dangerous type');
      flag.title = 'BOBO never opens this automatically, and always asks where to save it.';
      actions.appendChild(flag);
    }

    const run = (fn) => async () => {
      try {
        await fn();
        await loadDownloads();
      } catch (error) {
        setStatus(dom.dlStatus, describe(error));
      }
    };

    if (download.state === 'progressing' && download.canPause !== false) {
      actions.appendChild(iconButton('lib-pause', 'Pause download', run(() => api.pauseDownload(download.id))));
    }
    if (download.state === 'paused') {
      actions.appendChild(iconButton('lib-play', 'Resume download', run(() => api.resumeDownload(download.id))));
    }
    if (download.state === 'progressing' || download.state === 'paused') {
      actions.appendChild(iconButton('lib-close', 'Cancel download', run(() => api.cancelDownload(download.id))));
    }
    if (download.state === 'completed') {
      actions.append(
        iconButton('lib-open', 'Open this file', run(() => api.openDownload(download.id))),
        iconButton('lib-folder', 'Show in its folder', run(() => api.showDownload(download.id)))
      );
    }
    if (download.state !== 'progressing' && download.state !== 'paused') {
      actions.appendChild(iconButton('lib-trash', 'Remove from the list', run(() => api.removeDownload(download.id))));
    }

    row.append(main, actions);
    return row;
  }

  function renderDownloads() {
    if (!state.downloads.length) {
      const item = el('li', '');
      item.appendChild(
        emptyState('No downloads yet', 'Files you download will be listed here with their progress.')
      );
      dom.dlList.replaceChildren(item);
      return;
    }
    dom.dlList.replaceChildren(...state.downloads.map(downloadRow));
  }

  async function loadDownloads() {
    try {
      const [list, prefs] = await Promise.all([
        api.listDownloads(),
        api.downloadPrefs().catch(() => null),
      ]);
      state.downloads = Array.isArray(list) ? list : [];
      if (prefs) {
        state.prefs = prefs;
        dom.dlFolder.textContent = prefs.ask
          ? `BOBO asks where to save each file. Default: ${prefs.directory}`
          : `Saving to ${prefs.directory}`;
      }
      renderDownloads();
    } catch (error) {
      setStatus(dom.dlStatus, describe(error));
    }
  }

  // --- wiring ---------------------------------------------------------------

  document.querySelectorAll('[data-view]').forEach((tab) => {
    tab.addEventListener('click', () => showView(tab.dataset.view));
  });

  dom.bmSearch.addEventListener('input', () => {
    state.bmQuery = dom.bmSearch.value;
    renderBookmarks();
  });

  dom.bmAdd.addEventListener('click', () => openBookmarkForm(1));
  dom.bmAddFolder.addEventListener('click', () => openFolderForm(1));
  dom.bmImport.addEventListener('click', importBookmarks);
  dom.bmExport.addEventListener('click', exportBookmarks);
  dom.bmForm.addEventListener('submit', addBookmark);
  dom.bmFolderForm.addEventListener('submit', addFolder);

  document.querySelectorAll('[data-cancel-form]').forEach((button) => {
    button.addEventListener('click', () => {
      const form = byId(button.dataset.cancelForm);
      if (form) form.hidden = true;
    });
  });

  let historyTimer = null;
  dom.hsSearch.addEventListener('input', () => {
    clearTimeout(historyTimer);
    historyTimer = setTimeout(() => {
      state.hsQuery = dom.hsSearch.value;
      loadHistory();
    }, 200);
  });
  dom.hsClear.addEventListener('click', clearHistory);
  dom.hsMore.addEventListener('click', () => loadHistory({ append: true }));

  dom.dlChoose.addEventListener('click', async () => {
    try {
      const picked = await api.chooseDownloadFolder();
      if (!picked || picked.canceled) {
        setStatus(dom.dlStatus, 'Folder unchanged.');
        return;
      }
      await api.setBrowserSettings({ downloads: { directory: picked.directory } });
      await loadDownloads();
      setStatus(dom.dlStatus, 'Download folder updated.');
    } catch (error) {
      setStatus(dom.dlStatus, describe(error));
    }
  });

  dom.dlClear.addEventListener('click', () => {
    armButton(dom.dlClear, 'Clear list', async () => {
      try {
        const result = await api.clearDownloads();
        await loadDownloads();
        setStatus(dom.dlStatus, `Removed ${result ? result.removed : 0} entr${result && result.removed === 1 ? 'y' : 'ies'}.`);
      } catch (error) {
        setStatus(dom.dlStatus, describe(error));
      }
    });
  });

  api.onTheme(applyTheme);
  api.onBookmarks((data) => {
    if (!data || !Array.isArray(data.bookmarks)) return;
    state.bookmarks = data;
    refreshFolderSelects();
    if (state.view === 'bookmarks') renderBookmarks();
  });
  api.onHistory(() => {
    if (state.view === 'history') loadHistory();
  });
  api.onDownloads((list) => {
    if (state.view !== 'downloads') return;
    if (Array.isArray(list)) {
      state.downloads = list;
      renderDownloads();
    } else {
      loadDownloads();
    }
  });

  api
    .getState()
    .then((payload) => payload && applyTheme(payload.theme))
    .catch(() => {});

  const initial = new URLSearchParams(location.search).get('view');
  // Force the first paint: state.view starts empty, so showView always runs.
  showView(VIEWS.includes(initial) ? initial : 'bookmarks');
})();
