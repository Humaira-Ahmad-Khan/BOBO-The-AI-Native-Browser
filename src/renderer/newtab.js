'use strict';

/**
 * BOBO New Tab Page — Chrome-style layout, local attachments and the
 * Google services shortcut launcher.
 *
 * Runs locally: no remote fonts, scripts or network requests. Shortcuts,
 * background and launcher preferences persist through BOBO's own storage.
 */

(() => {
  const api = window.bobo;
  const form = document.getElementById('search-form');
  const input = document.getElementById('q');
  const grid = document.getElementById('shortcuts-grid');
  const statusRegion = document.getElementById('newtab-status');

  // Background layers
  const bgLayer = document.getElementById('newtab-bg-layer');
  const scrimLayer = document.getElementById('newtab-scrim');

  // Floating customize button & dialog
  const btnCustomizeBg = document.getElementById('btn-customize-bg');
  const customizeDialog = document.getElementById('customize-dialog');
  const customizeCloseBtn = document.getElementById('customize-close-btn');
  const customizeDoneBtn = document.getElementById('customize-done-btn');
  const bgPresetDefault = document.getElementById('bg-preset-default');
  const bgCustomColor = document.getElementById('bg-custom-color');
  const bgFileInput = document.getElementById('bg-file-input');
  const bgImagePreviewWrap = document.getElementById('bg-image-preview-wrap');
  const bgImagePreview = document.getElementById('bg-image-preview');
  const bgImageRemove = document.getElementById('bg-image-remove');
  const btnResetShortcutsModal = document.getElementById('btn-reset-shortcuts-modal');

  // Add/Edit Shortcut Dialog
  const shortcutDialog = document.getElementById('shortcut-dialog');
  const modalForm = document.getElementById('shortcut-form');
  const modalTitle = document.getElementById('modal-title');
  const modalName = document.getElementById('modal-name');
  const modalUrl = document.getElementById('modal-url');
  const modalDelete = document.getElementById('modal-delete');
  const modalCancel = document.getElementById('modal-cancel');
  const modalCloseX = document.getElementById('modal-close-x');

  let editIndex = null;
  let theme = 'dark';
  let searchEngine = 'google';

  // --- local status line ----------------------------------------------------

  let statusTimer = null;

  function setStatus(message) {
    if (!statusRegion) return;
    statusRegion.textContent = message;
    statusRegion.classList.add('is-visible');
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      statusRegion.classList.remove('is-visible');
      statusRegion.textContent = '';
    }, 4200);
  }

  // Authentic brand logo SVGs located in src/assets/shortcuts/
  const DEFAULT_SHORTCUTS = [
    { title: 'WhatsApp', url: 'https://web.whatsapp.com/', iconSrc: '../assets/shortcuts/whatsapp.svg' },
    { title: 'Facebook', url: 'https://www.facebook.com/', iconSrc: '../assets/shortcuts/facebook.svg' },
    { title: 'LinkedIn', url: 'https://www.linkedin.com/', iconSrc: '../assets/shortcuts/linkedin.svg' },
    { title: 'YouTube', url: 'https://www.youtube.com/', iconSrc: '../assets/shortcuts/youtube.svg' },
    { title: 'GitHub', url: 'https://github.com/', iconSrc: '../assets/shortcuts/github.svg' },
    { title: 'DuckDuckGo', url: 'https://duckduckgo.com/', iconSrc: '../assets/shortcuts/duckduckgo.svg' },
  ];

  // --- Shortcut Storage & Helpers ------------------------------------------

  function getShortcuts() {
    try {
      const stored = localStorage.getItem('bobo:custom-shortcuts');
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch {}
    return DEFAULT_SHORTCUTS.slice();
  }

  function saveShortcuts(list) {
    try {
      localStorage.setItem('bobo:custom-shortcuts', JSON.stringify(list));
    } catch {}
    renderShortcuts();
  }

  function getRowCount() {
    try {
      const stored = localStorage.getItem('bobo:newtab-rows');
      const val = parseInt(stored, 10);
      if (val === 1 || val === 2 || val === 3) return val;
    } catch {}
    return 2; // Default 2 rows (fits default 6 shortcuts + Add button nicely)
  }

  function setRowCount(rows) {
    try {
      localStorage.setItem('bobo:newtab-rows', String(rows));
    } catch {}
    renderShortcuts();
  }

  function resolveIconSrc(item) {
    if (item.iconSrc) return item.iconSrc;
    try {
      const host = new URL(item.url).hostname.replace(/^www\./, '');
      const brands = {
        'whatsapp.com': 'whatsapp', 'web.whatsapp.com': 'whatsapp',
        'facebook.com': 'facebook', 'linkedin.com': 'linkedin', 'youtube.com': 'youtube',
        'github.com': 'github', 'duckduckgo.com': 'duckduckgo',
        'instagram.com': 'instagram', 'x.com': 'x', 'twitter.com': 'x',
      };
      if (Object.hasOwn(brands, host)) return `../assets/shortcuts/${brands[host]}.svg`;
    } catch {}
    return null;
  }

  const faviconRequests = new Map();
  function loadShortcutFavicon(item, wrapper) {
    let origin;
    try { origin = new URL(item.url).origin; } catch { return; }
    if (!origin.startsWith('https://')) return;
    const key = 'bobo:shortcut-favicons';
    const readCache = () => {
      try { return JSON.parse(localStorage.getItem(key)) || {}; } catch { return {}; }
    };
    const paint = (src) => {
      if (!src || !wrapper.isConnected) return;
      const img = document.createElement('img');
      img.className = 'tile-icon-img';
      img.width = img.height = 28;
      img.alt = '';
      img.addEventListener('load', () => wrapper.replaceChildren(img), { once: true });
      img.src = src;
    };
    const cached = readCache()[origin];
    if (cached) { queueMicrotask(() => paint(cached)); return; }
    if (!api?.shortcutIcon) return;
    if (!faviconRequests.has(origin)) {
      faviconRequests.set(origin, api.shortcutIcon(origin).then((src) => {
        if (src) {
          try {
            const entries = [...Object.entries(readCache()).filter(([host]) => host !== origin), [origin, src]];
            localStorage.setItem(key, JSON.stringify(Object.fromEntries(entries.slice(-32))));
          } catch {}
        }
        return src;
      }).catch(() => null).finally(() => faviconRequests.delete(origin)));
    }
    void faviconRequests.get(origin).then(paint);
  }

  // --- Shortcut Rendering --------------------------------------------------

  function renderShortcuts() {
    const list = getShortcuts();
    const rows = getRowCount();
    const maxSlots = rows * 6; // 6 columns per row

    grid.replaceChildren();

    // Determine how many shortcuts to display so Add button fits within limit
    const itemsToShow = list.slice(0, Math.max(0, maxSlots - 1));

    itemsToShow.forEach((item, index) => {
      const tile = document.createElement('div');
      tile.className = 'chrome-shortcut-tile';

      const linkBtn = document.createElement('button');
      linkBtn.type = 'button';
      linkBtn.className = 'tile-main-btn';
      linkBtn.title = `${item.title}\n${item.url}`;

      const iconWrap = document.createElement('div');
      iconWrap.className = 'tile-icon-circle';

      const iconSrc = resolveIconSrc(item);
      if (iconSrc) {
        const img = document.createElement('img');
        img.src = iconSrc;
        img.alt = item.title;
        img.className = 'tile-icon-img';
        img.width = 28;
        img.height = 28;
        iconWrap.appendChild(img);
      } else {
        // Fallback: stylish initial letter badge or globe
        const initial = (item.title || 'W').charAt(0).toUpperCase();
        const letterSpan = document.createElement('span');
        letterSpan.className = 'tile-fallback-letter';
        letterSpan.textContent = initial;
        iconWrap.appendChild(letterSpan);
        loadShortcutFavicon(item, iconWrap);
      }

      const label = document.createElement('span');
      label.className = 'tile-title';
      label.textContent = item.title;

      linkBtn.append(iconWrap, label);
      linkBtn.addEventListener('click', () => {
        if (api) api.navigate(null, item.url);
      });

      // Edit / menu trigger button (3-dot)
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'tile-edit-btn';
      editBtn.title = 'Edit shortcut';
      editBtn.setAttribute('aria-label', `Edit ${item.title}`);
      const editSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      const editUse = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      editUse.setAttribute('href', '#newtab-more');
      editSvg.appendChild(editUse);
      editBtn.appendChild(editSvg);
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditModal(index);
      });

      tile.append(linkBtn, editBtn);
      grid.appendChild(tile);
    });

    // Add Shortcut Tile (always placed after the visible items)
    const addTile = document.createElement('div');
    addTile.className = 'chrome-shortcut-tile add-tile';
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'tile-main-btn';
    addBtn.title = 'Add shortcut';

    const addIconWrap = document.createElement('div');
    addIconWrap.className = 'tile-icon-circle add-icon';
    const addSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const addUse = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    addUse.setAttribute('href', '#newtab-plus');
    addSvg.appendChild(addUse);
    addIconWrap.appendChild(addSvg);

    const addLabel = document.createElement('span');
    addLabel.className = 'tile-title';
    addLabel.textContent = 'Add shortcut';

    addBtn.append(addIconWrap, addLabel);
    addBtn.addEventListener('click', openAddModal);
    addTile.appendChild(addBtn);
    grid.appendChild(addTile);
  }

  // --- Add / Edit Shortcut Modal -------------------------------------------

  function openAddModal() {
    editIndex = null;
    modalTitle.textContent = 'Add Shortcut';
    modalName.value = '';
    modalUrl.value = 'https://';
    modalDelete.hidden = true;
    shortcutDialog.showModal();
    modalName.focus();
  }

  function openEditModal(index) {
    editIndex = index;
    const list = getShortcuts();
    const item = list[index];
    if (!item) return;
    modalTitle.textContent = 'Edit Shortcut';
    modalName.value = item.title;
    modalUrl.value = item.url;
    modalDelete.hidden = false;
    shortcutDialog.showModal();
    modalName.focus();
  }

  if (modalCancel) modalCancel.addEventListener('click', () => shortcutDialog.close());
  if (modalCloseX) modalCloseX.addEventListener('click', () => shortcutDialog.close());

  if (modalDelete) {
    modalDelete.addEventListener('click', () => {
      if (editIndex != null) {
        const list = getShortcuts();
        list.splice(editIndex, 1);
        saveShortcuts(list);
        shortcutDialog.close();
      }
    });
  }

  if (modalForm) {
    modalForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = modalName.value.trim();
      let url = modalUrl.value.trim();
      if (!name || !url) return;
      if (!/^https?:\/\//i.test(url)) url = `https://${url}`;

      const list = getShortcuts();
      if (editIndex != null) {
        list[editIndex] = { ...list[editIndex], title: name, url };
      } else {
        list.push({ title: name, url });
      }
      saveShortcuts(list);
      shortcutDialog.close();
    });
  }

  // --- Background Customization --------------------------------------------

  const DEFAULT_BG_ASSET = '../assets/logo/BOBO_Arctic_Frost/BOBO_Arctic_Frost_Full_Logo.png';

  function getBackgroundConfig() {
    try {
      const stored = localStorage.getItem('bobo:newtab-bg');
      if (stored) return JSON.parse(stored);
    } catch {}
    return { type: 'default' };
  }

  function applyBackground(cfg) {
    if (!bgLayer || !scrimLayer) return;

    if (!cfg || cfg.type === 'default') {
      bgLayer.style.background = '';
      bgLayer.style.backgroundImage = `url("${DEFAULT_BG_ASSET}")`;
      bgLayer.style.backgroundSize = 'cover';
      bgLayer.style.backgroundPosition = 'center';
      bgLayer.style.backgroundRepeat = 'no-repeat';
      scrimLayer.classList.add('is-active');
      document.body.classList.remove('has-custom-bg');
      if (bgImagePreviewWrap) bgImagePreviewWrap.hidden = true;
      highlightActivePreset('default');
      return;
    }

    if (cfg.type === 'color') {
      bgLayer.style.background = cfg.value;
      bgLayer.style.backgroundImage = '';
      scrimLayer.classList.remove('is-active');
      document.body.classList.add('has-custom-bg');
      highlightActivePreset('color', cfg.value);
    } else if (cfg.type === 'gradient') {
      bgLayer.style.background = cfg.value;
      scrimLayer.classList.remove('is-active');
      document.body.classList.add('has-custom-bg');
      highlightActivePreset('gradient', cfg.value);
    } else if (cfg.type === 'image') {
      bgLayer.style.background = '';
      bgLayer.style.backgroundImage = `url("${cfg.value}")`;
      bgLayer.style.backgroundSize = 'cover';
      bgLayer.style.backgroundPosition = 'center';
      bgLayer.style.backgroundRepeat = 'no-repeat';
      scrimLayer.classList.add('is-active');
      document.body.classList.add('has-custom-bg');
      if (bgImagePreview) bgImagePreview.src = cfg.value;
      if (bgImagePreviewWrap) bgImagePreviewWrap.hidden = false;
      highlightActivePreset('image');
    }
  }

  function setBackground(cfg) {
    try {
      if (!cfg || cfg.type === 'default') {
        localStorage.removeItem('bobo:newtab-bg');
      } else {
        localStorage.setItem('bobo:newtab-bg', JSON.stringify(cfg));
      }
    } catch {}
    applyBackground(cfg);
  }

  function highlightActivePreset(type, value) {
    // Highlight default tile
    if (bgPresetDefault) {
      bgPresetDefault.classList.toggle('is-active', type === 'default');
    }
    // Highlight swatches
    document.querySelectorAll('.bg-swatch-btn').forEach((btn) => {
      btn.classList.toggle('is-active', type === 'color' && btn.dataset.color === value);
    });
    // Highlight gradients
    document.querySelectorAll('.bg-gradient-btn').forEach((btn) => {
      btn.classList.toggle('is-active', type === 'gradient' && btn.dataset.gradient === value);
    });
  }

  // --- Customize Modal Event Listeners -------------------------------------

  if (btnCustomizeBg && customizeDialog) {
    btnCustomizeBg.addEventListener('click', () => {
      // Sync row radio with current setting
      const currentRows = getRowCount();
      const radio = document.querySelector(`input[name="shortcut-rows"][value="${currentRows}"]`);
      if (radio) radio.checked = true;

      // Sync active background highlight
      const currentBg = getBackgroundConfig();
      highlightActivePreset(currentBg.type, currentBg.value);

      customizeDialog.showModal();
    });
  }

  if (customizeCloseBtn && customizeDialog) {
    customizeCloseBtn.addEventListener('click', () => customizeDialog.close());
  }

  if (customizeDoneBtn && customizeDialog) {
    customizeDoneBtn.addEventListener('click', () => customizeDialog.close());
  }

  // Reset to default Arctic Frost
  if (bgPresetDefault) {
    bgPresetDefault.addEventListener('click', () => {
      setBackground({ type: 'default' });
    });
  }

  // Solid color swatch clicks
  document.querySelectorAll('.bg-swatch-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const color = btn.dataset.color;
      if (color) setBackground({ type: 'color', value: color });
    });
  });

  // Custom color picker
  if (bgCustomColor) {
    bgCustomColor.addEventListener('input', (e) => {
      const color = e.target.value;
      if (color) setBackground({ type: 'color', value: color });
    });
  }

  // Gradient clicks
  document.querySelectorAll('.bg-gradient-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const gradient = btn.dataset.gradient;
      if (gradient) setBackground({ type: 'gradient', value: gradient });
    });
  });

  // Custom Image Upload
  if (bgFileInput) {
    bgFileInput.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (event) => {
        const dataUrl = event.target.result;
        setBackground({ type: 'image', value: dataUrl });
      };
      reader.readAsDataURL(file);
    });
  }

  if (bgImageRemove) {
    bgImageRemove.addEventListener('click', () => {
      if (bgFileInput) bgFileInput.value = '';
      setBackground({ type: 'default' });
    });
  }

  // Row selection radio buttons
  document.querySelectorAll('input[name="shortcut-rows"]').forEach((radio) => {
    radio.addEventListener('change', (e) => {
      if (e.target.checked) {
        const rows = parseInt(e.target.value, 10);
        if (rows >= 1 && rows <= 3) {
          setRowCount(rows);
        }
      }
    });
  });

  // Reset Shortcuts button
  if (btnResetShortcutsModal) {
    btnResetShortcutsModal.addEventListener('click', () => {
      localStorage.removeItem('bobo:custom-shortcuts');
      renderShortcuts();
    });
  }

  // --- Attachments: native picker, local only ------------------------------
  //
  // The main process opens the OS dialog and returns display metadata plus a
  // thumbnail for images. No path reaches this page, and nothing is uploaded.

  const btnAttachMenu = document.getElementById('btn-attach-menu');
  const attachDropdown = document.getElementById('attach-dropdown');
  const attachOptImages = document.getElementById('attach-opt-images');
  const attachOptFiles = document.getElementById('attach-opt-files');
  const attachmentsTray = document.getElementById('attachments-tray');
  const attachmentsList = document.getElementById('attachments-list');
  const attachmentsNote = document.getElementById('attachments-note');

  const attachments = [];
  let attachmentsTruncated = false;

  function formatBytes(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value <= 0) return '0 KB';
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }

  function attachmentKey(item) {
    return `${item.kind}:${item.name}:${item.size}`;
  }

  function renderAttachments() {
    if (!attachmentsTray || !attachmentsList) return;

    attachmentsList.replaceChildren();
    attachmentsTray.hidden = attachments.length === 0;

    attachments.forEach((item) => {
      const chip = document.createElement('div');
      chip.className = 'attachment-chip';

      const thumb = document.createElement('div');
      thumb.className = 'attachment-thumb';
      if (item.preview) {
        const img = document.createElement('img');
        img.src = item.preview;
        img.alt = '';
        img.className = 'attachment-thumb-img';
        thumb.appendChild(img);
      } else {
        const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        icon.setAttribute('viewBox', '0 0 24 24');
        icon.setAttribute('width', '16');
        icon.setAttribute('height', '16');
        icon.setAttribute('fill', 'none');
        icon.setAttribute('stroke', 'currentColor');
        icon.setAttribute('stroke-width', '1.8');
        icon.setAttribute('aria-hidden', 'true');
        const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
        use.setAttribute('href', item.kind === 'image' ? '#newtab-image' : '#newtab-file');
        icon.appendChild(use);
        thumb.appendChild(icon);
      }

      const info = document.createElement('div');
      info.className = 'attachment-info';
      const name = document.createElement('span');
      name.className = 'attachment-name';
      name.textContent = item.name;
      name.title = item.name;
      const meta = document.createElement('span');
      meta.className = 'attachment-meta';
      meta.textContent = `${item.type} · ${formatBytes(item.size)}`;
      info.append(name, meta);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'attachment-remove';
      remove.title = `Remove ${item.name}`;
      remove.setAttribute('aria-label', `Remove ${item.name}`);
      remove.innerHTML = '&times;';
      remove.addEventListener('click', () => {
        const index = attachments.indexOf(item);
        if (index >= 0) attachments.splice(index, 1);
        renderAttachments();
      });

      chip.append(thumb, info);
      if (item.imageId) {
        const lens = document.createElement('button');
        lens.type = 'button';
        lens.className = 'btn btn-sm';
        lens.textContent = 'Lens';
        lens.setAttribute('aria-label', `Search with Google Lens using ${item.name}`);
        lens.addEventListener('click', () => {
          imageSelection = item;
          renderImageSelection();
          imageDialog.showModal();
        });
        chip.append(lens);
      }
      chip.append(remove);
      attachmentsList.appendChild(chip);
    });

    if (attachmentsNote) {
      if (attachments.length === 0) {
        attachmentsNote.hidden = true;
        attachmentsNote.textContent = '';
      } else {
        attachmentsNote.hidden = false;
        const base =
          'Attachments stay local. To send a selected image to Google Lens, use its Lens button and confirm.';
        attachmentsNote.textContent = attachmentsTruncated
          ? `${base} Only the first 8 files were added.`
          : base;
      }
    }
  }

  function openAttachMenu() {
    if (!attachDropdown) return;
    attachDropdown.hidden = false;
    if (btnAttachMenu) btnAttachMenu.setAttribute('aria-expanded', 'true');
    const first = attachDropdown.querySelector('.attach-dropdown-item');
    if (first) first.focus();
  }

  function closeAttachMenu({ restoreFocus = false } = {}) {
    if (!attachDropdown || attachDropdown.hidden) return;
    attachDropdown.hidden = true;
    if (btnAttachMenu) {
      btnAttachMenu.setAttribute('aria-expanded', 'false');
      if (restoreFocus) btnAttachMenu.focus();
    }
  }

  async function chooseAttachments(kind) {
    if (!api || typeof api.pickAttachments !== 'function') {
      setStatus('File selection is unavailable in this window.');
      return;
    }

    try {
      const result = await api.pickAttachments(kind);
      if (!result || result.canceled) return;

      const items = Array.isArray(result.items) ? result.items : [];
      const expectedKind = kind === 'images' ? 'image' : 'file';
      let added = 0;
      for (const item of items) {
        if (!item || typeof item.name !== 'string' || item.kind !== expectedKind) continue;
        const key = attachmentKey(item);
        if (attachments.some((existing) => attachmentKey(existing) === key)) continue;
        if (attachments.length >= 8) {
          attachmentsTruncated = true;
          break;
        }
        attachments.push({
          name: item.name,
          size: Number(item.size) || 0,
          type: typeof item.type === 'string' ? item.type : '',
          kind: item.kind,
          preview: typeof item.preview === 'string' ? item.preview : null,
          imageId: typeof item.imageId === 'string' ? item.imageId : null,
        });
        added += 1;
      }

      if (result.truncated) attachmentsTruncated = true;
      renderAttachments();

      if (items.length === 0) {
        setStatus('No supported files were selected.');
      } else if (added === 0) {
        setStatus('Those files are already attached.');
      } else {
        setStatus(`${added} ${kind === 'image' ? 'image' : 'file'}${added === 1 ? '' : 's'} added locally.`);
      }
    } catch {
      setStatus('The file picker could not be opened.');
    }
  }

  if (btnAttachMenu && attachDropdown) {
    btnAttachMenu.setAttribute('aria-expanded', 'false');

    btnAttachMenu.addEventListener('click', (e) => {
      e.stopPropagation();
      if (attachDropdown.hidden) openAttachMenu();
      else closeAttachMenu({ restoreFocus: true });
    });

    btnAttachMenu.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        openAttachMenu();
      }
    });

    attachDropdown.addEventListener('keydown', (e) => {
      const items = Array.from(attachDropdown.querySelectorAll('.attach-dropdown-item'));
      const index = items.indexOf(document.activeElement);
      if (e.key === 'Escape') {
        e.preventDefault();
        closeAttachMenu({ restoreFocus: true });
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        items[(index + 1 + items.length) % items.length]?.focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        items[(index - 1 + items.length) % items.length]?.focus();
      } else if (e.key === 'Tab') {
        closeAttachMenu();
      }
    });

    document.addEventListener('click', (e) => {
      if (!attachDropdown.hidden && !e.target.closest('#attach-dropdown') && !e.target.closest('#btn-attach-menu')) {
        closeAttachMenu();
      }
    });

    attachOptImages?.addEventListener('click', () => {
      closeAttachMenu({ restoreFocus: true });
      chooseAttachments('images');
    });

    attachOptFiles?.addEventListener('click', () => {
      closeAttachMenu({ restoreFocus: true });
      chooseAttachments('files');
    });
  }

  // --- Microphone: honest unavailable state --------------------------------
  //
  // There is no speech engine wired into this build, and BOBO's permission
  // layer denies media by default. Rather than simulate recognition, explain.

  const btnSearchMic = document.getElementById('btn-search-mic');
  const voiceDialog = document.getElementById('voice-dialog');

  if (btnSearchMic && voiceDialog) {
    btnSearchMic.addEventListener('click', () => {
      voiceDialog.showModal();
    });
  }

  // --- Camera / local image selection --------------------------------------

  const btnSearchCam = document.getElementById('btn-search-cam');
  const imageDialog = document.getElementById('image-dialog');
  const btnImageChoose = document.getElementById('btn-image-choose');
  const btnImageRemove = document.getElementById('btn-image-remove');
  const btnImageSearch = document.getElementById('btn-image-search');
  const imageDialogStatus = document.getElementById('image-dialog-status');
  const imageDialogPreviewWrap = document.getElementById('image-dialog-preview-wrap');
  const imageDialogPreview = document.getElementById('image-dialog-preview');
  const imageDialogName = document.getElementById('image-dialog-name');
  const imageDialogMeta = document.getElementById('image-dialog-meta');
  const imageDialogEmpty = document.getElementById('image-dialog-empty');

  let imageSelection = null;

  function renderImageSelection() {
    if (!imageDialogPreviewWrap) return;
    const hasImage = imageSelection !== null;

    imageDialogPreviewWrap.hidden = !hasImage;
    if (imageDialogEmpty) imageDialogEmpty.hidden = hasImage;
    if (btnImageRemove) btnImageRemove.hidden = !hasImage;
    if (btnImageSearch) btnImageSearch.hidden = !imageSelection?.imageId;
    if (imageDialogStatus) imageDialogStatus.textContent = hasImage && !imageSelection.imageId
      ? 'This image is available for local preview only. Choose a supported PNG or JPEG to search.'
      : '';
    if (btnImageChoose) btnImageChoose.textContent = hasImage ? 'Choose Another Image' : 'Choose Image';

    if (!hasImage) {
      if (imageDialogPreview) imageDialogPreview.removeAttribute('src');
      if (imageDialogName) imageDialogName.textContent = '';
      if (imageDialogMeta) imageDialogMeta.textContent = '';
      return;
    }

    if (imageDialogPreview) {
      if (imageSelection.preview) {
        imageDialogPreview.src = imageSelection.preview;
        imageDialogPreview.hidden = false;
      } else {
        imageDialogPreview.removeAttribute('src');
        imageDialogPreview.hidden = true;
      }
    }
    if (imageDialogName) imageDialogName.textContent = imageSelection.name;
    if (imageDialogMeta) {
      imageDialogMeta.textContent = `${imageSelection.type} · ${formatBytes(imageSelection.size)} · local preview`;
    }
  }

  async function chooseImageForDialog() {
    if (!api || typeof api.pickAttachments !== 'function') {
      setStatus('Image selection is unavailable in this window.');
      return;
    }
    try {
      const result = await api.pickAttachments('images');
      if (!result || result.canceled) return;
      const item = Array.isArray(result.items) ? result.items[0] : null;
      if (!item) {
        setStatus('No supported image was selected.');
        return;
      }
      imageSelection = {
        name: item.name,
        size: Number(item.size) || 0,
        type: typeof item.type === 'string' ? item.type : '',
        preview: typeof item.preview === 'string' ? item.preview : null,
        imageId: typeof item.imageId === 'string' ? item.imageId : null,
      };
      renderImageSelection();
    } catch {
      setStatus('The image picker could not be opened.');
    }
  }

  if (btnSearchCam && imageDialog) {
    btnSearchCam.addEventListener('click', () => {
      renderImageSelection();
      imageDialog.showModal();
    });
  }
  if (btnImageChoose) btnImageChoose.addEventListener('click', chooseImageForDialog);
  btnImageSearch?.addEventListener('click', async () => {
    if (!imageSelection?.imageId || btnImageSearch.disabled) return;
    btnImageSearch.disabled = true;
    imageDialogStatus.textContent = 'Waiting for confirmation…';
    try {
      const result = await api.searchImageWithLens(imageSelection.imageId);
      imageDialogStatus.textContent = result.canceled ? 'Search canceled.' : '';
      if (!result.canceled) imageDialog.close();
    } catch (error) {
      imageDialogStatus.textContent = error.message;
    } finally {
      btnImageSearch.disabled = false;
    }
  });
  if (btnImageRemove) {
    btnImageRemove.addEventListener('click', () => {
      imageSelection = null;
      renderImageSelection();
    });
  }

  // --- Dialog close buttons ------------------------------------------------

  document.querySelectorAll('[data-close-dialog]').forEach((button) => {
    button.addEventListener('click', () => {
      const dialog = document.getElementById(button.dataset.closeDialog);
      if (dialog) dialog.close();
    });
  });

  // --- AI Mode placeholder -------------------------------------------------
  //
  // Visible, clearly disabled, and never calls an AI service. The tooltip is
  // the only behaviour: hover/focus shows it, click keeps it briefly.

  const btnAiMode = document.getElementById('btn-ai-mode');
  const aiModeTip = document.getElementById('ai-mode-tip');
  let aiTipTimer = null;
  let aiTipPinned = false;

  function showAiTip({ pinned = false } = {}) {
    if (!aiModeTip) return;
    clearTimeout(aiTipTimer);
    aiTipPinned = pinned;
    aiModeTip.hidden = false;
    if (!pinned) {
      aiTipTimer = setTimeout(() => {
        if (!aiTipPinned) aiModeTip.hidden = true;
      }, 2600);
    }
  }

  function hideAiTip() {
    if (!aiModeTip || aiTipPinned) return;
    clearTimeout(aiTipTimer);
    aiModeTip.hidden = true;
  }

  if (btnAiMode) {
    btnAiMode.addEventListener('mouseenter', () => showAiTip());
    btnAiMode.addEventListener('mouseleave', hideAiTip);
    btnAiMode.addEventListener('focus', () => showAiTip());
    btnAiMode.addEventListener('blur', () => {
      aiTipPinned = false;
      hideAiTip();
    });
    btnAiMode.addEventListener('click', () => {
      showAiTip({ pinned: true });
      setStatus('AI Mode is not active yet — Coming Soon.');
      clearTimeout(aiTipTimer);
      aiTipTimer = setTimeout(() => {
        aiTipPinned = false;
        if (aiModeTip) aiModeTip.hidden = true;
      }, 3200);
    });
  }

  // --- Google Services & Apps Launcher -------------------------------------
  //
  // The catalog and the saved preferences both come from the main process.
  // The launcher is a local shortcut list; it is NOT synced with Google.

  const GOOGLE_ICON_DIR = '../assets/google/';

  const btnGoogleApps = document.getElementById('btn-google-apps');
  const googleAppsPanel = document.getElementById('google-apps-panel');
  const googleAppsGrid = document.getElementById('google-apps-grid');
  const googleAppsEmpty = document.getElementById('google-apps-empty');
  const googleAppsManage = document.getElementById('google-apps-manage');
  const googleAppsManageList = document.getElementById('google-apps-manage-list');
  const googleAppsManageClose = document.getElementById('btn-google-apps-manage-close');
  const btnGoogleAppsManage = document.getElementById('btn-google-apps-manage');
  const btnRestoreApps = document.getElementById('btn-restore-apps');
  const googleAppsOpenNew = document.getElementById('google-apps-open-new');
  const googleAppsSaveState = document.getElementById('google-apps-save-state');

  const launcher = {
    apps: [],
    prefs: { order: [], hidden: [], openInNewTab: false },
    loaded: false,
    loadError: false,
    manageOpen: false,
  };

  function orderedApps() {
    const byId = new Map(launcher.apps.map((app) => [app.id, app]));
    const ordered = [];
    for (const id of launcher.prefs.order) {
      const app = byId.get(id);
      if (app) ordered.push(app);
    }
    return ordered;
  }

  function visibleApps() {
    const hidden = new Set(launcher.prefs.hidden);
    return orderedApps().filter((app) => !hidden.has(app.id));
  }

  function makeAppIcon(app, size) {
    const wrap = document.createElement('span');
    wrap.className = 'google-app-icon';
    const img = document.createElement('img');
    img.src = `${GOOGLE_ICON_DIR}${app.icon}`;
    img.alt = '';
    img.width = size;
    img.height = size;
    img.draggable = false;
    wrap.appendChild(img);
    return wrap;
  }

  function openGoogleApp(app) {
    closeAppsPanel({ restoreFocus: true });
    if (!api) {
      setStatus(`${app.name} needs the BOBO browser window.`);
      return;
    }
    try {
      if (launcher.prefs.openInNewTab && typeof api.createTab === 'function') {
        Promise.resolve(api.createTab(app.url)).catch(() => {
          setStatus(`${app.name} could not be opened.`);
        });
      } else {
        Promise.resolve(api.navigate(null, app.url)).catch(() => {
          setStatus(`${app.name} could not be opened.`);
        });
      }
    } catch {
      setStatus(`${app.name} is unavailable right now.`);
    }
  }

  function renderGoogleApps() {
    if (!googleAppsGrid) return;
    googleAppsGrid.replaceChildren();

    if (!launcher.loaded) {
      if (googleAppsEmpty) {
        googleAppsEmpty.hidden = false;
        googleAppsEmpty.textContent = launcher.loadError
          ? 'Google apps are unavailable right now.'
          : 'Loading Google apps…';
      }
      return;
    }

    const apps = visibleApps();
    if (googleAppsEmpty) {
      googleAppsEmpty.hidden = apps.length > 0;
      if (apps.length === 0) {
        googleAppsEmpty.textContent = 'All shortcuts are hidden. Use Customise to show them again.';
      }
    }

    for (const app of apps) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'google-app-item';
      item.title = app.name;
      item.setAttribute('aria-label', `Open ${app.name}`);

      const name = document.createElement('span');
      name.className = 'google-app-name';
      name.textContent = app.name;

      item.append(makeAppIcon(app, 28), name);
      item.addEventListener('click', () => openGoogleApp(app));
      googleAppsGrid.appendChild(item);
    }
  }

  function setSaveState(message) {
    if (!googleAppsSaveState) return;
    googleAppsSaveState.textContent = message;
    clearTimeout(setSaveState.timer);
    setSaveState.timer = setTimeout(() => {
      if (googleAppsSaveState.textContent === message) googleAppsSaveState.textContent = '';
    }, 2600);
  }

  async function persistLauncherPrefs() {
    if (!api || typeof api.setGoogleAppsPrefs !== 'function') {
      setSaveState('Not saved');
      return;
    }
    try {
      const result = await api.setGoogleAppsPrefs({
        order: launcher.prefs.order.slice(),
        hidden: launcher.prefs.hidden.slice(),
        openInNewTab: launcher.prefs.openInNewTab === true,
      });
      if (result && result.prefs) launcher.prefs = result.prefs;
      setSaveState('Saved');
    } catch {
      setSaveState('Could not save');
    }
  }

  function renderManageList() {
    if (!googleAppsManageList) return;
    googleAppsManageList.replaceChildren();

    const apps = orderedApps();
    const hidden = new Set(launcher.prefs.hidden);

    apps.forEach((app, index) => {
      const row = document.createElement('div');
      row.className = 'google-apps-manage-row';
      if (hidden.has(app.id)) row.classList.add('is-hidden');

      const icon = makeAppIcon(app, 20);
      icon.classList.add('is-small');

      const name = document.createElement('span');
      name.className = 'google-apps-manage-name';
      name.textContent = app.name;

      const up = document.createElement('button');
      up.type = 'button';
      up.className = 'google-apps-icon-btn';
      up.title = `Move ${app.name} up`;
      up.setAttribute('aria-label', `Move ${app.name} up`);
      up.disabled = index === 0;
      up.innerHTML =
        '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 14 6-6 6 6"/></svg>';
      up.addEventListener('click', () => moveApp(app.id, -1));

      const down = document.createElement('button');
      down.type = 'button';
      down.className = 'google-apps-icon-btn';
      down.title = `Move ${app.name} down`;
      down.setAttribute('aria-label', `Move ${app.name} down`);
      down.disabled = index === apps.length - 1;
      down.innerHTML =
        '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 10 6 6 6-6"/></svg>';
      down.addEventListener('click', () => moveApp(app.id, 1));

      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'google-apps-toggle';
      const isHidden = hidden.has(app.id);
      toggle.textContent = isHidden ? 'Show' : 'Hide';
      toggle.title = `${isHidden ? 'Show' : 'Hide'} ${app.name}`;
      toggle.setAttribute('aria-label', `${isHidden ? 'Show' : 'Hide'} ${app.name}`);
      toggle.setAttribute('aria-pressed', String(!isHidden));
      toggle.addEventListener('click', () => toggleApp(app.id));

      row.append(icon, name, up, down, toggle);
      googleAppsManageList.appendChild(row);
    });
  }

  function moveApp(id, delta) {
    const order = launcher.prefs.order;
    const index = order.indexOf(id);
    const next = index + delta;
    if (index < 0 || next < 0 || next >= order.length) return;
    [order[index], order[next]] = [order[next], order[index]];
    renderManageList();
    renderGoogleApps();
    persistLauncherPrefs();
  }

  function toggleApp(id) {
    const hidden = launcher.prefs.hidden;
    const index = hidden.indexOf(id);
    if (index >= 0) hidden.splice(index, 1);
    else hidden.push(id);
    renderManageList();
    renderGoogleApps();
    persistLauncherPrefs();
  }

  function openManage() {
    if (!googleAppsManage) return;
    launcher.manageOpen = true;
    googleAppsManage.hidden = false;
    if (googleAppsGrid) googleAppsGrid.hidden = true;
    if (googleAppsEmpty) googleAppsEmpty.hidden = true;
    if (btnGoogleAppsManage) btnGoogleAppsManage.classList.add('is-active');
    if (googleAppsOpenNew) googleAppsOpenNew.checked = launcher.prefs.openInNewTab === true;
    renderManageList();
    const first = googleAppsManageList?.querySelector('button:not(:disabled)');
    if (first) first.focus();
  }

  function closeManage() {
    if (!launcher.manageOpen) return;
    launcher.manageOpen = false;
    if (googleAppsManage) googleAppsManage.hidden = true;
    if (googleAppsGrid) googleAppsGrid.hidden = false;
    if (btnGoogleAppsManage) btnGoogleAppsManage.classList.remove('is-active');
    renderGoogleApps();
  }

  function openAppsPanel() {
    if (!googleAppsPanel) return;
    googleAppsPanel.hidden = false;
    if (btnGoogleApps) {
      btnGoogleApps.setAttribute('aria-expanded', 'true');
    }
    renderGoogleApps();
    if (!launcher.loaded) loadGoogleApps().then(() => renderGoogleApps());
  }

  function closeAppsPanel({ restoreFocus = false } = {}) {
    if (!googleAppsPanel || googleAppsPanel.hidden) return;
    googleAppsPanel.hidden = true;
    if (btnGoogleApps) {
      btnGoogleApps.setAttribute('aria-expanded', 'false');
      if (restoreFocus) btnGoogleApps.focus();
    }
    closeManage();
  }

  async function loadGoogleApps() {
    if (!api || typeof api.googleApps !== 'function') {
      launcher.loaded = true;
      launcher.loadError = true;
      return;
    }
    try {
      const result = await api.googleApps();
      const apps = Array.isArray(result?.apps) ? result.apps : [];
      const prefs = result?.prefs;
      if (!apps.length) {
        launcher.loaded = true;
        launcher.loadError = true;
        return;
      }
      launcher.apps = apps.filter(
        (app) => app && typeof app.id === 'string' && typeof app.name === 'string' && typeof app.url === 'string'
      );
      launcher.prefs = {
        order: Array.isArray(prefs?.order) ? prefs.order.slice() : launcher.apps.map((app) => app.id),
        hidden: Array.isArray(prefs?.hidden) ? prefs.hidden.slice() : [],
        openInNewTab: prefs?.openInNewTab === true,
      };
      // Keep order in sync with the catalog even for an old settings file.
      for (const app of launcher.apps) {
        if (!launcher.prefs.order.includes(app.id)) launcher.prefs.order.push(app.id);
      }
      launcher.loaded = true;
      launcher.loadError = false;
      if (googleAppsOpenNew) googleAppsOpenNew.checked = launcher.prefs.openInNewTab;
      renderGoogleApps();
      if (launcher.manageOpen) renderManageList();
    } catch {
      launcher.loaded = true;
      launcher.loadError = true;
      renderGoogleApps();
    }
  }

  if (btnGoogleApps && googleAppsPanel) {
    btnGoogleApps.addEventListener('click', (e) => {
      e.stopPropagation();
      if (googleAppsPanel.hidden) openAppsPanel();
      else closeAppsPanel({ restoreFocus: true });
    });

    document.addEventListener('click', (e) => {
      if (
        !googleAppsPanel.hidden &&
        !e.target.closest('#google-apps-panel') &&
        !e.target.closest('#btn-google-apps')
      ) {
        closeAppsPanel();
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !googleAppsPanel.hidden) {
        e.preventDefault();
        closeAppsPanel({ restoreFocus: true });
      }
    });

    btnGoogleAppsManage?.addEventListener('click', () => {
      if (launcher.manageOpen) closeManage();
      else openManage();
    });

    googleAppsManageClose?.addEventListener('click', () => {
      closeManage();
      const first = googleAppsGrid?.querySelector('.google-app-item');
      if (first) first.focus();
    });

    googleAppsOpenNew?.addEventListener('change', () => {
      launcher.prefs.openInNewTab = googleAppsOpenNew.checked === true;
      persistLauncherPrefs();
    });

    btnRestoreApps?.addEventListener('click', () => {
      launcher.prefs = {
        order: launcher.apps.map((app) => app.id),
        hidden: [],
        openInNewTab: false,
      };
      if (googleAppsOpenNew) googleAppsOpenNew.checked = false;
      renderManageList();
      renderGoogleApps();
      persistLauncherPrefs();
      setStatus('Google apps shortcuts restored to defaults.');
    });
  }

  // Top-right Gmail / Images links: keep them explicit, in a BOBO tab.
  for (const [id, url] of [
    ['link-gmail', 'https://mail.google.com/'],
    ['link-images', 'https://images.google.com/'],
  ]) {
    const link = document.getElementById(id);
    if (!link) continue;
    link.addEventListener('click', (e) => {
      e.preventDefault();
      if (!api || typeof api.createTab !== 'function') {
        setStatus('Open this link from the BOBO browser window.');
        return;
      }
      Promise.resolve(api.createTab(url)).catch(() => {
        setStatus('That service could not be opened.');
      });
    });
  }

  // --- Themes & Search Engine ----------------------------------------------

  function applyTheme(value) {
    const next = value === 'light' ? 'light' : 'dark';
    if (next === theme) return;
    theme = next;
    document.documentElement.dataset.theme = next;
  }

  function updateSearchPlaceholder() {
    const isDuck = searchEngine === 'duckduckgo';
    input.placeholder = isDuck ? 'Search DuckDuckGo' : 'Search Google';
  }

  if (form) {
    window.bindSearchSuggestions(input, document.getElementById('newtab-suggestions'), api,
      (url) => api.navigate(null, url));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (text && api) api.navigate(null, text);
    });
  }

  // Initialize
  applyBackground(getBackgroundConfig());
  renderShortcuts();
  window.addEventListener('focus', renderShortcuts);
  renderAttachments();
  renderImageSelection();
  loadGoogleApps();

  if (api) {
    if (api.onTheme) api.onTheme(applyTheme);
    if (api.getState) {
      api.getState()
        .then((payload) => payload && applyTheme(payload.theme))
        .catch(() => {});
    }

    if (api.toolsState) {
      api.toolsState().then((state) => {
        if (state?.search?.engine) {
          searchEngine = state.search.engine;
          updateSearchPlaceholder();
        }
      }).catch(() => {});
    }
  }

  if (input) input.focus();
})();
