'use strict';

/**
 * BOBO chrome renderer: tab strip, toolbar, address bar, sidebar and theme.
 *
 * This page is the window's own webContents and draws only the chrome. The
 * website itself is a WebContentsView layered on top of the empty #viewport
 * element - its bounds are measured here and pushed to the main process, which
 * is what keeps content aligned when the window, sidebar or toolbar changes.
 */

(() => {
  const api = window.bobo;
  const byId = (id) => document.getElementById(id);

  if (!api) {
    document.body.classList.add('no-api');
    return;
  }

  const dom = {
    tabs: byId('tabs'),
    viewport: byId('viewport'),
    omnibox: byId('omnibox'),
    input: byId('omnibox-input'),
    siteInfo: byId('site-info'),
    btnBack: byId('btn-back'),
    btnForward: byId('btn-forward'),
    btnReload: byId('btn-reload'),
    btnSidebar: byId('btn-sidebar'),
    progress: byId('progress'),
    sidebar: byId('sidebar'),
    themeLabel: byId('theme-label'),
    themeUse: byId('theme-icon').querySelector('use'),
    bookmarksBar: byId('bookmarks-bar'),
    btnStar: byId('btn-star'),
    btnShields: byId('btn-shields'),
    btnDownloads: byId('btn-downloads'),
    downloadsBadge: byId('downloads-badge'),
    downloadPopup: byId('download-popup'),
    dlPopupClear: byId('dl-popup-clear'),
    dlPopupShowAll: byId('dl-popup-show-all'),
    dlPopupList: byId('dl-popup-list'),
    dlPopupEmpty: byId('dl-popup-empty'),
    bookmarkEditorPopup: byId('bookmark-editor-popup'),
    bmPopupTitle: byId('bm-popup-title'),
    bmPopupName: byId('bm-popup-name'),
    bmPopupFolder: byId('bm-popup-folder'),
    bmPopupRemove: byId('bm-popup-remove'),
    bmPopupDone: byId('bm-popup-done'),
    bmFolderMenu: byId('bm-folder-menu'),
    btnMenu: byId('btn-menu'),
    chromeMenu: byId('chrome-menu'),
    shieldsPopup: byId('shields-popup'),
    shieldsPageUrl: byId('shields-page-url'),
    shieldsConnectionDetail: byId('shields-connection-detail'),
    shieldsConnectionTag: byId('shields-connection-tag'),
    shieldsBtnPerms: byId('shields-btn-perms'),
    shieldsBtnClear: byId('shields-btn-clear'),
    menuZoomIn: byId('menu-zoom-in'),
    menuZoomOut: byId('menu-zoom-out'),
    menuZoomReset: byId('menu-zoom-reset'),
    menuFullscreen: byId('menu-fullscreen'),
    tabSearch: byId('tab-search'),
    tabSearchInput: byId('tab-search-input'),
    tabSearchList: byId('tab-search-list'),
  };

  const state = { activeId: null, tabs: [], groups: [], bookmarks: null, browser: null, searchEngine: 'google' };
  let theme = 'dark';
  let sidebarOpen = localStorage.getItem('bobo:sidebar-open') === 'true'; // Default collapsed (Chrome-style)
  let lastBounds = '';
  let searchOpen = false;
  let menuOpen = false;
  let shieldsOpen = false;
  let downloadsOpen = false;
  let bookmarkEditorOpen = false;
  let folderMenuOpen = false;
  let downloadsList = [];
  let editingBookmarkId = null;
  let dragId = null;
  let dragCancelled = false;
  let starUrl = '';
  let starBookmark = null;
  let starPending = false;

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const activeTab = () => state.tabs.find((tab) => tab.id === state.activeId) || null;

  function icon(name) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', `#${name}`);
    svg.appendChild(use);
    return svg;
  }

  // --- tab strip ----------------------------------------------------------

  function tabFavicon(tab) {
    const holder = document.createElement('span');
    holder.className = 'tab-favicon';

    if (tab.loading) {
      holder.classList.add('is-loading');
      return holder;
    }

    const remote = tab.url && tab.favicon && /^(https?|data):/i.test(tab.favicon);
    if (remote) {
      const image = document.createElement('img');
      image.src = tab.favicon;
      image.alt = '';
      image.referrerPolicy = 'no-referrer';
      image.addEventListener('error', () => {
        holder.replaceChildren(letter(tab));
      });
      holder.appendChild(image);
      return holder;
    }

    holder.appendChild(letter(tab));
    return holder;
  }

  function letter(tab) {
    if (!tab.url) return brandFavicon(); // BOBO's own new tab page
    const span = document.createElement('span');
    span.className = 'letter';
    span.textContent = ((tab.title || '?').trim().charAt(0) || '?').toUpperCase();
    return span;
  }

  /** BOBO's own pages get the official 16px favicon in the tab strip. */
  function brandFavicon() {
    const image = document.createElement('img');
    image.src = '../assets/logo/BOBO_Arctic_Frost/favicon-16.png';
    image.alt = '';
    return image;
  }

  function renderTabs() {
    const fragment = document.createDocumentFragment();
    const groups = new Map(state.groups.map((group) => [group.id, group]));
    const labeled = new Set();

    for (const tab of state.tabs) {
      const group = groups.get(tab.groupId);
      if (group && !labeled.has(group.id)) {
        labeled.add(group.id);
        const label = document.createElement('button');
        label.type = 'button';
        label.className = 'tab-group-label';
        label.dataset.groupId = group.id;
        label.dataset.groupColor = group.color;
        label.textContent = group.name;
        label.title = `${group.name} (right-click for group options)`;
        label.setAttribute('aria-expanded', String(!group.collapsed));
        label.addEventListener('click', () => api.toggleTabGroup(group.id));
        label.addEventListener('contextmenu', (event) => {
          event.preventDefault();
          api.tabGroupMenu(group.id);
        });
        fragment.appendChild(label);
      }
      if (group?.collapsed && tab.id !== state.activeId) continue;
      const node = document.createElement('div');
      node.className = 'tab';
      node.dataset.id = String(tab.id);
      if (group) node.dataset.groupColor = group.color;
      node.draggable = true;
      node.setAttribute('role', 'tab');
      node.setAttribute('aria-selected', String(tab.id === state.activeId));
      if (tab.id === state.activeId) node.classList.add('is-active');
      if (tab.pinned) node.classList.add('is-pinned');
      node.title = tab.url ? `${tab.title}\n${tab.url}` : tab.title;

      const title = document.createElement('span');
      title.className = 'tab-title';
      title.textContent = tab.title || 'New Tab';

      node.append(tabFavicon(tab), title);

      // A speaker appears only when the tab is making sound (or is muted).
      if (tab.audible || tab.muted) {
        const mute = document.createElement('button');
        mute.type = 'button';
        mute.className = 'tab-mute';
        mute.setAttribute('aria-label', tab.muted ? 'Unmute tab' : 'Mute tab');
        mute.title = tab.muted ? 'Unmute tab' : 'Mute tab';
        mute.appendChild(icon(tab.muted ? 'i-mute' : 'i-sound'));
        node.appendChild(mute);
      }

      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'tab-close';
      close.setAttribute('aria-label', `Close ${tab.title || 'tab'}`);
      close.appendChild(icon('i-close'));

      node.appendChild(close);
      fragment.appendChild(node);
    }

    dom.tabs.replaceChildren(fragment);
  }

  // --- toolbar ------------------------------------------------------------

  function renderToolbar() {
    const tab = activeTab();
    const loading = !!tab && tab.loading;
    let youtube = false;
    try {
      const url = new URL(tab?.url);
      youtube = url.protocol === 'https:' &&
        ['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.host);
    } catch {}
    const appearance = byId('btn-youtube-appearance');
    appearance.hidden = !youtube;
    if (!appearance.disabled) appearance.value = state.browser?.youtubeTheme ?? 'default';

    dom.btnBack.disabled = !tab || !tab.canGoBack;
    dom.btnForward.disabled = !tab || !tab.canGoForward;

    const use = dom.btnReload.querySelector('use');
    use.setAttribute('href', loading ? '#i-stop' : '#i-reload');
    dom.btnReload.dataset.action = loading ? 'stop' : 'reload';
    dom.btnReload.title = loading ? 'Stop (Esc)' : 'Reload (Ctrl+R)';
    dom.btnReload.setAttribute('aria-label', loading ? 'Stop' : 'Reload');

    dom.progress.classList.toggle('is-active', loading);
  }

  function prettyUrl(value) {
    try {
      const url = new URL(value);
      const tail = (url.pathname === '/' ? '' : url.pathname) + url.search + url.hash;
      return url.host + tail;
    } catch {
      return value;
    }
  }

  function addressValue() {
    const tab = activeTab();
    return tab && tab.url ? prettyUrl(tab.url) : '';
  }

  function syncAddress() {
    if (document.activeElement === dom.input) return;
    dom.input.value = addressValue();
  }

  function syncSiteInfo() {
    const tab = activeTab();
    const url = tab && tab.url ? tab.url : '';
    const use = dom.siteInfo.querySelector('use');

    dom.siteInfo.classList.remove('is-secure', 'is-insecure');

    if (!url) {
      use.setAttribute('href', '#i-search');
      dom.siteInfo.title = 'New tab';
      return;
    }
    if (url.startsWith('https://')) {
      use.setAttribute('href', '#i-lock');
      dom.siteInfo.classList.add('is-secure');
      dom.siteInfo.title = 'Secure connection (HTTPS)';
      return;
    }
    use.setAttribute('href', '#i-warning');
    dom.siteInfo.classList.add('is-insecure');
    dom.siteInfo.title = 'Not secure (HTTP)';
  }

  function syncOmniboxPlaceholder() {
    const isDuck = state.searchEngine === 'duckduckgo';
    dom.input.placeholder = isDuck ? 'Search DuckDuckGo or type a URL' : 'Search Google or type a URL';
  }

  // --- menu & shields overlays --------------------------------------------

  function updateShieldsInfo() {
    const tab = activeTab();
    const url = tab && tab.url ? tab.url : '';
    if (!url) {
      if (dom.shieldsPageUrl) dom.shieldsPageUrl.textContent = 'New Tab (Local)';
      if (dom.shieldsConnectionDetail) dom.shieldsConnectionDetail.textContent = 'Local UI Process';
      if (dom.shieldsConnectionTag) {
        dom.shieldsConnectionTag.textContent = 'Local';
        dom.shieldsConnectionTag.className = 'shields-tag is-ok';
      }
      return;
    }

    try {
      const parsed = new URL(url);
      if (dom.shieldsPageUrl) dom.shieldsPageUrl.textContent = parsed.hostname;
      const isHttps = url.startsWith('https://');
      if (dom.shieldsConnectionDetail) {
        dom.shieldsConnectionDetail.textContent = isHttps ? 'TLS Encrypted (Strict Verification)' : 'Unencrypted HTTP Connection';
      }
      if (dom.shieldsConnectionTag) {
        dom.shieldsConnectionTag.textContent = isHttps ? 'Secure' : 'Insecure';
        dom.shieldsConnectionTag.className = `shields-tag ${isHttps ? 'is-ok' : 'is-warn'}`;
      }
    } catch {
      if (dom.shieldsPageUrl) dom.shieldsPageUrl.textContent = url;
    }
  }

  function openMenu() {
    if (menuOpen) return;
    if (shieldsOpen) closeShields();
    if (searchOpen) closeTabSearch();
    menuOpen = true;
    dom.chromeMenu.hidden = false;
    dom.btnMenu.setAttribute('aria-expanded', 'true');
    api.setOverlay(true);
    if (api.zoomLevel) {
      api.zoomLevel().then((level) => {
        if (dom.menuZoomReset) dom.menuZoomReset.textContent = `${level || 100}%`;
      }).catch(() => {});
    }
  }

  function closeMenu() {
    if (!menuOpen) return;
    menuOpen = false;
    dom.chromeMenu.hidden = true;
    dom.btnMenu.setAttribute('aria-expanded', 'false');
    if (!shieldsOpen && !searchOpen) api.setOverlay(false);
  }

  function toggleMenu() {
    if (menuOpen) closeMenu();
    else openMenu();
  }

  function openShields() {
    if (shieldsOpen) return;
    if (menuOpen) closeMenu();
    if (searchOpen) closeTabSearch();
    updateShieldsInfo();
    shieldsOpen = true;
    dom.shieldsPopup.hidden = false;
    dom.btnShields.setAttribute('aria-pressed', 'true');
    api.setOverlay(true);
  }

  function closeShields() {
    if (!shieldsOpen) return;
    shieldsOpen = false;
    dom.shieldsPopup.hidden = true;
    dom.btnShields.setAttribute('aria-pressed', 'false');
    if (!menuOpen && !searchOpen) api.setOverlay(false);
  }

  function toggleShields() {
    if (shieldsOpen) closeShields();
    else openShields();
  }

  function isBookmarksBarVisible() {
    const pref = state.browser?.bookmarks?.barVisible;
    if (pref === false || pref === 'never') return false;
    if (pref === 'newtab') {
      const tab = activeTab();
      return !tab || !tab.url || tab.url.startsWith('bobo://newtab') || tab.url.startsWith('about:blank');
    }
    return true;
  }

  function toggleBookmarksBar() {
    return setBookmarksBarMode(isBookmarksBarVisible() ? 'never' : 'always');
  }

  async function setBookmarksBarMode(next) {
    if (!state.browser) state.browser = { bookmarks: {} };
    if (!state.browser.bookmarks) state.browser.bookmarks = {};
    state.browser.bookmarks.barVisible = next;
    renderBookmarksBar();
    pushBounds();
    try {
      await api.setBrowserSettings({ bookmarks: { barVisible: next } });
    } catch {}
  }

  // --- bookmarks ----------------------------------------------------------

  function paintStar(on) {
    dom.btnStar.classList.toggle('is-on', on);
    dom.btnStar.setAttribute('aria-pressed', String(on));
    dom.btnStar.title = on ? 'Edit bookmark (Ctrl+D)' : 'Bookmark this tab (Ctrl+D)';
    dom.btnStar.setAttribute('aria-label', on ? 'Edit bookmark' : 'Bookmark this tab');
  }

  async function syncStar() {
    const tab = activeTab();
    const url = tab && tab.url ? tab.url : '';
    if (url === starUrl) return;
    starUrl = url;
    starBookmark = null;
    if (!url) {
      paintStar(false);
      return;
    }
    try {
      const found = await api.findBookmark(url);
      if (url !== starUrl) return;
      starBookmark = found;
      paintStar(!!found);
    } catch {
      if (url === starUrl) paintStar(false);
    }
  }

  function openBookmarkEditor(bookmark, isNew) {
    if (!dom.bookmarkEditorPopup) return;
    closeMenu();
    closeShields();
    closeDownloadsPopup();
    closeFolderDropdown();

    editingBookmarkId = bookmark.id;
    if (dom.bmPopupTitle) {
      dom.bmPopupTitle.textContent = isNew ? 'Bookmark added' : 'Edit bookmark';
    }
    if (dom.bmPopupName) {
      dom.bmPopupName.value = bookmark.title || '';
    }

    if (dom.bmPopupFolder && state.bookmarks) {
      dom.bmPopupFolder.innerHTML = '';
      const folders = state.bookmarks.folders || [];
      for (const f of folders) {
        const opt = document.createElement('option');
        opt.value = String(f.id);
        opt.textContent = f.name;
        if (f.id === (bookmark.folderId || 1)) opt.selected = true;
        dom.bmPopupFolder.appendChild(opt);
      }
    }

    bookmarkEditorOpen = true;
    dom.bookmarkEditorPopup.hidden = false;
    api.setOverlay(true);
    dom.bmPopupName?.focus();
    dom.bmPopupName?.select();
  }

  function closeBookmarkEditor() {
    if (!bookmarkEditorOpen) return;
    bookmarkEditorOpen = false;
    editingBookmarkId = null;
    if (dom.bookmarkEditorPopup) dom.bookmarkEditorPopup.hidden = true;
    if (!menuOpen && !shieldsOpen && !searchOpen && !downloadsOpen && !folderMenuOpen) {
      api.setOverlay(false);
    }
  }

  async function handleBookmarkEditorDone() {
    if (!editingBookmarkId) {
      closeBookmarkEditor();
      return;
    }
    const title = dom.bmPopupName ? dom.bmPopupName.value.trim() : '';
    const folderId = dom.bmPopupFolder ? Number(dom.bmPopupFolder.value) : 1;
    try {
      await api.updateBookmark({ id: editingBookmarkId, title, folderId });
      if (starBookmark) starBookmark = { ...starBookmark, title, folderId };
    } catch {}
    closeBookmarkEditor();
  }

  async function handleBookmarkEditorRemove() {
    if (!editingBookmarkId) {
      closeBookmarkEditor();
      return;
    }
    try {
      await api.removeBookmark(editingBookmarkId);
      starBookmark = null;
      paintStar(false);
    } catch {}
    closeBookmarkEditor();
  }

  async function toggleStar() {
    const tab = activeTab();
    if (!tab || !tab.url || starPending) return;

    if (bookmarkEditorOpen) {
      closeBookmarkEditor();
      return;
    }

    if (starBookmark) {
      openBookmarkEditor(starBookmark, false);
      return;
    }

    starPending = true;
    try {
      const result = await api.toggleBookmark(tab.url, tab.title);
      starBookmark = result && result.bookmarked ? result.bookmark : null;
      starUrl = tab.url;
      paintStar(!!(result && result.bookmarked));
      if (starBookmark) {
        openBookmarkEditor(starBookmark, true);
      }
    } catch {
    } finally {
      starPending = false;
    }
  }

  function byPosition(a, b) {
    return a.position - b.position || a.id - b.id;
  }

  function renderSidebarBookmarks() {
    const panel = byId('sidebar-bookmarks');
    if (panel.hidden || !state.bookmarks) return;
    const { folders, bookmarks } = state.bookmarks;
    const heading = document.createElement('h3');
    heading.className = 'side-label';
    heading.textContent = 'Bookmarks';
    function folderTree(folder) {
      const tree = document.createElement('details');
      const title = document.createElement('summary');
      title.textContent = folder.name;
      tree.append(title);
      for (const child of folders.filter(({ parentId }) => parentId === folder.id).sort(byPosition)) {
        tree.append(folderTree(child));
      }
      for (const item of bookmarks.filter(({ folderId }) => folderId === folder.id).sort(byPosition)) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'side-item';
        button.textContent = item.title;
        button.title = item.url;
        button.addEventListener('click', () => api.navigate(null, item.url));
        tree.append(button);
      }
      return tree;
    }
    panel.replaceChildren(heading, ...folders.filter(({ id }) => id === 1 || id === 2).map(folderTree));
    if (panel.children[1]) panel.children[1].open = true;
  }

  function openFolderDropdown(folder, anchorEl) {
    if (folderMenuOpen) closeFolderDropdown();
    const data = state.bookmarks;
    if (!data || !dom.bmFolderMenu) return;

    const subFolders = (data.folders || []).filter((f) => f.parentId === folder.id).sort(byPosition);
    const subItems = (data.bookmarks || []).filter((b) => b.folderId === folder.id).sort(byPosition);

    if (!subFolders.length && !subItems.length) {
      dom.bmFolderMenu.innerHTML = '<div class="bm-menu-empty">(Empty folder)</div>';
    } else {
      dom.bmFolderMenu.innerHTML = '';
      for (const sf of subFolders) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'bm-menu-item';
        item.appendChild(icon('i-folder'));
        const span = document.createElement('span');
        span.textContent = sf.name;
        item.appendChild(span);
        item.addEventListener('click', () => {
          openFolderDropdown(sf, item);
        });
        dom.bmFolderMenu.appendChild(item);
      }
      for (const b of subItems) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'bm-menu-item';
        const mark = document.createElement('span');
        mark.className = 'bm-mark';
        mark.textContent = (b.title || '?').trim().charAt(0).toUpperCase() || '?';
        const span = document.createElement('span');
        span.textContent = b.title || b.url;
        item.append(mark, span);
        item.addEventListener('click', () => {
          closeFolderDropdown();
          api.navigate(null, b.url);
        });
        dom.bmFolderMenu.appendChild(item);
      }
    }

    const rect = anchorEl.getBoundingClientRect();
    dom.bmFolderMenu.style.top = `${rect.bottom + 4}px`;
    dom.bmFolderMenu.style.left = `${Math.max(8, rect.left)}px`;
    dom.bmFolderMenu.hidden = false;
    folderMenuOpen = true;
    api.setOverlay(true);
  }

  function closeFolderDropdown() {
    if (!folderMenuOpen) return;
    folderMenuOpen = false;
    if (dom.bmFolderMenu) dom.bmFolderMenu.hidden = true;
    if (!menuOpen && !shieldsOpen && !searchOpen && !downloadsOpen && !bookmarkEditorOpen) {
      api.setOverlay(false);
    }
  }

  function renderBookmarksBar() {
    const data = state.bookmarks;
    const visible = isBookmarksBarVisible();
    if (!visible || !data) {
      dom.bookmarksBar.hidden = true;
      return;
    }

    const items = [
      ...data.folders.filter((folder) => folder.parentId === 1),
      ...data.bookmarks.filter((bookmark) => bookmark.folderId === 1),
    ].sort(byPosition);
    if (!items.length) {
      dom.bookmarksBar.hidden = true;
      return;
    }

    const fragment = document.createDocumentFragment();

    for (const item of items) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'bm-item';
      const label = document.createElement('span');
      if (item.url) {
        button.title = `${item.title}\n${item.url}`;
        const mark = document.createElement('span');
        mark.className = 'bm-mark';
        mark.textContent = (item.title || '?').trim().charAt(0).toUpperCase() || '?';
        label.textContent = item.title;
        const site = new URL(item.url);
        const asset = site.hostname === 'mail.google.com' ? 'gmail'
          : site.hostname === 'maps.google.com' || (site.hostname === 'www.google.com' && site.pathname.startsWith('/maps')) ? 'google-maps'
          : ['www.youtube.com', 'youtube.com'].includes(site.hostname) ? 'youtube' : null;
        if (asset) {
          const image = document.createElement('img');
          image.className = 'bm-favicon';
          image.alt = '';
          image.src = `../assets/google/${asset}.svg`;
          button.append(image, label);
        } else {
          button.append(mark, label);
        }
        button.addEventListener('click', () => api.navigate(null, item.url));
      } else {
        button.classList.add('bm-folder');
        button.title = item.name;
        button.setAttribute('aria-haspopup', 'menu');
        label.textContent = item.name;
        button.append(icon('i-folder'), label);
        button.addEventListener('click', () => openFolderDropdown(item, button));
      }
      fragment.appendChild(button);
    }

    const overflow = document.createElement('button');
    overflow.type = 'button';
    overflow.id = 'bookmarks-overflow';
    overflow.className = 'bm-item';
    overflow.textContent = '»';
    overflow.title = 'More bookmarks';
    overflow.setAttribute('aria-label', 'More bookmarks');
    overflow.setAttribute('aria-haspopup', 'menu');
    overflow.addEventListener('click', () => void api.openBookmarkMenu(1, Number(overflow.dataset.start)));
    fragment.appendChild(overflow);
    dom.bookmarksBar.replaceChildren(fragment);
    dom.bookmarksBar.hidden = false;
    fitBookmarksBar();
  }

  function fitBookmarksBar() {
    const bar = dom.bookmarksBar;
    const overflow = byId('bookmarks-overflow');
    if (bar.hidden || !overflow) return;
    const items = [...bar.children].slice(0, -1);
    for (const item of items) item.hidden = false;
    overflow.hidden = false;
    const style = getComputedStyle(bar);
    const gap = parseFloat(style.columnGap) || 0;
    const available = bar.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const widths = items.map((item) => item.getBoundingClientRect().width);
    const total = widths.reduce((sum, width) => sum + width, 0) + gap * (items.length - 1);
    const limit = available - overflow.getBoundingClientRect().width;
    let start = items.length;
    if (total > available) {
      let used = 0;
      start = widths.findIndex((width) => (used += width + gap) > limit);
      if (start < 0) start = items.length;
    }
    for (const item of items.slice(start)) item.hidden = true;
    overflow.hidden = start === items.length;
    overflow.dataset.start = String(start);
  }

  // --- downloads popup -----------------------------------------------------

  function updateDownloadsBadge() {
    if (!dom.downloadsBadge) return;
    const progressing = downloadsList.filter((d) => d.state === 'progressing');
    if (progressing.length > 0) {
      dom.downloadsBadge.textContent = String(progressing.length);
      dom.downloadsBadge.hidden = false;
      dom.btnDownloads?.classList.add('is-active');
    } else {
      dom.downloadsBadge.hidden = true;
      dom.btnDownloads?.classList.remove('is-active');
    }
  }

  function renderDownloadPopup() {
    if (!dom.dlPopupList || !dom.dlPopupEmpty) return;
    if (!downloadsList.length) {
      dom.dlPopupEmpty.hidden = false;
      dom.dlPopupList.hidden = true;
      return;
    }

    dom.dlPopupEmpty.hidden = true;
    dom.dlPopupList.hidden = false;
    dom.dlPopupList.innerHTML = '';

    const recent = downloadsList.slice(0, 20);
    for (const item of recent) {
      const row = document.createElement('div');
      row.className = 'dl-item';

      const iconDiv = document.createElement('div');
      iconDiv.className = 'dl-icon';
      iconDiv.appendChild(icon('i-download'));

      const info = document.createElement('div');
      info.className = 'dl-info';

      const name = document.createElement('strong');
      name.className = 'dl-filename';
      name.textContent = item.filename || 'download';
      name.title = item.path || item.filename || '';

      const meta = document.createElement('div');
      meta.className = 'dl-meta';

      const stateBadge = document.createElement('span');
      stateBadge.className = `dl-state is-${item.state}`;
      stateBadge.textContent = item.state === 'progressing' ? 'Downloading...' : item.state;

      const sizeText = document.createElement('span');
      sizeText.className = 'dl-size';
      if (item.state === 'progressing') {
        const received = Math.round((item.receivedBytes || 0) / 1024);
        const total = Math.round((item.totalBytes || 0) / 1024);
        sizeText.textContent = total > 0 ? `${received} KB / ${total} KB` : `${received} KB`;
      } else if (item.totalBytes) {
        sizeText.textContent = `${Math.round(item.totalBytes / 1024)} KB`;
      }
      meta.append(stateBadge, sizeText);

      info.append(name, meta);

      if (item.state === 'progressing') {
        const barWrap = document.createElement('div');
        barWrap.className = 'dl-progress-bar';
        const barFill = document.createElement('div');
        barFill.className = 'dl-progress-fill';
        const pct = item.totalBytes > 0 ? Math.round((item.receivedBytes / item.totalBytes) * 100) : 50;
        barFill.style.width = `${pct}%`;
        barWrap.appendChild(barFill);
        info.appendChild(barWrap);
      }

      const actions = document.createElement('div');
      actions.className = 'dl-actions';

      if (item.state === 'completed') {
        const openBtn = document.createElement('button');
        openBtn.type = 'button';
        openBtn.className = 'btn-subtle';
        openBtn.textContent = 'Open';
        openBtn.title = 'Open file';
        openBtn.addEventListener('click', () => api.openDownload(item.id));

        const folderBtn = document.createElement('button');
        folderBtn.type = 'button';
        folderBtn.className = 'btn-subtle';
        folderBtn.textContent = 'Folder';
        folderBtn.title = 'Show in folder';
        folderBtn.addEventListener('click', () => api.showDownload(item.id));

        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'btn-subtle';
        copyBtn.textContent = 'Copy';
        copyBtn.title = 'Copy file path';
        copyBtn.addEventListener('click', () => api.copyDownloadPath(item.id));

        actions.append(openBtn, folderBtn, copyBtn);
      }

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'btn-subtle dl-remove';
      removeBtn.innerHTML = '&times;';
      removeBtn.title = 'Remove from list';
      removeBtn.addEventListener('click', () => api.removeDownload(item.id));
      actions.appendChild(removeBtn);

      row.append(iconDiv, info, actions);
      dom.dlPopupList.appendChild(row);
    }
  }

  function openDownloadsPopup() {
    if (downloadsOpen) return;
    closeMenu();
    closeShields();
    closeTabSearch();
    closeBookmarkEditor();
    closeFolderDropdown();

    downloadsOpen = true;
    if (dom.downloadPopup) dom.downloadPopup.hidden = false;
    dom.btnDownloads?.setAttribute('aria-expanded', 'true');
    api.setOverlay(true);
    renderDownloadPopup();
  }

  function closeDownloadsPopup() {
    if (!downloadsOpen) return;
    downloadsOpen = false;
    if (dom.downloadPopup) dom.downloadPopup.hidden = true;
    dom.btnDownloads?.setAttribute('aria-expanded', 'false');
    if (!menuOpen && !shieldsOpen && !searchOpen && !bookmarkEditorOpen && !folderMenuOpen) {
      api.setOverlay(false);
    }
  }

  function toggleDownloadsPopup() {
    if (downloadsOpen) closeDownloadsPopup();
    else openDownloadsPopup();
  }

  // --- tab search ---------------------------------------------------------

  function tabSearchMatches() {
    const query = dom.tabSearchInput.value.trim().toLowerCase();
    return state.tabs.filter(
      (tab) =>
        !query ||
        (tab.title || '').toLowerCase().includes(query) ||
        (tab.url || '').toLowerCase().includes(query)
    );
  }

  function renderTabSearch() {
    const matches = tabSearchMatches();
    const fragment = document.createDocumentFragment();

    matches.forEach((tab, index) => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `tab-search-item${index === 0 ? ' is-first' : ''}`;
      button.dataset.id = String(tab.id);

      const mark = document.createElement('span');
      mark.className = 'bm-mark';
      mark.textContent = (tab.title || '?').trim().charAt(0).toUpperCase() || '?';
      const text = document.createElement('span');
      text.className = 'tab-search-text';
      const title = document.createElement('strong');
      title.textContent = tab.title || 'New Tab';
      const url = document.createElement('small');
      url.textContent = tab.url || 'BOBO page';
      text.append(title, url);
      if (tab.pinned) {
        const pin = document.createElement('span');
        pin.className = 'tab-search-pin';
        pin.textContent = 'Pinned';
        text.appendChild(pin);
      }

      button.append(mark, text);
      button.addEventListener('click', () => {
        closeTabSearch();
        api.selectTab(tab.id);
      });
      item.appendChild(button);
      fragment.appendChild(item);
    });

    if (!matches.length) {
      const empty = document.createElement('li');
      empty.className = 'tab-search-empty';
      empty.textContent = 'No open tab matches that.';
      fragment.appendChild(empty);
    }

    dom.tabSearchList.replaceChildren(fragment);
  }

  function openTabSearch() {
    if (searchOpen) {
      dom.tabSearchInput.select();
      return;
    }
    searchOpen = true;
    dom.tabSearch.hidden = false;
    dom.tabSearchInput.value = '';
    renderTabSearch();
    api.setOverlay(true);
    dom.tabSearchInput.focus();
  }

  function closeTabSearch() {
    if (!searchOpen) return;
    searchOpen = false;
    dom.tabSearch.hidden = true;
    api.setOverlay(false);
  }

  function render() {
    renderTabs();
    renderToolbar();
    syncAddress();
    syncSiteInfo();
    syncOmniboxPlaceholder();
    renderBookmarksBar();
    syncStar();
    if (searchOpen) renderTabSearch();
  }

  // --- content bounds -----------------------------------------------------

  function pushBounds() {
    const rect = dom.viewport.getBoundingClientRect();
    const bounds = {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
    const key = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
    if (key === lastBounds) return;
    lastBounds = key;
    api.setBounds(bounds).catch(() => {});
  }

  // --- theme --------------------------------------------------------------

  function applyTheme(value, notifyMain) {
    const next = value === 'light' ? 'light' : 'dark';
    if (next === theme) return;

    theme = next;
    document.documentElement.dataset.theme = next;

    const label = next === 'dark' ? 'Light theme' : 'Dark theme';
    const glyph = next === 'dark' ? '#i-sun' : '#i-moon';
    if (dom.themeLabel) dom.themeLabel.textContent = label;
    if (dom.themeUse) dom.themeUse.setAttribute('href', glyph);
    document
      .querySelectorAll('[data-theme-label]')
      .forEach((node) => (node.textContent = label));

    if (notifyMain) api.setTheme(next);
  }

  function toggleTheme() {
    applyTheme(theme === 'dark' ? 'light' : 'dark', true);
  }

  // --- sidebar ------------------------------------------------------------

  function setSidebar(open) {
    sidebarOpen = open;
    document.body.classList.toggle('sidebar-collapsed', !open);
    dom.sidebar.inert = !open; // collapsed panel must not take keyboard focus
    dom.btnSidebar.setAttribute('aria-pressed', String(open));
    dom.btnSidebar.title = open ? 'Hide BOBO panel' : 'Show BOBO panel';
    localStorage.setItem('bobo:sidebar-open', String(open));
    pushBounds();
  }

  // --- actions ------------------------------------------------------------

  const actions = {
    back: () => api.back(null),
    forward: () => api.forward(null),
    reload: () => api.reload(null),
    stop: () => api.stop(null),
    home: () => api.home(null),
    'new-tab': () => api.createTab(),
    theme: toggleTheme,
    sidebar: () => setSidebar(!sidebarOpen),
    library: (target) => api.openLibrary(target.dataset.view || 'bookmarks'),
    'menu-new-tab': () => { closeMenu(); api.createTab(); },
    'menu-new-window': () => { closeMenu(); api.newWindow?.(); },
    'menu-recently-closed': () => { closeMenu(); api.recentlyClosedTabs(); },
    'menu-bookmarks': () => { closeMenu(); void api.openBookmarkMenu(); },
    'menu-import-bookmarks': async () => {
      closeMenu();
      try {
        const result = await api.importBookmarks();
        if (!result.canceled) await api.openLibrary('bookmarks');
      } catch (error) {
        window.alert(error.message);
      }
    },
    'menu-history': () => { closeMenu(); api.openLibrary('history'); },
    'menu-downloads': () => { closeMenu(); api.openLibrary('downloads'); },
    'menu-passwords': () => { closeMenu(); api.openSettings?.('passwords'); },
    'menu-tools': () => { closeMenu(); byId('btn-tools')?.click(); },
    'menu-profiles': () => { closeMenu(); void api.openProfiles(); },
    'menu-print': () => { closeMenu(); api.printPage?.(); },
    'menu-find': openFind,
    'saved-groups': () => api.openSettings('tabs'),
    'menu-shields': () => { closeMenu(); openShields(); },
    'menu-permissions': () => { closeMenu(); api.openSettings?.('permissions') || api.openLibrary('bookmarks'); },
    'menu-clear-data': () => { closeMenu(); api.clearPrivacy('all'); },
    'menu-settings': () => { closeMenu(); api.openSettings?.('search'); },
    'menu-about': () => { closeMenu(); api.openSettings?.('about'); },
    'menu-exit': () => { closeMenu(); api.quitApp?.(); },
  };

  document.addEventListener('click', (event) => {
    if (event.target.closest('#chrome-menu [data-tool-open]')) closeMenu();
    const link = event.target.closest('[data-url]');
    if (link) {
      api.navigate(null, link.dataset.url);
      return;
    }
    const target = event.target.closest('[data-action]');
    if (!target || target.disabled) return;
    const run = actions[target.dataset.action];
    if (run) run(target);
  });

  // Tab strip: click selects, middle-click and the ✕ close, right-click asks
  // the main process for a native tab menu, and drag reorders.
  dom.tabs.addEventListener('click', (event) => {
    const node = event.target.closest('.tab');
    if (!node) return;
    const id = Number(node.dataset.id);
    if (event.target.closest('.tab-mute')) api.muteTab(id);
    else if (event.target.closest('.tab-close')) api.closeTab(id);
    else {
      closeTabSearch();
      api.selectTab(id);
    }
  });

  dom.tabs.addEventListener('auxclick', (event) => {
    if (event.button !== 1) return;
    const node = event.target.closest('.tab');
    if (node) api.closeTab(Number(node.dataset.id));
  });

  dom.tabs.addEventListener('contextmenu', (event) => {
    const node = event.target.closest('.tab');
    if (!node) return;
    event.preventDefault();
    api.tabMenu(Number(node.dataset.id));
  });

  dom.tabs.addEventListener('dragstart', (event) => {
    const node = event.target.closest('.tab');
    if (!node) return;
    dragId = Number(node.dataset.id);
    dragCancelled = false;
    node.classList.add('is-dragging');
    try {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', node.dataset.id);
    } catch {
      // Some drag sources reject setData; the drag itself still works.
    }
  });

  dom.tabs.addEventListener('dragover', (event) => {
    if (dragId == null) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  });

  dom.tabs.addEventListener('drop', (event) => {
    if (dragId == null) return;
    event.preventDefault();
    const node = event.target.closest('.tab');
    let index = state.tabs.length;
    if (node) {
      const rect = node.getBoundingClientRect();
      const position = state.tabs.findIndex((tab) => tab.id === Number(node.dataset.id));
      index = position + (event.clientX > rect.left + rect.width / 2 ? 1 : 0);
    }
    const moved = dragId;
    dragId = null;
    api.moveTab(moved, index);
  });

  window.addEventListener('keydown', event => { if (event.key === 'Escape') dragCancelled = true; });
  dom.tabs.addEventListener('dragend', (event) => {
    const id = dragId;
    const strip = dom.tabs.getBoundingClientRect();
    if (id != null && !dragCancelled && event.dataTransfer?.dropEffect === 'none' &&
        (event.screenX || event.screenY) &&
        (event.clientY > strip.bottom + 36 || event.clientY < -36 || event.clientX < -36 || event.clientX > innerWidth + 36)) {
      void api.detachTab(id).catch(error => console.error('Could not detach tab:', error));
    }
    dragId = null;
    dom.tabs.querySelectorAll('.is-dragging').forEach((node) => node.classList.remove('is-dragging'));
  });

  dom.btnStar.addEventListener('click', toggleStar);
  dom.btnShields?.addEventListener('click', toggleShields);
  dom.btnDownloads?.addEventListener('click', toggleDownloadsPopup);
  dom.dlPopupClear?.addEventListener('click', () => api.clearDownloads());
  dom.dlPopupShowAll?.addEventListener('click', () => {
    closeDownloadsPopup();
    api.openLibrary('downloads');
  });
  dom.bmPopupDone?.addEventListener('click', handleBookmarkEditorDone);
  dom.bmPopupRemove?.addEventListener('click', handleBookmarkEditorRemove);
  dom.btnMenu?.addEventListener('click', toggleMenu);

  dom.menuZoomIn?.addEventListener('click', () => {
    api.zoomIn?.().then((level) => {
      if (dom.menuZoomReset) dom.menuZoomReset.textContent = `${level}%`;
    }).catch(() => {});
  });
  dom.menuZoomOut?.addEventListener('click', () => {
    api.zoomOut?.().then((level) => {
      if (dom.menuZoomReset) dom.menuZoomReset.textContent = `${level}%`;
    }).catch(() => {});
  });
  dom.menuZoomReset?.addEventListener('click', () => {
    api.zoomReset?.().then((level) => {
      if (dom.menuZoomReset) dom.menuZoomReset.textContent = `${level}%`;
    }).catch(() => {});
  });
  dom.menuFullscreen?.addEventListener('click', () => {
    api.toggleFullScreen?.();
    closeMenu();
  });

  dom.shieldsBtnPerms?.addEventListener('click', () => {
    closeShields();
    api.openSettings?.('permissions') || api.openLibrary('bookmarks');
  });
  dom.shieldsBtnClear?.addEventListener('click', () => {
    closeShields();
    api.clearPrivacy('all');
  });

  // Bookmarks bar right-click menu: toggle bar or manager
  dom.bookmarksBar?.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    const item = event.target.closest('.bm-item');
    if (item) {
      api.openLibrary('bookmarks');
    } else {
      toggleBookmarksBar();
    }
  });

  // Close overlays on outside click
  document.addEventListener('click', (event) => {
    if (menuOpen && !event.target.closest('#chrome-menu') && !event.target.closest('#btn-menu')) {
      closeMenu();
    }
    if (shieldsOpen && !event.target.closest('#shields-popup') && !event.target.closest('#btn-shields')) {
      closeShields();
    }
    if (downloadsOpen && !event.target.closest('#download-popup') && !event.target.closest('#btn-downloads')) {
      closeDownloadsPopup();
    }
    if (bookmarkEditorOpen && !event.target.closest('#bookmark-editor-popup') && !event.target.closest('#btn-star')) {
      closeBookmarkEditor();
    }
    if (folderMenuOpen && !event.target.closest('#bm-folder-menu') && !event.target.closest('.bm-folder')) {
      closeFolderDropdown();
    }
  });

  // --- tab search overlay -------------------------------------------------

  dom.tabSearchInput.addEventListener('input', renderTabSearch);

  dom.tabSearchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeTabSearch();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const first = tabSearchMatches()[0];
      if (first) {
        closeTabSearch();
        api.selectTab(first.id);
      }
    }
  });

  dom.tabSearch.addEventListener('mousedown', (event) => {
    if (event.target === dom.tabSearch) closeTabSearch();
  });

  // --- address bar --------------------------------------------------------

  const closeAddressSuggestions = window.bindSearchSuggestions(dom.input, byId('omnibox-suggestions'), api,
    (url) => { api.navigate(null, url); dom.input.blur(); }, pushBounds);
  byId('btn-page-zoom').addEventListener('click', () => void api.zoomReset());
  byId('btn-youtube-appearance').addEventListener('change', async (event) => {
    const control = event.currentTarget;
    control.disabled = true;
    try {
      const mode = await api.setYouTubeTheme(control.value);
      state.browser = { ...state.browser, youtubeTheme: mode };
    } catch (error) {
      window.alert(error.message);
    } finally {
      control.disabled = false;
      renderToolbar();
    }
  });

  dom.input.addEventListener('focus', () => {
    dom.omnibox.classList.add('is-focused');
    dom.input.select();
  });

  dom.input.addEventListener('blur', () => {
    dom.omnibox.classList.remove('is-focused');
    syncAddress();
  });

  dom.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      const text = dom.input.value.trim();
      if (text) {
        api.navigate(null, text);
        dom.input.blur();
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      dom.input.value = addressValue();
      dom.input.blur();
    }
  });

  // --- wiring -------------------------------------------------------------

  const findRow = byId('find-bar-row');
  const findInput = byId('find-input');
  const findCount = byId('find-count');
  const findCase = byId('find-case');
  let findToken = 0;

  function openFind() {
    closeMenu();
    closeShields();
    closeDownloadsPopup();
    closeBookmarkEditor();
    closeFolderDropdown();
    closeTabSearch();
    if (findRow.hidden) {
      findRow.hidden = false;
      pushBounds();
      api.setFindVisibility(true);
      searchPage();
    }
    findInput.focus();
    findInput.select();
  }

  function closeFind(restoreFocus = false) {
    if (findRow.hidden) return;
    findRow.hidden = true;
    findToken++;
    api.stopFindInPage(state.activeId);
    pushBounds();
    api.setFindVisibility(false, restoreFocus);
  }

  function searchPage(advance = false, forward = true) {
    const token = ++findToken;
    if (!advance) findCount.textContent = '';
    if (!findInput.value.trim()) {
      api.stopFindInPage(state.activeId);
      return;
    }
    api.findInPage({
      id: state.activeId,
      token,
      text: findInput.value,
      matchCase: findCase.checked,
      advance,
      forward,
    });
  }

  findInput.addEventListener('input', () => searchPage());
  findCase.addEventListener('change', () => searchPage());
  byId('find-prev').addEventListener('click', () => searchPage(true, false));
  byId('find-next').addEventListener('click', () => searchPage(true));
  byId('find-close').addEventListener('click', () => closeFind(true));
  findRow.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing || event.target !== findInput) return;
    event.preventDefault();
    searchPage(true, !event.shiftKey);
  });
  api.onFindResult((result) => {
    if (findRow.hidden || result.tabId !== state.activeId) return;
    if (result.reset) {
      closeFind();
    } else if (result.token === findToken) {
      findCount.textContent = result.matches
        ? `${result.activeMatchOrdinal} / ${result.matches}`
        : 'No matches';
    }
  });

  api.onTabs((snapshot) => {
    if (!snapshot || !Array.isArray(snapshot.tabs)) return;
    const zoom = snapshot.zoom ?? 100;
    if (dom.menuZoomReset) dom.menuZoomReset.textContent = `${zoom}%`;
    const indicator = byId('btn-page-zoom');
    indicator.textContent = `${zoom}%`;
    indicator.hidden = zoom === 100;
    indicator.setAttribute('aria-label', `Page zoom ${zoom}%. Reset to 100%`);
    const changedTab = state.activeId !== snapshot.activeId;
    if (changedTab || activeTab()?.url !== snapshot.tabs.find((tab) => tab.id === snapshot.activeId)?.url) {
      closeAddressSuggestions();
    }
    if (changedTab) closeFind();
    state.activeId = snapshot.activeId;
    state.tabs = snapshot.tabs;
    state.groups = snapshot.groups || [];
    render();
    if (changedTab && activeTab()?.groupId) {
      const label = [...dom.tabs.querySelectorAll('.tab-group-label')]
        .find((node) => node.dataset.groupId === activeTab().groupId);
      label?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  });

  api.onTheme((value) => applyTheme(value, false));

  api.onBookmarks((data) => {
    if (!data || !Array.isArray(data.bookmarks)) return;
    state.bookmarks = data;
    renderBookmarksBar();
    renderSidebarBookmarks();
    syncStar();
  });

  api.onSettings((payload) => {
    if (!payload || !payload.browser) return;
    state.browser = payload.browser;
    renderToolbar();
    renderBookmarksBar();
  });

  const renameGroupDialog = byId('rename-group-dialog');
  const renameGroupName = byId('rename-group-name');
  let renamingGroupId;
  renameGroupDialog.addEventListener('close', () => {
    if (renameGroupDialog.returnValue === 'save' && renameGroupName.value.trim()) {
      void api.updateTabGroup(renamingGroupId, { name: renameGroupName.value.trim() }).catch(() => {});
    }
    renamingGroupId = null;
    void api.setOverlay(false);
  });

  api.onUi((command) => {
    if (command?.action === 'rename-group' && !renameGroupDialog.open) {
      renamingGroupId = command.groupId;
      renameGroupName.value = command.name;
      renameGroupDialog.returnValue = '';
      void api.setOverlay(true);
      renameGroupDialog.showModal();
      renameGroupName.select();
      return;
    }
    if (command === 'find-in-page') openFind();
    if (command === 'find-close') closeFind(true);
    if (command === 'find-next' || command === 'find-prev') {
      if (findRow.hidden) openFind();
      else searchPage(true, command === 'find-next');
    }
    if (command === 'focus-omnibox') {
      dom.input.focus();
      dom.input.select();
      return;
    }
    if (command === 'tab-search') openTabSearch();
    if (command === 'toggle-bookmarks-bar') toggleBookmarksBar();
    if (command === 'bookmark-page') dom.btnStar.click();
    if (command === 'bookmarks-import') void actions['menu-import-bookmarks']();
    if (command === 'bookmarks-bar-always') void setBookmarksBarMode('always');
    if (command === 'bookmarks-bar-newtab') void setBookmarksBarMode('newtab');
    if (command === 'bookmarks-bar-never') void setBookmarksBarMode('never');
    if (command === 'bookmarks-side-panel') {
      const panel = byId('sidebar-bookmarks');
      panel.hidden = sidebarOpen && !panel.hidden;
      if (!panel.hidden) setSidebar(true);
      renderSidebarBookmarks();
    }
    if (command === 'clear-browsing-data') api.clearPrivacy('all');
    if (command === 'new-private-window') {
      alert('Private browsing is unavailable in this build.');
    }
  });

  api.onDownloads((list) => {
    downloadsList = Array.isArray(list) ? list : [];
    updateDownloadsBadge();
    if (downloadsOpen) renderDownloadPopup();
  });

  window.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && (event.key === 'B' || event.key === 'b')) {
      event.preventDefault();
      toggleBookmarksBar();
      return;
    }
    if (event.key === 'Escape') {
      if (downloadsOpen) {
        event.preventDefault();
        closeDownloadsPopup();
        return;
      }
      if (bookmarkEditorOpen) {
        event.preventDefault();
        closeBookmarkEditor();
        return;
      }
      if (folderMenuOpen) {
        event.preventDefault();
        closeFolderDropdown();
        return;
      }
      if (menuOpen) {
        event.preventDefault();
        closeMenu();
        return;
      }
      if (shieldsOpen) {
        event.preventDefault();
        closeShields();
        return;
      }
      if (searchOpen) {
        event.preventDefault();
        closeTabSearch();
        return;
      }
      if (!findRow.hidden && event.target !== dom.input) {
        event.preventDefault();
        closeFind(true);
      }
    }
  });

  const observer = new ResizeObserver(pushBounds);
  new ResizeObserver(fitBookmarksBar).observe(dom.bookmarksBar);
  observer.observe(dom.viewport);
  window.addEventListener('resize', pushBounds);

  setSidebar(sidebarOpen);

  api.getState()
    .then((payload) => {
      if (!payload || !payload.tabs) return;
      state.activeId = payload.tabs.activeId;
      state.tabs = payload.tabs.tabs;
      state.groups = payload.tabs.groups || [];
      if (payload.profile?.name) byId('current-profile-name').textContent = payload.profile.name;
      applyTheme(payload.theme, false);
      render();
      pushBounds();
    })
    .catch(() => {
      // Main process will push state; nothing to do here.
    });

  Promise.all([
    api.listBookmarks().catch(() => null),
    api.browserSettings().catch(() => null),
    api.toolsState ? api.toolsState().catch(() => null) : Promise.resolve(null),
    api.listDownloads ? api.listDownloads().catch(() => null) : Promise.resolve(null),
  ]).then(([bookmarks, browser, toolsState, downloads]) => {
    if (bookmarks) state.bookmarks = bookmarks;
    if (browser) state.browser = browser;
    if (toolsState?.search?.engine) state.searchEngine = toolsState.search.engine;
    if (Array.isArray(downloads)) {
      downloadsList = downloads;
      updateDownloadsBadge();
    }
    renderBookmarksBar();
    syncOmniboxPlaceholder();
  });
})();
