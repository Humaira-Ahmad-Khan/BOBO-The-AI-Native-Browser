'use strict';

/**
 * BOBO Settings — Google Chrome-Style Settings Page.
 *
 * Implements category navigation and connects all controls to real `window.bobo` APIs.
 */

(() => {
  const api = window.bobo;
  const byId = (id) => document.getElementById(id);

  const navButtons = document.querySelectorAll('.settings-nav-btn');
  const panes = document.querySelectorAll('.settings-pane');

  const dom = {
    themeSelect: byId('set-theme-select'),
    showBookmarks: byId('set-show-bookmarks'),
    searchSelect: byId('set-search-select'),
    searchStatus: byId('search-status-msg'),
    startupNewtab: byId('startup-newtab'),
    startupRestore: byId('startup-restore'),
    startupSpecific: byId('startup-specific'),
    startupUrls: byId('startup-urls'),
    startupSave: byId('startup-save'),
    startupStatus: byId('startup-status'),
    btnImportBm: byId('set-btn-import-bm'),
    btnExportBm: byId('set-btn-export-bm'),
    btnClearBm: byId('set-btn-clear-bm'),
    bmStatus: byId('bm-status-msg'),
    downloadPath: byId('set-download-path'),
    btnChooseDl: byId('set-btn-choose-dl'),
    dlAsk: byId('set-dl-ask'),
    btnClearDl: byId('set-btn-clear-dl'),
    btnClearPrivacy: byId('set-btn-clear-privacy'),
    readerFont: byId('set-reader-font'),
    readerFontVal: byId('set-reader-font-val'),
    btnClearNotes: byId('set-btn-clear-notes'),
    dbPath: byId('set-db-path'),
    toolsPath: byId('set-tools-path'),
  };

  function setSection(name) {
    let found = false;
    panes.forEach((pane) => {
      const match = pane.id === `pane-${name}`;
      pane.hidden = !match;
      if (match) found = true;
    });

    if (!found && panes[0]) panes[0].hidden = false;

    navButtons.forEach((btn) => {
      const match = btn.dataset.section === name;
      btn.classList.toggle('is-active', match);
    });
  }

  navButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      setSection(btn.dataset.section);
    });
  });

  // Read query parameter (e.g. ?view=search)
  const urlParams = new URLSearchParams(window.location.search);
  const initialView = urlParams.get('view') || 'search';
  setSection(initialView);

  if (!api) return;

  // --- Theme ---
  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    if (dom.themeSelect) dom.themeSelect.value = theme;
  }

  dom.themeSelect?.addEventListener('change', () => {
    const val = dom.themeSelect.value;
    applyTheme(val);
    api.setTheme(val);
  });

  api.onTheme(applyTheme);

  // --- Search Engine ---
  dom.searchSelect?.addEventListener('change', async () => {
    const engine = dom.searchSelect.value;
    try {
      await api.setSearchEngine(engine);
      if (dom.searchStatus) {
        dom.searchStatus.textContent = `Default search engine updated to ${engine === 'duckduckgo' ? 'DuckDuckGo' : 'Google'}.`;
        dom.searchStatus.dataset.kind = 'ok';
      }
    } catch {
      if (dom.searchStatus) {
        dom.searchStatus.textContent = 'Failed to update search engine.';
        dom.searchStatus.dataset.kind = 'error';
      }
    }
  });

  // --- Bookmarks Bar Visibility ---
  dom.showBookmarks?.addEventListener('change', async () => {
    const val = dom.showBookmarks.value;
    try {
      await api.setBrowserSettings({ bookmarks: { barVisible: val } });
    } catch {}
  });

  // --- Startup mode ---
  document.querySelectorAll('input[name="startup-mode"]').forEach((radio) => {
    radio.addEventListener('change', async () => {
      if (!radio.checked) return;
      try {
        await api.setBrowserSettings({ startup: { mode: radio.value } });
        if (dom.startupStatus) {
          dom.startupStatus.textContent = radio.value === 'specific'
            ? 'BOBO will open the saved startup pages. Add addresses below.'
            : 'Startup preference saved.';
          dom.startupStatus.dataset.kind = 'ok';
        }
      } catch {
        if (dom.startupStatus) {
          dom.startupStatus.textContent = 'Could not save the startup preference.';
          dom.startupStatus.dataset.kind = 'error';
        }
      }
    });
  });

  dom.startupSave?.addEventListener('click', async () => {
    const urls = (dom.startupUrls?.value || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    try {
      await api.setBrowserSettings({ startup: { mode: 'specific', urls } });
      if (dom.startupSpecific) dom.startupSpecific.checked = true;
      if (dom.startupStatus) {
        dom.startupStatus.textContent = urls.length
          ? `Saved ${urls.length} startup page${urls.length === 1 ? '' : 's'}.`
          : 'No addresses saved. BOBO will open the New Tab page instead.';
        dom.startupStatus.dataset.kind = 'ok';
      }
    } catch (error) {
      if (dom.startupStatus) {
        dom.startupStatus.textContent = error?.message || 'Could not save these addresses.';
        dom.startupStatus.dataset.kind = 'error';
      }
    }
  });

  // --- Bookmarks Management ---
  dom.btnImportBm?.addEventListener('click', async () => {
    try {
      const result = await api.importBookmarks();
      if (result && !result.canceled) {
        if (dom.bmStatus) dom.bmStatus.textContent = `Imported ${result.imported || 0} bookmarks.`;
      }
    } catch (e) {
      if (dom.bmStatus) dom.bmStatus.textContent = 'Import failed.';
    }
  });

  dom.btnExportBm?.addEventListener('click', async () => {
    try {
      const result = await api.exportBookmarks();
      if (result && !result.canceled) {
        if (dom.bmStatus) dom.bmStatus.textContent = 'Bookmarks exported successfully.';
      }
    } catch {
      if (dom.bmStatus) dom.bmStatus.textContent = 'Export failed.';
    }
  });

  dom.btnClearBm?.addEventListener('click', async () => {
    try {
      await api.clearBookmarks();
      if (dom.bmStatus) dom.bmStatus.textContent = 'All bookmarks cleared.';
    } catch {}
  });

  // --- Downloads ---
  dom.btnChooseDl?.addEventListener('click', async () => {
    try {
      const result = await api.chooseDownloadFolder();
      if (result && !result.canceled && result.directory) {
        if (dom.downloadPath) dom.downloadPath.textContent = result.directory;
        await api.setBrowserSettings({ downloads: { directory: result.directory } });
      }
    } catch {}
  });

  dom.dlAsk?.addEventListener('change', async () => {
    try {
      await api.setBrowserSettings({ downloads: { ask: dom.dlAsk.checked } });
    } catch {}
  });

  dom.btnClearDl?.addEventListener('click', async () => {
    try {
      await api.clearDownloads();
    } catch {}
  });

  // --- Privacy ---
  byId('set-btn-backup')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const status = byId('set-backup-status');
    button.disabled = true;
    status.textContent = 'Preparing backup…';
    try {
      const result = await api.backupDatabase();
      status.textContent = result.canceled ? 'Backup cancelled.' : `Backup saved to ${result.file}`;
    } catch (error) {
      status.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
  byId('set-btn-restore')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const status = byId('set-restore-status');
    button.disabled = true;
    status.textContent = '';
    try {
      await api.restartToRestoreDatabase();
    } catch (error) {
      status.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
  dom.btnClearPrivacy?.addEventListener('click', async () => {
    try {
      await api.clearPrivacy('all');
    } catch {}
  });

  // --- Reader Text Size ---
  dom.readerFont?.addEventListener('input', async () => {
    const val = Number(dom.readerFont.value) || 17;
    if (dom.readerFontVal) dom.readerFontVal.textContent = `${val}px`;
    try {
      await api.setToolPrefs({ reader: { fontSize: val } });
    } catch {}
  });

  // --- Clear Notes ---
  dom.btnClearNotes?.addEventListener('click', async () => {
    try {
      await api.clearToolData('notes');
    } catch {}
  });

  // --- Load Initial State ---
  api.getState().then((state) => {
    if (state?.theme) applyTheme(state.theme);
  }).catch(() => {});

  api.browserSettings().then((browser) => {
    if (!browser) return;
    if (dom.showBookmarks) {
      const mode = browser.bookmarks?.barVisible;
      if (mode === false || mode === 'never') dom.showBookmarks.value = 'never';
      else if (mode === 'newtab') dom.showBookmarks.value = 'newtab';
      else dom.showBookmarks.value = 'always';
    }
    const mode = browser.startup?.mode || (browser.tabs?.restoreSession === false ? 'newtab' : 'continue');
    if (mode === 'specific' && dom.startupSpecific) dom.startupSpecific.checked = true;
    else if (mode === 'newtab' && dom.startupNewtab) dom.startupNewtab.checked = true;
    else if (dom.startupRestore) dom.startupRestore.checked = true;
    if (dom.startupUrls) dom.startupUrls.value = (browser.startup?.urls || []).join('\n');
  }).catch(() => {});

  api.downloadPrefs().then((dl) => {
    if (!dl) return;
    if (dom.downloadPath) dom.downloadPath.textContent = dl.directory || 'Downloads folder';
    if (dom.dlAsk) dom.dlAsk.checked = dl.ask !== false;
  }).catch(() => {});

  if (api.toolsState) {
    api.toolsState().then((tools) => {
      if (!tools) return;
      if (tools.search?.engine && dom.searchSelect) {
        dom.searchSelect.value = tools.search.engine;
      }
      if (tools.reader?.fontSize && dom.readerFont) {
        dom.readerFont.value = tools.reader.fontSize;
        if (dom.readerFontVal) dom.readerFontVal.textContent = `${tools.reader.fontSize}px`;
      }
      if (tools.storage && dom.toolsPath) {
        dom.toolsPath.textContent = tools.storage;
      }
    }).catch(() => {});
  }

  const groupSearch = byId('saved-groups-search');
  const groupList = byId('saved-groups-list');
  const groupStatus = byId('saved-groups-status');
  const groupShortcut = byId('saved-groups-shortcut');
  const groupColors = ['blue', 'grey', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
  let groups = [];

  async function groupAction(action, success) {
    try {
      groupStatus.textContent = '';
      await action();
      if (success) groupStatus.textContent = success;
    } catch (error) {
      groupStatus.textContent = error.message;
    }
  }

  function renderSavedGroups() {
    const query = groupSearch.value.trim().toLowerCase();
    const filtered = groups.filter((group) => group.name.toLowerCase().includes(query));
    byId('saved-groups-empty').hidden = groups.length > 0;
    groupList.replaceChildren();
    if (groups.length && !filtered.length) groupList.textContent = 'No matching saved groups.';

    for (const group of filtered) {
      const item = byId('saved-group-card').content.firstElementChild.cloneNode(true);
      const find = (selector) => item.querySelector(selector);
      item.dataset.groupColor = group.color;
      find('.saved-group-name').textContent = group.name;
      find('.saved-group-meta').textContent = `${group.tabCount} saved tabs · Updated ${new Date(group.updatedAt).toLocaleDateString()}`;
      const form = find('form');
      form.elements.name.value = group.name;
      const colors = form.elements.color;
      for (const color of groupColors) colors.add(new Option(color, color));
      colors.value = group.color === 'gray' ? 'grey' : group.color;
      if (!colors.value) colors.value = 'blue';

      const open = find('.btn-open-group');
      let switchExisting = false;
      open.addEventListener('click', () => groupAction(async () => {
        open.disabled = true;
        try {
          const { status } = await api.restoreSavedTabGroup(group.id, switchExisting);
          switchExisting = status === 'already-open';
          open.textContent = switchExisting ? 'Switch to Open Group' : 'Open Group';
          if (switchExisting) groupStatus.textContent = 'This group is already open.';
          if (status === 'unsafe') groupStatus.textContent = 'This group contains an unsupported address and could not be opened.';
          if (status === 'closed') groupStatus.textContent = 'The open group was closed. Select Open Group to restore it.';
          if (status === 'missing') await loadSavedTabGroups();
        } finally {
          open.disabled = false;
        }
      }));
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        groupAction(() => api.editSavedTabGroup(group.id, form.elements.name.value, colors.value), 'Saved group details updated.');
      });
      const update = find('.btn-update-group');
      update.disabled = !group.open;
      update.title = group.open ? 'Replace saved details and tabs with the open group' : 'Open this group before updating its saved tabs';
      update.addEventListener('click', () => {
        if (window.confirm('Replace the saved details and tabs with the open group?')) {
          groupAction(() => api.updateSavedTabGroup(group.id), 'Saved group updated.');
        }
      });
      find('.btn-copy-group').addEventListener('click', () =>
        groupAction(() => api.duplicateSavedTabGroup(group.id), 'Saved group duplicated.')
      );
      find('.btn-del-group').addEventListener('click', () => {
        if (window.confirm(`Delete saved group “${group.name}”?`)) {
          groupAction(() => api.deleteSavedTabGroup(group.id), 'Saved group deleted.');
        }
      });
      groupList.append(item);
    }
  }

  async function loadSavedTabGroups() {
    await groupAction(async () => {
      groups = await api.listSavedTabGroups();
      renderSavedGroups();
    });
  }

  groupSearch.addEventListener('input', renderSavedGroups);
  groupShortcut.addEventListener('change', () => groupAction(() =>
    api.setBrowserSettings({ tabs: { savedGroupsShortcut: groupShortcut.value } })
  ));
  api.browserSettings().then((browser) => {
    groupShortcut.value = browser.tabs?.savedGroupsShortcut || '';
  }).catch(() => {});
  api.onSavedTabGroups(loadSavedTabGroups);
  window.addEventListener('focus', loadSavedTabGroups);
  loadSavedTabGroups();
})();
