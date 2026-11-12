'use strict';

/**
 * BOBO Tools: the chrome-side UI for Screenshot, Quick Notes and Reader.
 *
 * All privileged work happens in the main process (src/main/tools/*). This file
 * only renders state, validates what the user typed, and calls the narrow
 * `window.bobo` methods the preload exposes.
 *
 * The panel is part of the chrome, so it shrinks #viewport instead of covering
 * the page: a WebContentsView always paints above the window's own DOM.
 */

(() => {
  const api = window.bobo;
  if (!api || typeof api.toolsState !== 'function') return;

  const byId = (id) => document.getElementById(id);
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const FONT = { min: 13, max: 24, fallback: 17 };
  const AUTOSAVE_MS = 700;

  const dom = {
    body: byId('body'),
    panel: byId('tools-panel'),
    tabs: byId('tp-tabs'),
    close: byId('tp-close'),
    btnTools: byId('btn-tools'),
    pinned: byId('pinned-tools'),
    sideTools: document.querySelector('[data-side-tools]'),
    menuTools: document.querySelector('[data-menu-tools]'),
    views: Array.from(document.querySelectorAll('.tp-view')),

    shotCapture: byId('shot-capture'),
    shotStage: byId('shot-stage'),
    shotPreview: byId('shot-preview'),
    shotMeta: byId('shot-meta'),
    shotCopy: byId('shot-copy'),
    shotSave: byId('shot-save'),
    shotStatus: byId('shot-status'),

    notesSearch: byId('notes-search'),
    notesNew: byId('notes-new'),
    notesList: byId('notes-list'),
    notesEditor: byId('notes-editor'),
    noteTitle: byId('note-title'),
    noteBody: byId('note-body'),
    noteLink: byId('note-link'),
    noteLinkLabel: byId('note-link-label'),
    noteCopy: byId('note-copy'),
    noteExport: byId('note-export'),
    noteDelete: byId('note-delete'),
    notesStatus: byId('notes-status'),

    readerRead: byId('reader-read'),
    readerSmaller: byId('reader-smaller'),
    readerBigger: byId('reader-bigger'),
    readerStatus: byId('reader-status'),
    readerDoc: byId('reader-doc'),
    readerTitle: byId('reader-title'),
    readerUrl: byId('reader-url'),
    readerContent: byId('reader-content'),
    readerTruncated: byId('reader-truncated'),
    readerActions: byId('reader-actions'),
    readerCopy: byId('reader-copy'),
    readerSave: byId('reader-save'),

    settingsTools: byId('settings-tools'),
    settingsSearch: byId('settings-search'),
    settingsSearchStatus: byId('settings-search-status'),
    settingsFont: byId('settings-font'),
    settingsFontValue: byId('settings-font-value'),
    settingsPerms: byId('settings-perms'),
    settingsStorage: byId('settings-storage'),
    settingsClearNotes: byId('settings-clear-notes'),
    settingsClearAll: byId('settings-clear-all'),
    settingsStatus: byId('settings-status'),

    // Data Export
    exportTableTitle: byId('export-table-title'),
    exportTableSubtitle: byId('export-table-subtitle'),
    exportInspectBtn: byId('export-inspect-btn'),
    exportRangeInputs: byId('export-range-inputs'),
    exportPageFrom: byId('export-page-from'),
    exportPageTo: byId('export-page-to'),
    exportPageSize: byId('export-page-size'),
    exportFmtCsv: byId('fmt-csv'),
    exportFmtPdf: byId('fmt-pdf'),
    exportFmtBoth: byId('fmt-both'),
    exportMergeChk: byId('export-merge-chk'),
    exportColCount: byId('export-col-count'),
    exportSelectAll: byId('export-select-all'),
    exportClearCols: byId('export-clear-cols'),
    exportColumnsGrid: byId('export-columns-grid'),
    exportPresetName: byId('export-preset-name'),
    exportSavePreset: byId('export-save-preset'),
    exportLoadPreset: byId('export-load-preset'),
    exportStartBtn: byId('export-start-btn'),
    exportPreviewBtn: byId('export-preview-btn'),
    exportMergeBtn: byId('export-merge-btn'),
    exportStatus: byId('export-status'),
    exportPreviewWrap: byId('export-preview-wrap'),
    exportPreviewClose: byId('export-preview-close'),
    exportPreviewTableWrap: byId('export-preview-table-wrap'),

    // Bills History Extraction
    billsTabPaste: byId('bills-tab-paste'),
    billsTabCsv: byId('bills-tab-csv'),
    billsPasteSection: byId('bills-paste-section'),
    billsCsvSection: byId('bills-csv-section'),
    billsPasteArea: byId('bills-paste-area'),
    billsCsvFile: byId('bills-csv-file'),
    billsImportBtn: byId('bills-import-btn'),
    billsStatTotal: byId('bills-stat-total'),
    billsStatDone: byId('bills-stat-done'),
    billsStatPending: byId('bills-stat-pending'),
    billsStatEmpty: byId('bills-stat-empty'),
    billsStatFail: byId('bills-stat-fail'),
    billsProgressFill: byId('bills-progress-fill'),
    billsLiveStatus: byId('bills-live-status'),
    billsBtnStart: byId('bills-btn-start'),
    billsBtnPause: byId('bills-btn-pause'),
    billsBtnResume: byId('bills-btn-resume'),
    billsBtnStop: byId('bills-btn-stop'),
    billsBtnRetry: byId('bills-btn-retry'),
    billsBtnExport: byId('bills-btn-export'),
    billsBtnClear: byId('bills-btn-clear'),
    billsJobsList: byId('bills-jobs-list'),

    // YouTube Transcript Extractor
    transcriptVideoTitle: byId('transcript-video-title'),
    transcriptUrl: byId('transcript-url'),
    transcriptUseTab: byId('transcript-use-tab'),
    transcriptLangSelect: byId('transcript-lang-select'),
    transcriptChkTimestamps: byId('transcript-chk-timestamps'),
    transcriptBtnFetch: byId('transcript-btn-fetch'),
    transcriptBtnExport: byId('transcript-btn-export'),
    transcriptBtnCopy: byId('transcript-btn-copy'),
    transcriptStatus: byId('transcript-status'),
    transcriptPreviewBox: byId('transcript-preview-box'),
    transcriptFilter: byId('transcript-filter'),
    transcriptLines: byId('transcript-lines'),
  };

  const state = {
    tools: [],
    storage: '',
    reader: { fontSize: FONT.fallback },
    search: { engine: 'google', options: [] },
    tabs: [],
    activeId: null,
    view: 'screenshot',
    shot: null,
    notes: [],
    note: null,
    doc: null,
    saveSeq: 0,
    exportData: {
      domain: '',
      detected: null,
      selectedColumns: new Set(),
      format: 'csv',
    },
    billsData: {
      jobId: null,
      isRunning: false,
      isPaused: false,
      elapsedMs: 0,
      isStopping: false,
    },
    transcriptData: {
      detected: null,
      entries: [],
      language: 'auto',
    },
  };

  const statusTimers = new WeakMap();

  // --- small helpers -------------------------------------------------------

  function icon(name) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', `#${name}`);
    svg.appendChild(use);
    svg.setAttribute('aria-hidden', 'true');
    return svg;
  }

  function setStatus(node, message, kind) {
    if (!node) return;
    clearTimeout(statusTimers.get(node));
    node.textContent = message || '';
    node.dataset.kind = kind || '';
    if (message && kind !== 'error') {
      statusTimers.set(
        node,
        setTimeout(() => {
          node.textContent = '';
          node.dataset.kind = '';
        }, 6000)
      );
    }
  }

  function describe(error) {
    const message = error && error.message ? error.message : String(error || '');
    return message.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^BOBO:\s*/, '');
  }

  const toolById = (id) => state.tools.find((tool) => tool.id === id) || null;
  const isEnabled = (id) => {
    const tool = toolById(id);
    return !!tool && tool.enabled;
  };
  const enabledTools = () => state.tools.filter((tool) => tool.enabled);

  function activeTab() {
    return state.tabs.find((tab) => tab.id === state.activeId) || null;
  }

  function activeUrl() {
    const tab = activeTab();
    return tab && /^https?:/i.test(tab.url || '') ? tab.url : '';
  }

  function hostOf(value) {
    try {
      return new URL(value).hostname;
    } catch {
      return value;
    }
  }

  function when(value) {
    const date = value ? new Date(value) : new Date();
    return date.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  // --- panel chrome --------------------------------------------------------

  function setPinned(on) {
    document.body.classList.toggle('tools-open', on);
    if (dom.panel) dom.panel.hidden = !on;
    if (dom.btnTools) {
      dom.btnTools.setAttribute('aria-pressed', String(on));
      dom.btnTools.classList.toggle('is-active', on);
    }
  }

  function showView(id) {
    const tools = enabledTools();
    const isTool = tools.some((tool) => tool.id === id);
    // 'settings' is always available even when every tool is disabled.
    const next = id === 'settings' || isTool ? id : tools.length ? tools[0].id : 'settings';
    state.view = next;

    for (const view of dom.views) view.hidden = view.dataset.view !== next;
    for (const tab of dom.tabs.querySelectorAll('[data-tool]')) {
      tab.setAttribute('aria-selected', String(tab.dataset.tool === next));
      tab.classList.toggle('is-active', tab.dataset.tool === next);
    }
    if (next === 'notes') renderNotes();
    if (next === 'bills') refreshBillsJobsList(true);
    if (next === 'transcript') updateTranscriptUrlFromTab();
    if (next === 'sectors') renderSectors();
    if (next === 'social-video') {
      updateSocialVideo(() => api.socialVideoQueue());
      api.browserSettings().then(({ videoDownloadButtons }) => {
        const checkbox = byId('social-video-buttons');
        checkbox.checked = videoDownloadButtons === true;
        checkbox.disabled = false;
      }).catch((error) => setStatus(videoStatus, describe(error), 'error'));
    }
    if (next === 'csv-extractor' && !consumerCsvRunning) inspectConsumerCsv();
    if (next === 'youtube-auto-skip') void loadYouTubeAutoSkip();
    if (next === 'ad-free-youtube') {
      api.browserSettings().then((browser) => {
        alternateYouTube.checked = browser.alternateYouTube === true;
        alternateYouTube.disabled = false;
      }).catch((error) => setStatus(alternateYouTubeStatus, describe(error), 'error'));
    }
  }

  function sectorDomain() {
    try { return new URL(activeTab()?.url).hostname; } catch { return ''; }
  }

  let sectorListRequest = 0;
  async function renderSectors() {
    const request = ++sectorListRequest;
    const domain = sectorDomain();
    const status = byId('sectors-status');
    try {
      const saved = domain ? await api.listSectors('', domain) : [];
      const query = byId('sectors-filter-input').value.trim();
      const results = query && domain ? await api.listSectors(query, domain) : saved;
      if (request !== sectorListRequest || domain !== sectorDomain()) return;
      byId('sectors-count-badge').textContent = `${saved.length}${saved.length === 200 ? '+' : ''} Sectors`;
      byId('sectors-list').replaceChildren(...results.map((sector) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn';
        button.textContent = sector.name;
        button.addEventListener('click', async () => {
          try {
            const result = await api.selectSector(sector);
            setStatus(status, result.ok ? `Selected ${result.selected}.` : result.error, result.ok ? undefined : 'error');
          } catch (error) {
            setStatus(status, describe(error), 'error');
          }
        });
        return button;
      }));
    } catch (error) {
      setStatus(status, describe(error), 'error');
    }
  }

  function openTool(id) {
    setPinned(true);
    showView(id);
    if (id === 'settings') {
      const heading = byId('manage-tools-heading');
      heading.scrollIntoView({ block: 'start' });
      heading.focus({ preventScroll: true });
    }
  }

  function toolButton(tool, className, hidden) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.dataset.toolOpen = tool.id;
    button.title = tool.description;
    button.setAttribute('aria-label', tool.label);
    button.appendChild(icon(tool.icon));
    if (hidden) {
      const label = document.createElement('span');
      label.textContent = tool.label;
      button.appendChild(label);
    }
    return button;
  }

  function renderChrome() {
    const tools = enabledTools();
    dom.menuTools.replaceChildren(...tools.map((tool) => toolButton(tool, 'menu-item', true)));

    if (dom.pinned) {
      dom.pinned.replaceChildren(
        ...tools.filter((tool) => tool.pinned).map((tool) => toolButton(tool, 'icon-btn', false))
      );
    }

    if (dom.sideTools) {
      dom.sideTools.replaceChildren(
        ...tools.filter((tool) => tool.sidebar !== false).map((tool) => toolButton(tool, 'side-item', true))
      );
    }

    if (dom.tabs) {
      dom.tabs.replaceChildren(
        ...tools.map((tool) => {
          const tab = document.createElement('button');
          tab.type = 'button';
          tab.className = 'tp-tab';
          tab.dataset.tool = tool.id;
          tab.setAttribute('role', 'tab');
          tab.setAttribute('aria-selected', 'false');
          tab.appendChild(icon(tool.icon));
          const label = document.createElement('span');
          label.textContent = tool.label;
          tab.appendChild(label);
          return tab;
        }),
        (() => {
          const tab = document.createElement('button');
          tab.type = 'button';
          tab.className = 'tp-tab';
          tab.dataset.tool = 'settings';
          tab.setAttribute('role', 'tab');
          tab.setAttribute('aria-selected', 'false');
          tab.appendChild(icon('i-gear'));
          const label = document.createElement('span');
          label.textContent = 'Settings';
          tab.appendChild(label);
          return tab;
        })()
      );
    }

    showView(state.view);
  }

  // --- screenshot ----------------------------------------------------------

  const cropArea = byId('shot-crop-area');
  const cropButton = byId('shot-crop');
  const cropApply = byId('shot-crop-apply');
  const cropCancel = byId('shot-crop-cancel');
  const cropReset = byId('shot-crop-reset');
  const cropOverlay = byId('shot-crop-overlay');
  const cropBox = byId('shot-crop-box');
  const shotRead = byId('shot-read-text');
  const shotText = byId('shot-text');
  const shotTextCopy = byId('shot-text-copy');
  const shotTextStatus = byId('shot-text-status');
  let originalShot = null;
  let cropping = false;
  let cropDrag = null;
  let cropRegion = null;

  function setCropMode(open) {
    cropping = open;
    cropDrag = cropRegion = null;
    cropArea.classList.toggle('is-cropping', open);
    cropOverlay.setAttribute('hidden', '');
    cropApply.hidden = cropCancel.hidden = !open;
    cropApply.disabled = true;
    cropButton.hidden = open;
    cropReset.hidden = open || !originalShot || state.shot === originalShot;
    dom.shotCopy.disabled = dom.shotSave.disabled = open || !state.shot;
  }

  function setShot(result) {
    state.shot = result && result.ok ? result : null;
    const ready = !!state.shot;
    dom.shotCopy.disabled = !ready;
    dom.shotSave.disabled = !ready;
    dom.shotStage.hidden = !ready;
    cropButton.disabled = !ready;
    setCropMode(false);
    shotRead.disabled = !ready;
    shotText.hidden = shotTextCopy.hidden = true;
    shotText.value = '';
    setStatus(shotTextStatus, '');

    if (ready) {
      dom.shotPreview.src = result.dataUrl;
      dom.shotMeta.textContent = `${result.width} x ${result.height} px PNG`;
    } else {
      dom.shotPreview.removeAttribute('src');
      dom.shotMeta.textContent = '';
    }
  }

  async function readShotText() {
    const shot = state.shot;
    if (!shot || shotRead.disabled) return;
    shotRead.disabled = true;
    setStatus(shotTextStatus, 'Reading text from the image…');
    try {
      const value = await api.recognizeScreenshot(shot.dataUrl);
      if (shot !== state.shot) return;
      shotText.value = value;
      shotText.hidden = shotTextCopy.hidden = !value;
      setStatus(shotTextStatus, value ? 'Text extracted.' : 'No text found in this image.');
    } catch (error) {
      if (shot === state.shot) setStatus(shotTextStatus, describe(error), 'error');
    } finally {
      if (shot === state.shot) shotRead.disabled = false;
    }
  }
  shotRead.addEventListener('click', readShotText);
  shotTextCopy.addEventListener('click', async () => {
    try {
      await api.copyText(shotText.value);
      setStatus(shotTextStatus, 'Text copied.');
    } catch (error) { setStatus(shotTextStatus, describe(error), 'error'); }
  });

  async function captureScreenshot() {
    originalShot = null;
    setShot(null);
    dom.shotCapture.disabled = true;
    setStatus(dom.shotStatus, 'Capturing the visible tab...');
    try {
      const result = await api.captureScreenshot();
      if (!result || !result.ok) {
        setShot(null);
        setStatus(dom.shotStatus, (result && result.error) || 'BOBO could not capture this tab.', 'error');
        return;
      }
      originalShot = result;
      setShot(result);
      setStatus(dom.shotStatus, 'Captured. Crop, copy, or save the screenshot.');
    } catch (error) {
      setShot(null);
      setStatus(dom.shotStatus, describe(error), 'error');
    } finally {
      dom.shotCapture.disabled = false;
    }
  }

  function cropPoint(event) {
    const bounds = dom.shotPreview.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
    };
  }

  cropButton.addEventListener('click', () => {
    setCropMode(true);
    setStatus(dom.shotStatus, 'Drag around the area you want, then click Apply crop.');
  });
  cropArea.addEventListener('pointerdown', (event) => {
    if (!cropping || event.button !== 0 || cropDrag) return;
    event.preventDefault();
    cropDrag = { id: event.pointerId, start: cropPoint(event) };
    cropRegion = null;
    cropOverlay.setAttribute('hidden', '');
    cropApply.disabled = true;
    cropArea.setPointerCapture(event.pointerId);
  });
  function updateCrop(event) {
    if (cropDrag?.id !== event.pointerId) return;
    const point = cropPoint(event);
    const { start } = cropDrag;
    cropRegion = {
      x: Math.min(start.x, point.x), y: Math.min(start.y, point.y),
      width: Math.abs(start.x - point.x), height: Math.abs(start.y - point.y),
    };
    for (const [key, value] of Object.entries(cropRegion)) cropBox.setAttribute(key, value * 100);
    cropOverlay.removeAttribute('hidden');
    cropApply.disabled = cropRegion.width * state.shot.width < 1 || cropRegion.height * state.shot.height < 1;
  }
  cropArea.addEventListener('pointermove', updateCrop);
  cropArea.addEventListener('pointerup', (event) => {
    if (cropDrag?.id !== event.pointerId) return;
    updateCrop(event);
    cropDrag = null;
  });
  cropArea.addEventListener('lostpointercapture', () => { cropDrag = null; });
  cropCancel.addEventListener('click', () => {
    setCropMode(false);
    setStatus(dom.shotStatus, 'Crop canceled.');
  });
  cropReset.addEventListener('click', () => {
    setShot(originalShot);
    setStatus(dom.shotStatus, 'Original screenshot restored.');
  });
  cropApply.addEventListener('click', async () => {
    if (!cropRegion || cropApply.disabled) return;
    const shot = state.shot;
    const region = cropRegion;
    cropApply.disabled = true;
    try {
      await dom.shotPreview.decode();
      if (!cropping || state.shot !== shot || cropRegion !== region) return;
      const x = Math.floor(region.x * shot.width);
      const y = Math.floor(region.y * shot.height);
      const width = Math.min(shot.width, Math.ceil((region.x + region.width) * shot.width)) - x;
      const height = Math.min(shot.height, Math.ceil((region.y + region.height) * shot.height)) - y;
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(dom.shotPreview, x, y, width, height, 0, 0, width, height);
      setShot({ ok: true, width, height, dataUrl: canvas.toDataURL('image/png') });
      void readShotText();
      setStatus(dom.shotStatus, 'Crop applied. Copy or save the selected area.');
    } catch (error) {
      cropApply.disabled = false;
      setStatus(dom.shotStatus, describe(error), 'error');
    }
  });

  async function copyScreenshot() {
    if (!state.shot) return;
    try {
      const result = await api.copyScreenshot(state.shot.dataUrl);
      if (!result || !result.ok) throw new Error((result && result.error) || 'Copy failed.');
      setStatus(dom.shotStatus, 'Screenshot copied to the clipboard.');
    } catch (error) {
      setStatus(dom.shotStatus, describe(error), 'error');
    }
  }

  async function saveScreenshot() {
    if (!state.shot) return;
    try {
      const result = await api.saveScreenshot(state.shot.dataUrl);
      if (!result || !result.ok) throw new Error((result && result.error) || 'Save failed.');
      if (result.canceled) setStatus(dom.shotStatus, 'Save canceled.');
      else setStatus(dom.shotStatus, `Saved to ${result.path}`);
    } catch (error) {
      setStatus(dom.shotStatus, describe(error), 'error');
    }
  }

  // --- notes ---------------------------------------------------------------

  function noteText(note) {
    return note.body || '';
  }

  function noteMeta(note) {
    if (note.url) return hostOf(note.url);
    return when(note.updatedAt || note.createdAt);
  }

  function renderNotes() {
    if (!dom.notesList) return;

    const query = (dom.notesSearch?.value || '').trim().toLowerCase();
    const notes = state.notes.filter((note) => {
      if (!query) return true;
      return `${note.title} ${note.body}`.toLowerCase().includes(query);
    });

    if (!notes.length) {
      const empty = document.createElement('li');
      empty.className = 'notes-empty';
      empty.textContent = query ? 'No notes match that search.' : 'No notes yet. Press New to start one.';
      dom.notesList.replaceChildren(empty);
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const note of notes) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'notes-item';
      button.dataset.noteId = note.id;
      if (state.note && state.note.id === note.id) button.classList.add('is-active');

      const title = document.createElement('span');
      title.className = 'notes-item-title';
      title.textContent = note.title || 'Untitled note';

      const meta = document.createElement('span');
      meta.className = 'notes-item-meta';
      meta.textContent = noteMeta(note);

      button.append(title, meta);
      item.appendChild(button);
      fragment.appendChild(item);
    }
    dom.notesList.replaceChildren(fragment);
  }

  async function loadNotes() {
    try {
      const result = await api.listNotes();
      state.notes = (result && result.notes) || [];
      if (state.note && state.note.id) {
        const fresh = state.notes.find((note) => note.id === state.note.id);
        if (fresh) state.note = fresh;
      }
      renderNotes();
    } catch (error) {
      setStatus(dom.notesStatus, describe(error), 'error');
    }
  }

  function fillEditor(note) {
    state.note = note;
    dom.noteTitle.value = note.title || '';
    dom.noteBody.value = note.body || '';
    dom.noteLink.checked = !!note.url;
    dom.noteDelete.dataset.armed = '';
    dom.noteDelete.classList.remove('is-armed');
    updateLinkLabel();
    dom.noteDelete.disabled = !note.id;
    dom.noteDelete.replaceChildren(icon('i-trash'));
    const label = document.createElement('span');
    label.textContent = 'Delete';
    dom.noteDelete.appendChild(label);
    renderNotes();
  }

  function updateLinkLabel() {
    if (!dom.noteLink) return;

    const pageUrl = activeUrl();
    const stored = state.note && state.note.url;

    if (!pageUrl && !stored) {
      dom.noteLink.disabled = true;
      dom.noteLink.checked = false;
      dom.noteLinkLabel.textContent = 'Open a webpage to link a note';
      return;
    }

    dom.noteLink.disabled = false;
    if (dom.noteLink.checked && stored) {
      dom.noteLinkLabel.textContent = `Linked to ${hostOf(stored)}`;
      return;
    }
    dom.noteLinkLabel.textContent = `Link to ${hostOf(stored || pageUrl)}`;
  }

  async function flushPending() {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    await saveDraft();
  }

  async function startNote() {
    await flushPending();

    fillEditor({
      id: '',
      title: '',
      body: '',
      url: dom.noteLink.checked ? activeUrl() : '',
      pageTitle: '',
    });
    setStatus(dom.notesStatus, 'New note. It saves as you type.');
    dom.noteTitle.focus();
  }

  function deriveTitle(body) {
    const line = String(body || '')
      .split('\n')
      .map((entry) => entry.trim())
      .find(Boolean);
    return (line || 'Untitled note').slice(0, 80);
  }

  let saveTimer = null;

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void saveDraft();
    }, AUTOSAVE_MS);
  }

  async function saveDraft() {
    const title = dom.noteTitle.value.trim();
    const body = dom.noteBody.value;
    if (!title && !body.trim()) return;

    if (!state.note) fillEditor({ id: '', title: '', body: '', url: '', pageTitle: '' });

    const linked = dom.noteLink.checked;
    const url = linked ? state.note.url || activeUrl() : '';

    const payload = {
      id: state.note.id || undefined,
      title: title || deriveTitle(body),
      body,
      url,
      pageTitle: linked ? state.note.pageTitle || (activeTab()?.title || '') : '',
    };

    const seq = ++state.saveSeq;
    try {
      const result = await api.saveNote(payload);
      if (!result || !result.ok) throw new Error((result && result.error) || 'BOBO could not save this note.');
      if (seq !== state.saveSeq) return; // a newer edit owns the editor

      const saved = result.note;
      state.note = saved;

      const index = state.notes.findIndex((note) => note.id === saved.id);
      if (index === -1) state.notes.unshift(saved);
      else state.notes[index] = saved;

      if (!dom.noteLink.checked && saved.url) dom.noteLink.checked = true;
      updateLinkLabel();
      dom.noteDelete.disabled = false;
      renderNotes();
      setStatus(dom.notesStatus, `Saved ${when(saved.updatedAt)}`);
    } catch (error) {
      setStatus(dom.notesStatus, describe(error), 'error');
    }
  }

  async function selectNote(id) {
    // Leaving the editor flushes a pending edit instead of dropping it.
    await flushPending();

    const note = state.notes.find((entry) => entry.id === id);
    if (!note) return;

    fillEditor({ ...note });
    setStatus(dom.notesStatus, `Saved ${when(note.updatedAt)}`);
    dom.noteBody.focus();
  }

  async function deleteNote() {
    if (!state.note || !state.note.id) return;

    if (dom.noteDelete.dataset.armed !== 'yes') {
      dom.noteDelete.dataset.armed = 'yes';
      dom.noteDelete.classList.add('is-armed');
      const label = dom.noteDelete.querySelector('span');
      if (label) label.textContent = 'Confirm delete';
      setTimeout(() => {
        dom.noteDelete.dataset.armed = '';
        dom.noteDelete.classList.remove('is-armed');
        const again = dom.noteDelete.querySelector('span');
        if (again) again.textContent = 'Delete';
      }, 4000);
      return;
    }

    const id = state.note.id;
    clearTimeout(saveTimer);
    try {
      const result = await api.deleteNote(id);
      if (!result || !result.ok) throw new Error((result && result.error) || 'That note no longer exists.');
      state.notes = state.notes.filter((note) => note.id !== id);
      fillEditor({ id: '', title: '', body: '', url: '', pageTitle: '' });
      renderNotes();
      setStatus(dom.notesStatus, 'Note deleted.');
    } catch (error) {
      setStatus(dom.notesStatus, describe(error), 'error');
    }
  }

  async function copyNote() {
    const text = dom.noteBody.value.trim() || dom.noteTitle.value.trim();
    if (!text) {
      setStatus(dom.notesStatus, 'This note is empty.', 'error');
      return;
    }
    try {
      await api.copyText(text);
      setStatus(dom.notesStatus, 'Note text copied to the clipboard.');
    } catch (error) {
      setStatus(dom.notesStatus, describe(error), 'error');
    }
  }

  async function exportNote() {
    await saveDraft(); // export what is on screen, not a stale copy
    if (!state.note || !state.note.id) {
      setStatus(dom.notesStatus, 'Write something before exporting.', 'error');
      return;
    }
    try {
      const result = await api.exportNote(state.note.id);
      if (!result || !result.ok) throw new Error((result && result.error) || 'Export failed.');
      if (result.canceled) setStatus(dom.notesStatus, 'Export canceled.');
      else setStatus(dom.notesStatus, `Exported to ${result.path}`);
    } catch (error) {
      setStatus(dom.notesStatus, describe(error), 'error');
    }
  }

  // --- reader --------------------------------------------------------------

  function applyReaderFont(size) {
    const next = Math.min(FONT.max, Math.max(FONT.min, Math.round(Number(size) || FONT.fallback)));
    state.reader.fontSize = next;
    document.documentElement.style.setProperty('--reader-font', `${next}px`);
    if (dom.settingsFont) dom.settingsFont.value = String(next);
    if (dom.settingsFontValue) dom.settingsFontValue.textContent = String(next);
    return next;
  }

  function renderDoc(doc) {
    state.doc = doc;
    dom.readerDoc.hidden = false;
    dom.readerActions.hidden = false;
    dom.readerTitle.textContent = doc.title || 'Untitled page';
    dom.readerUrl.textContent = doc.url || '';

    const fragment = document.createDocumentFragment();
    for (const block of doc.blocks || []) {
      const node = document.createElement(block.kind === 'heading' ? 'h2' : 'p');
      node.textContent = block.text; // untrusted page text, never parsed as HTML
      fragment.appendChild(node);
    }
    dom.readerContent.replaceChildren(fragment);

    dom.readerTruncated.hidden = !doc.truncated;
    dom.readerTruncated.textContent = doc.truncated || '';
  }

  async function readPage() {
    dom.readerRead.disabled = true;
    setStatus(dom.readerStatus, 'Reading the active page...');
    try {
      const result = await api.extractReader();
      if (!result || !result.ok) {
        renderDocEmpty();
        setStatus(dom.readerStatus, (result && result.error) || 'BOBO could not read this page.', 'error');
        return;
      }
      renderDoc(result);
      const count = (result.blocks || []).filter((block) => block.kind !== 'heading').length;
      setStatus(dom.readerStatus, `Read ${count} ${count === 1 ? 'paragraph' : 'paragraphs'}.`);
    } catch (error) {
      renderDocEmpty();
      setStatus(dom.readerStatus, describe(error), 'error');
    } finally {
      dom.readerRead.disabled = false;
    }
  }

  function renderDocEmpty() {
    state.doc = null;
    dom.readerDoc.hidden = true;
    dom.readerActions.hidden = true;
    dom.readerContent.replaceChildren();
  }

  async function copyReader() {
    if (!state.doc) return;
    try {
      await api.copyText(state.doc.text);
      setStatus(dom.readerStatus, 'Page text copied to the clipboard.');
    } catch (error) {
      setStatus(dom.readerStatus, describe(error), 'error');
    }
  }

  async function saveReader() {
    if (!state.doc) return;
    try {
      const result = await api.saveReader(state.doc);
      if (!result || !result.ok) throw new Error((result && result.error) || 'Save failed.');
      if (result.canceled) setStatus(dom.readerStatus, 'Save canceled.');
      else setStatus(dom.readerStatus, `Saved to ${result.path}`);
    } catch (error) {
      setStatus(dom.readerStatus, describe(error), 'error');
    }
  }

  // --- settings ------------------------------------------------------------

  function renderSearch() {
    if (!dom.settingsSearch) return;

    const options = state.search.options || [];

    dom.settingsSearch.replaceChildren(
      ...options.map((option) => {
        const node = document.createElement('option');
        node.value = option.id;
        node.textContent = option.label;
        return node;
      })
    );
    dom.settingsSearch.value = state.search.engine;
  }

  async function chooseSearchEngine(id) {
    try {
      const result = await api.setSearchEngine(id);
      if (!result) return;
      state.search = result.search || state.search;
      renderSearch();
      const label = (state.search.options.find((option) => option.id === state.search.engine) || {}).label;
      setStatus(dom.settingsSearchStatus, `Search engine set to ${label || state.search.engine}.`);
    } catch (error) {
      setStatus(dom.settingsSearchStatus, describe(error), 'error');
      await refreshState();
    }
  }

  // --- data export --------------------------------------------------------

  function updateExportColCount() {
    if (!dom.exportColCount || !state.exportData.detected) return;
    const total = state.exportData.detected.columns.length;
    const sel = state.exportData.selectedColumns.size;
    dom.exportColCount.textContent = `${sel} of ${total} columns selected`;
  }

  async function loadColumnPresets(domain) {
    if (!dom.exportLoadPreset || !domain) return;
    try {
      const presets = await api.listColumnPresets(domain);
      dom.exportLoadPreset.innerHTML = '<option value="">Saved Presets...</option>';
      for (const p of presets || []) {
        const opt = document.createElement('option');
        opt.value = JSON.stringify(p.columns);
        opt.textContent = `${p.name} (${p.columns.length} cols)`;
        dom.exportLoadPreset.appendChild(opt);
      }
    } catch {}
  }

  function renderExportColumns(columns) {
    if (!dom.exportColumnsGrid) return;
    dom.exportColumnsGrid.innerHTML = '';
    state.exportData.selectedColumns = new Set(columns);
    updateExportColCount();

    for (const col of columns) {
      const label = document.createElement('label');
      label.className = 'tp-check-col';
      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.checked = true;
      chk.dataset.column = col;
      chk.addEventListener('change', () => {
        if (chk.checked) state.exportData.selectedColumns.add(col);
        else state.exportData.selectedColumns.delete(col);
        updateExportColCount();
      });
      const span = document.createElement('span');
      span.textContent = col;
      label.append(chk, span);
      dom.exportColumnsGrid.appendChild(label);
    }
  }

  async function inspectExportTable() {
    if (exportRunning) return;
    const tabId = state.activeId;
    setStatus(dom.exportStatus, 'Inspecting page table...');
    try {
      const res = await api.inspectTable();
      if (!res?.ok || !res.detected) {
        state.exportData.detected = null;
        if (dom.exportTableTitle) dom.exportTableTitle.textContent = 'No table detected';
        if (dom.exportTableSubtitle) dom.exportTableSubtitle.textContent = (res && res.error) || 'No visible data table found.';
        setStatus(dom.exportStatus, (res && res.error) || 'No table found.', 'error');
        return;
      }
      state.exportData.detected = { ...res, tabId };
      state.exportData.domain = res.domain || '';
      if (dom.exportTableTitle) {
        dom.exportTableTitle.textContent = res.isELGCDD ? 'eLGCDD Consumer Table' : 'Table Detected';
      }
      if (dom.exportTableSubtitle) {
        dom.exportTableSubtitle.textContent = `Page ${res.currentPage} of ${res.totalPages || 1} — Total records: ${(res.totalRecords || res.rowCount || 0).toLocaleString()} (${res.rowCount} visible)`;
      }
      renderExportColumns(res.columns || []);
      await loadColumnPresets(state.exportData.domain);
      setStatus(dom.exportStatus, `Found ${res.columns.length} columns and ${res.rowCount} visible rows.`);
    } catch (err) {
      setStatus(dom.exportStatus, describe(err), 'error');
    }
  }

  function renderExportPreview() {
    if (!state.exportData.detected || !dom.exportPreviewTableWrap) {
      setStatus(dom.exportStatus, 'Please inspect a table first.', 'error');
      return;
    }
    const cols = Array.from(state.exportData.selectedColumns);
    if (!cols.length) {
      setStatus(dom.exportStatus, 'No columns selected.', 'error');
      return;
    }

    const table = document.createElement('table');
    table.className = 'export-preview-table';
    const thead = document.createElement('thead');
    const trHead = document.createElement('tr');
    for (const c of cols) {
      const th = document.createElement('th');
      th.textContent = c;
      trHead.appendChild(th);
    }
    thead.appendChild(trHead);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    const rows = state.exportData.detected.rows || [];
    const previewRows = rows.slice(0, 15);
    for (const r of previewRows) {
      const tr = document.createElement('tr');
      for (const c of cols) {
        const td = document.createElement('td');
        td.textContent = r[state.exportData.detected.columns.indexOf(c)] ?? '';
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);

    dom.exportPreviewTableWrap.replaceChildren(table);
    if (dom.exportPreviewWrap) dom.exportPreviewWrap.hidden = false;
  }

  let exportRunning = false;
  let exportPageId;
  api.onExportProgress(({ pageId, page, last, count, total }) => {
    if (!exportRunning || pageId !== exportPageId) return;
    setStatus(dom.exportStatus, `Page ${page} of ${last}: collected ${count.toLocaleString()} of ${total.toLocaleString()} records…`);
    clearTimeout(statusTimers.get(dom.exportStatus));
  });

  async function executeExport() {
    if (exportRunning) return;
    if (!state.exportData.detected) {
      setStatus(dom.exportStatus, 'Please inspect a table first.', 'error');
      return;
    }
    const cols = Array.from(state.exportData.selectedColumns);
    if (!cols.length) {
      setStatus(dom.exportStatus, 'Select at least one column to export.', 'error');
      return;
    }

    const detected = state.exportData.detected;
    const scope = document.querySelector('input[name="export-scope"]:checked')?.value;

    const domain = state.exportData.domain || 'export';
    const baseName = `${domain.replace(/[^a-z0-9_-]/gi, '_')}-${new Date().toISOString().slice(0, 10)}`;
    const format = state.exportData.format;

    setStatus(dom.exportStatus, 'Exporting records...');
    exportRunning = true;
    exportPageId = detected.pageId;
    dom.exportStartBtn.disabled = true;
    dom.exportInspectBtn.disabled = true;
    try {
      const collected = await api.collectExportPages({
        tabId: detected.tabId, pageId: detected.pageId, url: detected.url, columns: detected.columns,
        scope: scope || 'current',
        from: scope === 'range' ? dom.exportPageFrom.valueAsNumber : 1,
        to: scope === 'range' ? dom.exportPageTo.valueAsNumber : 1,
        pageSize: dom.exportPageSize.value === 'default' ? 'default' : Number(dom.exportPageSize.value),
      });
      const indexes = cols.map(column => collected.columns.indexOf(column));
      const rows = collected.rows.map(row => indexes.map(index => row[index] ?? ''));
      const results = [];
      if (format === 'csv' || format === 'both') {
        const csvRes = await api.saveExportCsv({
          filename: `${baseName}.csv`,
          columns: cols,
          tableName: detected.tableName || baseName,
          rows,
        });
        if (csvRes && csvRes.ok && !csvRes.canceled) {
          results.push(`CSV: ${csvRes.path}`);
        }
      }
      if (format === 'pdf' || format === 'both') {
        const pdfRes = await api.saveExportPdf({
          filename: `${baseName}.pdf`,
          title: state.exportData.detected.isELGCDD ? 'eLGCDD Consumer Records' : `${domain} Data Export`,
          columns: cols,
          url: detected.url,
          rows,
        });
        if (pdfRes && pdfRes.ok && !pdfRes.canceled) {
          results.push(`PDF: ${pdfRes.path}`);
        }
      }

      if (results.length) {
        setStatus(dom.exportStatus, `Saved ${rows.length.toLocaleString()} rows from ${collected.pagesCollected} page(s). ${results.join(' | ')}`);
        clearTimeout(statusTimers.get(dom.exportStatus));
      } else {
        setStatus(dom.exportStatus, 'Export canceled.');
      }
    } catch (err) {
      setStatus(dom.exportStatus, describe(err), 'error');
    } finally {
      exportRunning = false;
      exportPageId = undefined;
      dom.exportStartBtn.disabled = false;
      dom.exportInspectBtn.disabled = false;
    }
  }

  async function executeCsvMerge() {
    setStatus(dom.exportStatus, 'Select CSV files to merge...');
    try {
      const res = await api.mergeExportCsv();
      if (!res || !res.ok) {
        if (res && res.canceled) setStatus(dom.exportStatus, 'Merge canceled.');
        else setStatus(dom.exportStatus, (res && res.error) || 'Merge failed.', 'error');
        return;
      }
      setStatus(dom.exportStatus, `Merged ${res.fileCount} files (${res.rowCount} records) into ${res.path}`);
    } catch (err) {
      setStatus(dom.exportStatus, describe(err), 'error');
    }
  }

  // --- bills history extraction ---------------------------------------------

  function renderBillsRecent(queue) {
    const body = byId('bills-recent-rows');
    if (!body) return;
    const indexed = queue.map((item, index) => ({ ...item, position: index + 1 }));
    const current = indexed.filter((item) => item.status === 'processing');
    const recent = indexed.filter((item) => !['pending', 'processing'].includes(item.status))
      .sort((a, b) => b.updatedAt - a.updatedAt || b.id - a.id);
    const upcoming = indexed.filter((item) => item.status === 'pending');
    body.replaceChildren();
    for (const item of [...current, ...recent, ...upcoming].slice(0, 10)) {
      const row = document.createElement('tr');
      row.dataset.status = item.status;
      row.title = item.error || '';
      for (const value of [item.position, item.connectionNo,
        item.status === 'processing' ? 'Looking up…' : item.status === 'empty' ? 'No records' : item.status,
        item.status === 'completed' ? item.billCount : '—']) {
        const cell = document.createElement('td');
        cell.textContent = String(value);
        row.appendChild(cell);
      }
      body.appendChild(row);
    }
  }

  async function refreshBillsDashboard(jobId) {
    if (!jobId) return;
    try {
      const job = await api.billsGetJob(jobId);
      if (!job) return;
      const queue = await api.billsGetQueue(jobId, true);
      if (state.billsData.jobId !== jobId) return;
      renderBillsRecent(queue);
      const total = job.total;
      const { completed, empty, failed, pending } = job;

      if (dom.billsStatTotal) dom.billsStatTotal.textContent = String(total);
      if (dom.billsStatDone) dom.billsStatDone.textContent = String(completed);
      if (dom.billsStatPending) dom.billsStatPending.textContent = String(pending);
      if (dom.billsStatEmpty) dom.billsStatEmpty.textContent = String(empty);
      if (dom.billsStatFail) dom.billsStatFail.textContent = String(failed);

      const pct = total > 0 ? Math.round(((completed + empty + failed + job.skipped) / total) * 100) : 0;
      if (dom.billsProgressFill) dom.billsProgressFill.style.width = `${pct}%`;

      const running = state.billsData.isRunning;
      const paused = state.billsData.isPaused;
      if (dom.billsBtnStart) dom.billsBtnStart.disabled = running || state.billsData.isStopping || pending === 0;
      if (dom.billsBtnPause) dom.billsBtnPause.disabled = !running || paused;
      if (dom.billsBtnResume) dom.billsBtnResume.disabled = running || !paused || pending === 0;
      if (dom.billsBtnStop) dom.billsBtnStop.disabled = !running && !paused;
      dom.billsBtnClear.disabled = running || paused || state.billsData.isStopping;
      byId('bills-btn-clear-all').disabled = running || paused || state.billsData.isStopping;
      if (dom.billsBtnRetry) dom.billsBtnRetry.disabled = running || failed === 0;
      const retryEmpty = byId('bills-btn-retry-empty');
      if (retryEmpty) {
        retryEmpty.textContent = `Re-check Empty (${empty})`;
        retryEmpty.disabled = running || paused || state.billsData.isStopping || empty === 0;
      }
      byId('bills-btn-repair').disabled = running || paused || state.billsData.isStopping;
    } catch {}
  }

  function selectBillsJob(id) {
    state.billsData.jobId = id;
    state.billsData.source = null;
    state.billsData.isPaused = false;
    if (id == null) localStorage.removeItem('bobo:bills:selected-job');
    else localStorage.setItem('bobo:bills:selected-job', String(id));
  }

  async function refreshBillsJobsList(restoreSelection = false) {
    if (!dom.billsJobsList) return;
    try {
      const jobs = await api.billsListJobs();
      if (!jobs || !jobs.length) {
        dom.billsJobsList.innerHTML = '<p class="tp-hint">No past extraction jobs.</p>';
        return;
      }
      if (restoreSelection && !state.billsData.jobId) {
        const savedId = Number(localStorage.getItem('bobo:bills:selected-job'));
        const saved = Number.isSafeInteger(savedId) && savedId > 0
          ? jobs.find((job) => job.id === savedId) || await api.billsGetJob(savedId)
          : null;
        if (!state.billsData.jobId) {
          const job = saved || jobs[0];
          selectBillsJob(job.id);
          await refreshBillsDashboard(job.id);
          if (state.billsData.jobId === job.id && !state.billsData.isRunning) {
            setStatus(dom.billsLiveStatus, job.pending
              ? 'Saved queue loaded. Click Start to continue pending lookups.'
              : 'Saved queue loaded.');
          }
        }
      }
      dom.billsJobsList.innerHTML = '';
      for (const j of jobs) {
        const item = document.createElement('div');
        item.className = 'bills-job-item';
        const info = document.createElement('div');
        info.className = 'bills-job-info';
        const title = document.createElement('strong');
        title.textContent = j.name || `Job #${j.id}`;
        const meta = document.createElement('small');
        meta.textContent = `${j.total} items • Status: ${j.status} • ${when(j.createdAt)}`;
        info.append(title, meta);

        const actions = document.createElement('div');
        actions.className = 'bills-job-actions';
        const loadBtn = document.createElement('button');
        loadBtn.type = 'button';
        loadBtn.className = 'btn-subtle';
        loadBtn.textContent = 'Load';
        loadBtn.addEventListener('click', () => {
          if (state.billsData.isRunning || state.billsData.isPaused || state.billsData.isStopping) {
            setStatus(dom.billsLiveStatus, 'Pause or stop the current job before loading another.', 'error');
            return;
          }
          selectBillsJob(j.id);
          refreshBillsDashboard(j.id);
          setStatus(dom.billsLiveStatus, `Loaded Job #${j.id}.`);
        });
        const expBtn = document.createElement('button');
        expBtn.type = 'button';
        expBtn.className = 'btn-subtle';
        expBtn.textContent = 'Export to Folder';
        expBtn.addEventListener('click', () => exportBillsFolder(j.id));
        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'btn-subtle';
        deleteBtn.textContent = 'Delete';
        deleteBtn.disabled = j.id === state.billsData.jobId && (state.billsData.isRunning || state.billsData.isPaused || state.billsData.isStopping);
        deleteBtn.addEventListener('click', async () => {
          if (!confirm('Delete this saved extraction job and its results? Exported files will remain.')) return;
          try {
            await api.billsClear(j.id);
            if (state.billsData.jobId === j.id) resetBillsDashboard();
            await refreshBillsJobsList();
          } catch (error) { setStatus(dom.billsLiveStatus, describe(error), 'error'); }
        });
        actions.append(loadBtn, expBtn, deleteBtn);
        item.append(info, actions);
        dom.billsJobsList.appendChild(item);
      }
    } catch {}
  }

  function firstCsvField(line) {
    let value = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          value += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        break;
      } else {
        value += char;
      }
    }
    return value.trim();
  }

  async function importBillsInput() {
    if (state.billsData.isRunning || state.billsData.isPaused || state.billsData.isStopping) {
      setStatus(dom.billsLiveStatus, 'Pause or stop the current job before importing another.', 'error');
      return;
    }
    let items = [];
    if (!dom.billsCsvSection.hidden) {
      const file = dom.billsCsvFile && dom.billsCsvFile.files[0];
      if (!file) {
        setStatus(dom.billsLiveStatus, 'Please select a CSV file first.', 'error');
        return;
      }
      const text = await file.text();
      const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      items = lines.map(firstCsvField).filter(Boolean);
      if (items.length && /connection|consumer|account/i.test(items[0]) && !/^=?\d+$/.test(items[0])) items.shift();
    } else {
      const text = (dom.billsPasteArea && dom.billsPasteArea.value) || '';
      items = text.split(/[\r\n,\t\s]+/).map((s) => s.trim()).filter(Boolean);
    }

    if (!items.length) {
      setStatus(dom.billsLiveStatus, 'No valid connection numbers found. Numbers should be numeric.', 'error');
      return;
    }

    setStatus(dom.billsLiveStatus, `Importing ${items.length} connection numbers...`);
    try {
      const name = `Batch Extraction (${items.length} items) - ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      const job = await api.billsCreateJob({ name, connectionNumbers: items });
      if (!job || !job.id) throw new Error('Could not create extraction job.');
      selectBillsJob(job.id);
      if (dom.billsPasteArea) dom.billsPasteArea.value = '';
      await refreshBillsDashboard(job.id);
      await refreshBillsJobsList();
      const skipped = Number(job.invalidCount) || 0;
      const sample = Array.isArray(job.invalidSamples) && job.invalidSamples.length
        ? ` (e.g. ${job.invalidSamples.join(', ')})`
        : '';
      setStatus(
        dom.billsLiveStatus,
        `Imported ${job.total} connection numbers into Queue.`
          + (skipped ? ` Skipped ${skipped} non-numeric value(s)${sample}.` : '')
          + (job.duplicateCount ? ` ${job.duplicateCount} duplicate number(s) merged.` : '')
          + (job.strippedCount ? ` ${job.strippedCount} had letters removed (e.g. ${job.strippedSamples.join('; ')}) - verify these.` : ''),
        skipped || job.duplicateCount || job.strippedCount ? 'warn' : ''
      );
    } catch (err) {
      setStatus(dom.billsLiveStatus, describe(err), 'error');
    }
  }

  async function runBillsQueue(resume = false) {
    if (state.billsData.isRunning || state.billsData.isStopping) return;
    const jobId = state.billsData.jobId;
    if (!jobId) {
      setStatus(dom.billsLiveStatus, 'No job loaded. Import or select a job first.', 'error');
      return;
    }

    const source = resume && state.billsData.source?.jobId === jobId
      ? state.billsData.source
      : { jobId, tabId: state.activeId };
    state.billsData.source = source;
    if (!resume) state.billsData.elapsedMs = 0;
    const started = performance.now();
    let processed = 0;
    let pending = 0;
    let sampleMs = 0;
    const updateElapsed = () => {
      const seconds = Math.floor((state.billsData.elapsedMs + performance.now() - started) / 1000);
      byId('bills-elapsed').textContent = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
        .map((part) => String(part).padStart(2, '0')).join(':');
      byId('bills-speed').textContent = processed ? `${Math.round(60000 * processed / sampleMs)}/min` : '—';
      byId('bills-eta').textContent = processed ? `${Math.ceil(pending * sampleMs / processed / 60000)} min` : '—';
    };
    updateElapsed();
    const elapsedTimer = setInterval(updateElapsed, 250);
    state.billsData.isRunning = true;
    state.billsData.isPaused = false;
    await refreshBillsDashboard(jobId);

    let ownsRun = false;
    let consecutiveFailures = 0;
    try {
      await api.billsSetRunning(jobId, true);
      ownsRun = true;
      const remaining = (await api.billsGetQueue(jobId)).filter((item) => item.status === 'pending');
      while (state.billsData.isRunning && !state.billsData.isPaused) {
        if (!state.billsData.isRunning || state.billsData.isPaused) break;
        const nextItem = remaining.shift();
        if (!nextItem) {
          setStatus(dom.billsLiveStatus, 'Extraction complete! Ready to Export CSV.');
          break;
        }

        setStatus(dom.billsLiveStatus, `Extracting ${nextItem.connectionNo}...`);
        const recent = await api.billsGetQueue(jobId, true);
        if (!state.billsData.isRunning || state.billsData.isPaused) break;
        renderBillsRecent([{ ...nextItem, status: 'processing' }, ...recent.filter((item) => item.id !== nextItem.id)]);
        const result = await api.billsProcessItem(jobId, nextItem.id, source.tabId);
        await refreshBillsDashboard(jobId);

        // A miss or a per-connection timeout is skipped so the rest of the
        // queue keeps going. Only a broken tab or repeated failures stop it.
        if (!result?.ok) {
          consecutiveFailures++;
          const message = result?.error || 'Bill lookup failed.';
          if (/tab was closed|became unavailable|Open Water Sanitation/i.test(message)) throw new Error(message);
          if (consecutiveFailures >= 5) {
            throw new Error(`Stopped after ${consecutiveFailures} failures in a row: ${message}`);
          }
          setStatus(dom.billsLiveStatus, `Skipped ${nextItem.connectionNo}: ${message}`, 'error');
        } else {
          consecutiveFailures = 0;
        }

        const delay = byId('bills-delay').valueAsNumber;
        const delayMs = Number.isFinite(delay) ? Math.min(60000, Math.max(0, delay)) : 600;
        processed++;
        pending = remaining.length;
        sampleMs = performance.now() - started + (pending ? delayMs : 0);
        if (!pending) continue;
        const deadline = performance.now() + delayMs;
        while (state.billsData.isRunning && !state.billsData.isPaused && performance.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(100, deadline - performance.now())));
        }
      }
    } catch (err) {
      setStatus(dom.billsLiveStatus, describe(err), 'error');
    } finally {
      if (ownsRun && !state.billsData.isPaused) await api.billsSetRunning(jobId, false);
      clearInterval(elapsedTimer);
      updateElapsed();
      state.billsData.elapsedMs += performance.now() - started;
      state.billsData.isRunning = false;
      state.billsData.isStopping = false;
      await refreshBillsDashboard(jobId);
      await refreshBillsJobsList();
    }
  }

  async function exportBillsFolder(jobId) {
    if (!jobId) return;
    try {
      const res = await api.billsExportCsv(jobId);
      if (res?.ok && !res.canceled) {
        const s = res.summary || {};
        setStatus(dom.billsLiveStatus,
          `Saved ${res.recordsCount} CSVs in ${res.path}. Existing: ${res.skipped}. Write failed: ${res.failed}. `
          + `Of ${s.given ?? '?'} given: ${s.completed ?? '?'} downloaded, ${s.empty ?? '?'} empty, `
          + `${s.failed ?? 0} failed, ${s.pending ?? 0} not processed. See "_Export Summary.txt" in that folder.`,
          res.failed || s.failed || s.pending ? 'error' : undefined);
      }
    } catch (error) {
      setStatus(dom.billsLiveStatus, describe(error), 'error');
    }
  }

  // --- bill prints ---------------------------------------------------------

  const prints = { items: [], running: false, paused: false, stopped: false, busy: false, elapsed: 0 };

  function renderBillPrints() {
    const done = prints.items.filter((item) => item.status === 'Done').length;
    const failed = prints.items.filter((item) => item.status === 'Failed').length;
    const progress = byId('prints-progress');
    progress.max = prints.items.length || 1;
    progress.value = done;
    byId('prints-summary').textContent = `${done} / ${prints.items.length} PDFs saved · ${failed} failed · ${Math.floor(prints.elapsed / 1000)} s elapsed`;
    const locked = prints.running || prints.busy;
    byId('prints-scan').disabled = locked;
    byId('prints-add').disabled = locked;
    byId('prints-parallel').disabled = locked;
    byId('prints-start').disabled = locked || done === prints.items.length;
    byId('prints-start').textContent = prints.paused || failed ? 'Resume / retry' : 'Start download';
    byId('prints-selected').disabled = locked || !prints.items.some((item) => item.selected && item.status !== 'Done');
    byId('prints-pause').disabled = !prints.running || prints.paused;
    byId('prints-stop').disabled = !prints.running || prints.stopped;
    byId('prints-csv').disabled = !prints.items.length || prints.busy;
    byId('prints-list').replaceChildren(...prints.items.map((item) => {
      const label = document.createElement('label');
      label.className = 'tp-check';
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = item.status === 'Done' || item.selected;
      check.disabled = locked || item.status === 'Done';
      check.addEventListener('change', () => {
        item.selected = check.checked;
        byId('prints-selected').disabled = !prints.items.some((entry) => entry.selected && entry.status !== 'Done');
      });
      const name = [item.locality, item.sector, item.bills ? `${item.bills} bills` : '', item.status, item.filename, item.error]
        .filter(Boolean).join(' · ');
      label.append(check, document.createTextNode(name));
      return label;
    }));
  }

  async function scanBillPrints(append) {
    if (prints.running || prints.busy) return;
    const status = byId('prints-status');
    prints.busy = true;
    renderBillPrints();
    try {
      const rows = await api.scanBillPrints(append);
      if (!append) {
        prints.items = [];
        prints.elapsed = 0;
        prints.paused = false;
      }
      prints.items.push(...rows.map((item) => ({ ...item, status: 'Pending', selected: false })));
      setStatus(status, rows.length ? `Added ${rows.length} bill files. ${prints.items.length} in the queue.`
        : 'This page’s bill files are already queued. Click Next in the portal, wait for the new rows, then add the page.');
    } catch (error) {
      setStatus(status, describe(error), 'error');
    } finally {
      prints.busy = false;
      renderBillPrints();
    }
  }

  async function runBillPrints(selectedOnly) {
    if (prints.running || prints.busy) return;
    const queue = prints.items.filter((item) => item.status !== 'Done' && (!selectedOnly || item.selected));
    if (!queue.length) return;
    const status = byId('prints-status');
    prints.busy = true;
    renderBillPrints();
    let timer;
    try {
      const folder = await api.chooseBillPrintsFolder();
      if (!folder) return;
      prints.running = true;
      prints.paused = false;
      prints.stopped = false;
      let lastTick = performance.now();
      const tick = () => {
        const now = performance.now();
        prints.elapsed += now - lastTick;
        lastTick = now;
        const summary = byId('prints-summary');
        summary.textContent = summary.textContent.replace(/\d+ s elapsed$/, `${Math.floor(prints.elapsed / 1000)} s elapsed`);
      };
      timer = setInterval(tick, 500);
      let next = 0;
      let nextStart = 0;
      const worker = async () => {
        while (next < queue.length && !prints.paused && !prints.stopped) {
          const remainingDelay = nextStart - performance.now();
          if (remainingDelay > 0) {
            await new Promise((resolve) => setTimeout(resolve, Math.min(100, remainingDelay)));
            continue;
          }
          const item = queue[next++];
          const seconds = byId('prints-delay').valueAsNumber;
          const delay = Number.isFinite(seconds) ? Math.max(0, Math.min(60, seconds)) : 3;
          nextStart = performance.now() + delay * 1000;
          item.status = 'Downloading';
          item.error = '';
          setStatus(status, `Downloading ${item.locality}…`);
          renderBillPrints();
          try {
            const result = await api.downloadBillPrint(item.id, byId('prints-timeout').valueAsNumber);
            item.status = 'Done';
            item.filename = result.filename;
          } catch (error) {
            item.status = prints.stopped ? 'Pending' : 'Failed';
            if (!prints.stopped) item.error = describe(error);
          }
          renderBillPrints();
        }
      };
      const slots = Math.min(queue.length, Number(byId('prints-parallel').value));
      await Promise.all(Array.from({ length: slots }, worker));
      tick();
      const failed = queue.filter((item) => item.status === 'Failed').length;
      setStatus(status, prints.stopped ? 'Stopped.' : prints.paused ? 'Paused.' :
        failed ? `${failed} files failed. See the queue for details and retry.` : `PDFs saved in ${folder}.`,
      failed ? 'error' : undefined);
    } catch (error) {
      setStatus(status, describe(error), 'error');
    } finally {
      clearInterval(timer);
      prints.busy = false;
      prints.running = false;
      renderBillPrints();
    }
  }

  // --- youtube transcript extractor -----------------------------------------

  function updateTranscriptUrlFromTab() {
    const tab = activeTab();
    if (!tab || !tab.url) return;
    if (/youtube\.com\/watch|youtu\.be\/|youtube\.com\/shorts/i.test(tab.url)) {
      if (dom.transcriptUrl) dom.transcriptUrl.value = tab.url;
    }
  }

  function renderTranscriptLines(filterText) {
    if (!dom.transcriptLines) return;
    const entries = state.transcriptData.entries || [];
    const query = (filterText || '').trim().toLowerCase();
    const filtered = query
      ? entries.filter((e) => (e.text || '').toLowerCase().includes(query))
      : entries;

    dom.transcriptLines.innerHTML = '';
    for (const cue of filtered) {
      const line = document.createElement('div');
      line.className = 'transcript-line';
      const timeBtn = document.createElement('button');
      timeBtn.type = 'button';
      timeBtn.className = 'transcript-time-btn';
      timeBtn.textContent = cue.startText;
      timeBtn.title = `Seek video to ${cue.startText}`;
      timeBtn.addEventListener('click', () => {
        const source = state.transcriptData.detected;
        if (source) api.transcriptSeek(cue.start, source.tabId, source.url)
          .catch((error) => setStatus(dom.transcriptStatus, describe(error), 'error'));
      });
      const textSpan = document.createElement('span');
      textSpan.className = 'transcript-text';
      textSpan.textContent = cue.text;
      line.append(timeBtn, textSpan);
      dom.transcriptLines.appendChild(line);
    }
  }

  async function fetchTranscript() {
    const tabId = state.activeId;
    state.transcriptData.detected = null;
    state.transcriptData.entries = [];
    if (dom.transcriptBtnExport) dom.transcriptBtnExport.disabled = true;
    if (dom.transcriptBtnCopy) dom.transcriptBtnCopy.disabled = true;
    if (dom.transcriptPreviewBox) dom.transcriptPreviewBox.hidden = true;
    setStatus(dom.transcriptStatus, 'Detecting captions for video...');
    try {
      const res = await api.transcriptDetect(state.transcriptData.language || 'auto');
      if (!res || !res.ok) {
        setStatus(dom.transcriptStatus, (res && res.error) || 'No captions found for this video.', 'error');
        return;
      }
      if (!res.isYouTube) {
        setStatus(dom.transcriptStatus, res.message, 'error');
        return;
      }
      if (!res.segments?.length) {
        setStatus(dom.transcriptStatus, 'BOBO could not read a transcript for this video. Expand the video description, open Show transcript if available, and try again. Captions on the player can appear without a downloadable transcript.', 'error');
        return;
      }
      state.transcriptData.detected = { ...res, tabId };
      state.transcriptData.entries = res.segments;
      if (dom.transcriptVideoTitle) dom.transcriptVideoTitle.textContent = res.title || 'YouTube Video';
      if (dom.transcriptUrl && res.url) dom.transcriptUrl.value = res.url;

      if (dom.transcriptLangSelect) {
        dom.transcriptLangSelect.innerHTML = '';
        const opt = document.createElement('option');
        opt.value = 'auto';
        opt.textContent = 'Auto-detected';
        dom.transcriptLangSelect.appendChild(opt);
      }

      if (dom.transcriptBtnExport) dom.transcriptBtnExport.disabled = false;
      if (dom.transcriptBtnCopy) dom.transcriptBtnCopy.disabled = false;
      if (dom.transcriptPreviewBox) dom.transcriptPreviewBox.hidden = false;

      renderTranscriptLines('');
      setStatus(dom.transcriptStatus, `Extracted ${res.segments.length} transcript cues.`);
    } catch (err) {
      setStatus(dom.transcriptStatus, describe(err), 'error');
    }
  }

  async function exportTranscript() {
    if (!state.transcriptData.detected || !state.transcriptData.entries.length) {
      setStatus(dom.transcriptStatus, 'Please extract a transcript first.', 'error');
      return;
    }
    const fmtRadio = document.querySelector('input[name="transcript-fmt"]:checked');
    const format = fmtRadio ? fmtRadio.value : 'txt';
    const includeTimestamps = dom.transcriptChkTimestamps ? dom.transcriptChkTimestamps.checked : true;

    setStatus(dom.transcriptStatus, `Saving ${format.toUpperCase()} file...`);
    try {
      const res = await api.transcriptExport({
        format,
        title: state.transcriptData.detected.title,
        videoId: state.transcriptData.detected.videoId,
        segments: state.transcriptData.entries,
        url: state.transcriptData.detected.url,
        includeTimestamps,
      });
      if (res && res.ok && !res.canceled) {
        setStatus(dom.transcriptStatus, `Exported to ${res.path}`);
      } else {
        setStatus(dom.transcriptStatus, 'Export canceled.');
      }
    } catch (err) {
      setStatus(dom.transcriptStatus, describe(err), 'error');
    }
  }

  async function copyTranscriptText() {
    const entries = state.transcriptData.entries || [];
    if (!entries.length) return;
    const includeTimestamps = dom.transcriptChkTimestamps ? dom.transcriptChkTimestamps.checked : true;
    const text = entries
      .map((e) => (includeTimestamps ? `[${e.startText}] ${e.text}` : e.text))
      .join('\n');
    await api.copyText(text);
    setStatus(dom.transcriptStatus, 'Transcript copied to clipboard.');
  }

  function renderSettings() {
    if (!dom.settingsTools) return;

    renderSearch();

    dom.settingsTools.replaceChildren(
      ...state.tools.map((tool) => {
        const row = document.createElement('div');
        row.className = 'settings-tool';

        const main = document.createElement('label');
        main.className = 'settings-tool-main';
        const enabled = document.createElement('input');
        enabled.type = 'checkbox';
        enabled.checked = tool.enabled;
        enabled.dataset.toolEnabled = tool.id;
        enabled.setAttribute('aria-label', `Enable ${tool.label}`);
        const text = document.createElement('span');
        const name = document.createElement('strong');
        name.textContent = tool.label;
        const description = document.createElement('small');
        description.textContent = tool.description;
        text.append(name, description);
        main.append(enabled, text);

        const pin = document.createElement('label');
        pin.className = 'settings-tool-pin';
        const pinned = document.createElement('input');
        pinned.type = 'checkbox';
        pinned.checked = tool.pinned;
        pinned.disabled = !tool.enabled;
        pinned.dataset.toolPinned = tool.id;
        pinned.setAttribute('aria-label', `Pin ${tool.label} to the toolbar`);
        const pinLabel = document.createElement('span');
        pinLabel.textContent = 'Pin to toolbar';
        pin.append(pinned, pinLabel);

        const sidebar = document.createElement('label');
        sidebar.className = 'settings-tool-pin';
        const visible = document.createElement('input');
        visible.type = 'checkbox';
        visible.checked = tool.sidebar !== false;
        visible.disabled = !tool.enabled;
        visible.dataset.toolSidebar = tool.id;
        visible.setAttribute('aria-label', `Show ${tool.label} in sidebar`);
        sidebar.append(visible, 'Show in sidebar');
        row.append(main, pin, sidebar);
        return row;
      })
    );

    if (dom.settingsPerms) {
      dom.settingsPerms.replaceChildren(
        ...state.tools.map((tool) => {
          const group = document.createElement('div');
          group.className = 'settings-perm';
          const heading = document.createElement('h4');
          heading.textContent = tool.label;
          const list = document.createElement('ul');
          for (const permission of tool.permissions || []) {
            const item = document.createElement('li');
            item.textContent = permission;
            list.appendChild(item);
          }
          group.append(heading, list);
          return group;
        })
      );
    }

    if (dom.settingsStorage) {
      dom.settingsStorage.textContent = state.storage
        ? `Notes and preferences are stored on this PC at ${state.storage}`
        : 'Notes and preferences are stored locally on this PC.';
    }

    applyReaderFont(state.reader.fontSize);
  }

  async function refreshState() {
    const result = await api.toolsState();
    if (!result) return;
    state.tools = result.tools || [];
    state.storage = result.storage || '';
    state.reader.fontSize = (result.reader && result.reader.fontSize) || FONT.fallback;
    state.search = result.search || state.search;
    if (result.recovered) {
      setStatus(
        dom.settingsStatus,
        'BOBO found unreadable tool data and kept a copy beside the original file.',
        'error'
      );
    }
    renderChrome();
    renderSettings();
  }

  async function configureTool(id, patch) {
    try {
      const result = await api.configureTool(id, patch);
      if (!result) return;
      state.tools = result.tools || state.tools;
      if (patch.enabled === false && state.view === id) state.view = 'settings';
      renderChrome();
      renderSettings();

      const tool = toolById(id);
      const label = (tool && tool.label) || 'Tool';
      if (patch.enabled === false) setStatus(dom.settingsStatus, `${label} disabled.`);
      else if (patch.enabled === true) setStatus(dom.settingsStatus, `${label} enabled.`);
      else if (typeof patch.sidebar === 'boolean') setStatus(dom.settingsStatus, patch.sidebar ? `${label} shown in sidebar.` : `${label} hidden from sidebar.`);
      else setStatus(dom.settingsStatus, patch.pinned ? `${label} pinned to the toolbar.` : `${label} unpinned.`);
    } catch (error) {
      setStatus(dom.settingsStatus, describe(error), 'error');
      await refreshState();
    }
  }

  let fontTimer = null;

  function rememberFont(size) {
    const next = applyReaderFont(size);
    clearTimeout(fontTimer);
    fontTimer = setTimeout(async () => {
      try {
        const result = await api.setToolPrefs({ fontSize: next });
        if (result) {
          state.tools = result.tools || state.tools;
          state.reader = result.reader || state.reader;
        }
      } catch (error) {
        setStatus(dom.settingsStatus, describe(error), 'error');
      }
    }, 300);
  }

  async function clearData(what) {
    try {
      const result = await api.clearToolData(what);
      if (!result || !result.ok) throw new Error((result && result.error) || 'Nothing was cleared.');
      if (result.canceled) {
        setStatus(dom.settingsStatus, 'Canceled.');
        return;
      }
      await loadNotes();
      fillEditor({ id: '', title: '', body: '', url: '', pageTitle: '' });
      await refreshState();
      setStatus(dom.settingsStatus, what === 'all' ? 'All tool data cleared.' : 'Notes cleared.');
    } catch (error) {
      setStatus(dom.settingsStatus, describe(error), 'error');
    }
  }

  // --- wiring --------------------------------------------------------------

  document.addEventListener('click', (event) => {
    const open = event.target.closest('[data-tool-open]');
    if (open) {
      event.preventDefault();
      openTool(open.dataset.toolOpen);
      return;
    }

    const tab = event.target.closest('[data-tool]');
    if (tab && dom.tabs.contains(tab)) {
      showView(tab.dataset.tool);
      return;
    }

    const item = event.target.closest('[data-note-id]');
    if (item) void selectNote(item.dataset.noteId);
  });

  dom.btnTools.addEventListener('click', () => setPinned(dom.panel.hidden));
  dom.close.addEventListener('click', () => setPinned(false));

  dom.shotCapture.addEventListener('click', captureScreenshot);
  dom.shotCopy.addEventListener('click', copyScreenshot);
  dom.shotSave.addEventListener('click', saveScreenshot);

  dom.notesNew.addEventListener('click', startNote);
  dom.notesSearch.addEventListener('input', renderNotes);
  dom.notesEditor.addEventListener('submit', (event) => {
    event.preventDefault();
    void saveDraft();
  });
  dom.noteTitle.addEventListener('input', scheduleSave);
  dom.noteBody.addEventListener('input', scheduleSave);
  dom.noteLink.addEventListener('change', () => {
    updateLinkLabel();
    scheduleSave();
  });
  dom.noteCopy.addEventListener('click', copyNote);
  dom.noteExport.addEventListener('click', exportNote);
  dom.noteDelete.addEventListener('click', deleteNote);

  dom.readerRead.addEventListener('click', readPage);
  dom.readerCopy.addEventListener('click', copyReader);
  dom.readerSave.addEventListener('click', saveReader);
  dom.readerSmaller.addEventListener('click', () => rememberFont(state.reader.fontSize - 1));
  dom.readerBigger.addEventListener('click', () => rememberFont(state.reader.fontSize + 1));

  dom.settingsTools.addEventListener('change', (event) => {
    const enabled = event.target.closest('[data-tool-enabled]');
    if (enabled) {
      void configureTool(enabled.dataset.toolEnabled, { enabled: enabled.checked });
      return;
    }
    const pinned = event.target.closest('[data-tool-pinned]');
    if (pinned) void configureTool(pinned.dataset.toolPinned, { pinned: pinned.checked });
    const sidebar = event.target.closest('[data-tool-sidebar]');
    if (sidebar) void configureTool(sidebar.dataset.toolSidebar, { sidebar: sidebar.checked });
  });

  dom.settingsFont.addEventListener('input', () => rememberFont(dom.settingsFont.value));
  dom.settingsSearch.addEventListener('change', () => chooseSearchEngine(dom.settingsSearch.value));
  dom.settingsClearNotes.addEventListener('click', () => clearData('notes'));
  dom.settingsClearAll.addEventListener('click', () => clearData('all'));

  // Data Export events
  dom.exportInspectBtn?.addEventListener('click', inspectExportTable);
  dom.exportSelectAll?.addEventListener('click', () => {
    if (!state.exportData.detected) return;
    state.exportData.selectedColumns = new Set(state.exportData.detected.columns);
    dom.exportColumnsGrid?.querySelectorAll('input[type="checkbox"]').forEach((c) => (c.checked = true));
    updateExportColCount();
  });
  dom.exportClearCols?.addEventListener('click', () => {
    state.exportData.selectedColumns.clear();
    dom.exportColumnsGrid?.querySelectorAll('input[type="checkbox"]').forEach((c) => (c.checked = false));
    updateExportColCount();
  });
  [dom.exportFmtCsv, dom.exportFmtPdf, dom.exportFmtBoth].forEach((btn) => {
    btn?.addEventListener('click', () => {
      [dom.exportFmtCsv, dom.exportFmtPdf, dom.exportFmtBoth].forEach((b) => b?.classList.remove('is-active'));
      btn.classList.add('is-active');
      state.exportData.format = btn.dataset.fmt;
    });
  });
  document.querySelectorAll('input[name="export-scope"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      if (dom.exportRangeInputs) dom.exportRangeInputs.hidden = radio.value !== 'range';
    });
  });
  dom.exportSavePreset?.addEventListener('click', async () => {
    const name = dom.exportPresetName?.value.trim();
    if (!name || !state.exportData.domain) return;
    await api.saveColumnPreset({
      domain: state.exportData.domain,
      name,
      columns: Array.from(state.exportData.selectedColumns),
    });
    if (dom.exportPresetName) dom.exportPresetName.value = '';
    await loadColumnPresets(state.exportData.domain);
    setStatus(dom.exportStatus, `Preset "${name}" saved.`);
  });
  dom.exportLoadPreset?.addEventListener('change', () => {
    const val = dom.exportLoadPreset?.value;
    if (!val) return;
    try {
      const cols = JSON.parse(val);
      state.exportData.selectedColumns = new Set(cols);
      dom.exportColumnsGrid?.querySelectorAll('input[type="checkbox"]').forEach((c) => {
        c.checked = state.exportData.selectedColumns.has(c.dataset.column);
      });
      updateExportColCount();
    } catch {}
  });
  dom.exportPreviewBtn?.addEventListener('click', renderExportPreview);
  dom.exportPreviewClose?.addEventListener('click', () => {
    if (dom.exportPreviewWrap) dom.exportPreviewWrap.hidden = true;
  });
  dom.exportStartBtn?.addEventListener('click', executeExport);
  dom.exportMergeBtn?.addEventListener('click', executeCsvMerge);

  // Bills History events
  dom.billsTabPaste?.addEventListener('click', () => {
    dom.billsTabPaste.classList.add('is-active');
    dom.billsTabCsv?.classList.remove('is-active');
    if (dom.billsPasteSection) dom.billsPasteSection.hidden = false;
    if (dom.billsCsvSection) dom.billsCsvSection.hidden = true;
  });
  dom.billsTabCsv?.addEventListener('click', () => {
    dom.billsTabCsv.classList.add('is-active');
    dom.billsTabPaste?.classList.remove('is-active');
    if (dom.billsCsvSection) dom.billsCsvSection.hidden = false;
    if (dom.billsPasteSection) dom.billsPasteSection.hidden = true;
  });
  byId('sectors-filter-input').addEventListener('input', renderSectors);
  byId('sectors-btn-refresh').addEventListener('click', async () => {
    const status = byId('sectors-status');
    try {
      const result = await api.inspectSectors();
      if (!result.found || !result.sectors?.length) {
        setStatus(status, result.error || (result.found
          ? 'The Sector dropdown has no loaded options. Wait for the page to finish loading and try again.'
          : 'No Sector dropdown found. Open Consumer List and try again.'), 'error');
        return;
      }
      const saved = await api.saveSectors(result.sectors, result.domain);
      await renderSectors();
      setStatus(status, `Saved ${saved.saved} sectors.`);
    } catch (error) {
      setStatus(status, describe(error), 'error');
    }
  });
  byId('sectors-btn-clear').addEventListener('click', async () => {
    const domain = sectorDomain();
    if (!domain || !window.confirm('Clear saved sectors for this website?')) return;
    try {
      await api.clearSectors(domain);
      await renderSectors();
      setStatus(byId('sectors-status'), 'Saved sectors cleared.');
    } catch (error) {
      setStatus(byId('sectors-status'), describe(error), 'error');
    }
  });
  api.onDailyReceiveProgress?.(({ stage, attempt, maxAttempts, retryIn }) => {
    const messages = { source: 'Downloading today’s Detail receipt file…', upload: 'Uploading the downloaded file to Daily Staff Receive…',
      generate: 'Generating Staff Daily Progress…', summary: 'Downloading Summary Page Only PDF…', retry: 'Retrying upload and summary PDF…' };
    if (messages[stage]) {
      const status = byId('daily-receive-status');
      const count = Number.isInteger(attempt) && Number.isInteger(maxAttempts) ? ` Attempt ${attempt} of ${maxAttempts}.` : '';
      const wait = Number.isInteger(retryIn) ? ` Retrying in ${retryIn} s.` : '';
      setStatus(status, messages[stage] + count + wait); clearTimeout(statusTimers.get(status));
    }
  });
  byId('daily-receive-download').addEventListener('click', async () => {
    const button = byId('daily-receive-download');
    const status = byId('daily-receive-status');
    button.disabled = true;
    const started = Date.now();
    const tick = () => { byId('daily-receive-elapsed').textContent = `Elapsed ${Math.floor((Date.now() - started) / 1000)} s`; };
    tick();
    const timer = setInterval(tick, 1000);
    setStatus(status, 'Requesting today’s Detail report in the background…');
    clearTimeout(statusTimers.get(status));
    try {
      const result = await api.downloadDailyReceive();
      setStatus(status, `Saved ${result.filePath} and ${result.pdfPath}`);
      clearTimeout(statusTimers.get(status));
    } catch (error) { setStatus(status, describe(error), 'error'); }
    finally { clearInterval(timer); tick(); button.disabled = false; }
  });
  byId('prints-scan').addEventListener('click', () => scanBillPrints(false));
  byId('prints-add').addEventListener('click', () => scanBillPrints(true));
  byId('prints-start').addEventListener('click', () => runBillPrints(false));
  byId('prints-selected').addEventListener('click', () => runBillPrints(true));
  byId('prints-pause').addEventListener('click', () => {
    prints.paused = true;
    renderBillPrints();
  });
  byId('prints-stop').addEventListener('click', async () => {
    prints.stopped = true;
    renderBillPrints();
    try { await api.stopBillPrints(); }
    catch (error) { setStatus(byId('prints-status'), describe(error), 'error'); }
  });
  byId('prints-csv').addEventListener('click', async () => {
    try {
      const file = await api.exportBillPrintsCsv();
      if (file) setStatus(byId('prints-status'), `Saved ${file}.`);
    } catch (error) {
      setStatus(byId('prints-status'), describe(error), 'error');
    }
  });
  renderBillPrints();

  const videoStatus = byId('social-video-status');
  let videoBatch = false;
  function renderSocialVideo(state) {
    byId('social-video-destination').textContent = state.folder || 'Choose a download folder.';
    byId('social-video-start').disabled = videoBatch || state.running;
    byId('social-video-retry').disabled = videoBatch || state.running;
    byId('social-video-stop').disabled = !state.running;
    const button = (label, run) => {
      const node = document.createElement('button');
      node.type = 'button';
      node.className = 'btn';
      node.textContent = label;
      node.addEventListener('click', () => updateSocialVideo(run));
      return node;
    };
    byId('social-video-queue').replaceChildren(...state.tasks.map((task) => {
      const row = document.createElement('div');
      row.className = 'saved-group-item';
      const heading = document.createElement('strong');
      heading.textContent = `${task.filename || task.source} · ${task.platform}`;
      heading.style.overflowWrap = 'anywhere';
      const detail = document.createElement('p');
      detail.className = 'tp-hint';
      detail.textContent = [
        task.status, task.format?.toUpperCase(), task.total ? `${(task.total / 1048576).toFixed(2)} MB` : '',
        task.received ? `${(task.received / 1048576).toFixed(2)} MB received` : '', task.error,
      ].filter(Boolean).join(' · ');
      row.append(heading, detail);
      if (task.status === 'Downloading' && task.total) {
        const progress = document.createElement('progress');
        progress.max = task.total;
        progress.value = task.received || 0;
        progress.setAttribute('aria-label', 'Video download progress');
        row.append(progress);
      }
      const actions = document.createElement('div');
      actions.className = 'tp-actions';
      if (['Pending', 'Failed', 'Cancelled'].includes(task.status)) {
        actions.append(button('Analyse Video', () => api.analyseSocialVideo(task.id)));
      }
      if (task.status === 'Completed' && task.downloadId) {
        for (const [label, action] of [
          ['Open File', api.openDownload], ['Show in Folder', api.showDownload], ['Copy Path', api.copyDownloadPath],
        ]) actions.append(button(label, async () => { await action(task.downloadId); }));
      }
      if (!['Downloading', 'Analysing'].includes(task.status)) {
        actions.append(button('Remove', () => api.removeSocialVideo(task.id)));
      }
      row.append(actions);
      return row;
    }));
  }
  async function updateSocialVideo(action) {
    try {
      const state = await action();
      if (state?.tasks) renderSocialVideo(state);
    } catch (error) {
      setStatus(videoStatus, describe(error), 'error');
    }
  }
  byId('social-video-add').addEventListener('click', () => updateSocialVideo(async () => {
    const input = byId('social-video-urls');
    const urls = input.value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    if (!urls.length) throw new Error('Paste at least one video URL.');
    const state = await api.addSocialVideos(urls);
    input.value = '';
    setStatus(videoStatus, `${state.tasks.length} queued.`);
    return state;
  }));
  byId('social-video-import').addEventListener('change', (event) => updateSocialVideo(async () => {
    const file = event.target.files[0];
    if (!file) return;
    if (file.size > 128000) throw new Error('Import a TXT or CSV file under 128 KB.');
    const state = await api.importSocialVideos(await file.text(), /\.csv$/i.test(file.name));
    event.target.value = '';
    return state;
  }));
  byId('social-video-folder').addEventListener('click', () => updateSocialVideo(api.chooseSocialVideoFolder));
  byId('social-video-clear').addEventListener('click', () => updateSocialVideo(() => api.removeSocialVideo('completed')));
  byId('social-video-stop').addEventListener('click', () => updateSocialVideo(api.stopSocialVideos));
  byId('social-video-find').addEventListener('click', async () => {
    const button = byId('social-video-find');
    const list = byId('social-video-found');
    button.disabled = true;
    list.replaceChildren();
    try {
      const files = await api.findPageVideos();
      for (const file of files) {
        const download = document.createElement('button');
        download.className = 'btn';
        download.type = 'button';
        download.textContent = `Download ${file.name}`;
        download.addEventListener('click', () => startSocialVideo(false, file.url));
        list.append(download);
      }
      setStatus(videoStatus, files.length ? `Found ${files.length} direct video file(s).`
        : 'No supported direct video file was found. Use the website’s download option if available.');
    } catch (error) {
      setStatus(videoStatus, describe(error), 'error');
    } finally {
      button.disabled = false;
    }
  });
  async function startSocialVideo(retry, selectedUrl) {
    if (videoBatch) return;
    videoBatch = true;
    const timer = setInterval(() => updateSocialVideo(api.socialVideoQueue), 750);
    try {
      await updateSocialVideo(async () => {
        const input = byId('social-video-urls');
        const urls = selectedUrl ? [selectedUrl]
          : retry ? [] : input.value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
        let queued = urls.length ? await api.addSocialVideos(urls) : await api.socialVideoQueue();
        if (urls.length && !selectedUrl) input.value = '';
        const chosen = selectedUrl && queued.tasks.find((task) => task.source === selectedUrl);
        const ready = selectedUrl ? chosen?.status === 'Pending' : queued.tasks.some((task) => task.status === 'Pending' ||
          (retry && ['Failed', 'Cancelled'].includes(task.status)));
        if (!ready) {
          setStatus(videoStatus, chosen?.status === 'Completed' ? 'This video is already downloaded.'
            : queued.tasks.some((task) => task.status === 'Unsupported')
            ? 'No supported videos are ready. See the explanation beside the link.'
            : 'Paste an authorised direct video file link first.', 'error');
          return queued;
        }
        if (!queued.folder) {
          queued = await api.chooseSocialVideoFolder();
          if (!queued.folder) {
            setStatus(videoStatus, 'Folder selection canceled.');
            return queued;
          }
        }
        setStatus(videoStatus, 'Processing the queue…');
        const state = await api.startSocialVideos(retry, chosen?.id);
        setStatus(videoStatus, 'Batch finished. See each video’s result below.');
        return state;
      });
    } finally {
      clearInterval(timer);
      videoBatch = false;
      await updateSocialVideo(api.socialVideoQueue);
    }
  }
  byId('social-video-start').addEventListener('click', () => startSocialVideo(false));
  byId('social-video-buttons').addEventListener('change', async (event) => {
    const checkbox = event.currentTarget;
    checkbox.disabled = true;
    try {
      await api.setBrowserSettings({ videoDownloadButtons: checkbox.checked });
      setStatus(videoStatus, checkbox.checked ? 'Download buttons are on.' : 'Video buttons are off.');
    } catch (error) {
      checkbox.checked = !checkbox.checked;
      setStatus(videoStatus, describe(error), 'error');
    } finally {
      checkbox.disabled = false;
    }
  });
  byId('social-video-retry').addEventListener('click', () => startSocialVideo(true));

  let consumerCsvRunning = false;
  let consumerCsvStopped = false;
  const consumerCsvStatus = byId('consumer-csv-status');

  function showConsumerCsvPage(page) {
    byId('consumer-csv-count').textContent = `${page.totalRecords.toLocaleString()} records · ${page.columns.length} columns · ${page.rowCount} on this page`;
    byId('consumer-csv-columns').textContent = page.columns.join(' | ');
  }

  async function inspectConsumerCsv() {
    try {
      const page = await api.consumerCsvPage();
      if (!consumerCsvRunning && page.detected) showConsumerCsvPage(page);
    } catch (error) {
      if (!consumerCsvRunning) setStatus(consumerCsvStatus, describe(error), 'error');
    }
  }

  byId('consumer-csv-start').addEventListener('click', async () => {
    if (consumerCsvRunning) return;
    consumerCsvRunning = true;
    consumerCsvStopped = false;
    byId('consumer-csv-start').disabled = true;
    byId('consumer-csv-stop').disabled = false;
    const progress = byId('consumer-csv-progress');
    progress.value = 0;
    const tabId = state.activeId;
    try {
      setStatus(consumerCsvStatus, 'Reading Consumer List…');
      let page = await api.consumerCsvPage(undefined, undefined, tabId);
      if (!page.detected || !page.rows?.length) throw new Error('Load the Consumer List records first.');
      const { pageId, totalRecords } = page;
      if (totalRecords > 100000) throw new Error('Filter the list to 100,000 records or fewer.');
      if (page.rangeStart == null && page.totalPages > 1) throw new Error('The page counter could not be read.');
      const indexes = page.columns.flatMap((column, index) => /^actions?$/i.test(column.trim()) ? [] : [index]);
      const columns = indexes.map((index) => page.columns[index]);
      const fingerprint = (row) => JSON.stringify(indexes.filter((index) =>
        !/^sr\s*#$/i.test(page.columns[index])).map((index) => row[index]));
      const edges = (value) => [fingerprint(value.rows[0]), fingerprint(value.rows.at(-1))];
      const waitFor = async (start, previous) => {
        const deadline = Date.now() + 30000;
        let signature;
        let stableSince;
        while (!consumerCsvStopped && Date.now() < deadline) {
          const candidate = await api.consumerCsvPage(undefined, pageId, tabId);
          if (candidate.rangeStart === start && candidate.totalRecords === totalRecords &&
            candidate.rows?.length && candidate.rowCount === candidate.rangeEnd - start + 1) {
            const current = edges(candidate);
            if (!previous || current.every((edge, index) => edge !== previous[index])) {
              const nextSignature = JSON.stringify(current);
              if (signature !== nextSignature) {
                signature = nextSignature;
                stableSince = Date.now();
              } else if (Date.now() - stableSince >= 400) return candidate;
            } else signature = undefined;
          } else signature = undefined;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        if (consumerCsvStopped) return null;
        throw new Error('The paginator did not produce a new page of rows. Export stopped.');
      };
      progress.max = totalRecords;
      if (page.rangeStart > 1 && !consumerCsvStopped) {
        await api.consumerCsvPage('first', pageId, tabId);
        page = await waitFor(1, edges(page));
      } else if (page.rangeStart === 1) page = await waitFor(1);
      const rows = [];
      const seen = new Set();
      const schema = JSON.stringify(columns);
      while (page && !consumerCsvStopped) {
        if (JSON.stringify(indexes.map((index) => page.columns[index])) !== schema) {
          throw new Error('The table columns changed during export.');
        }
        const key = JSON.stringify(edges(page));
        if (seen.has(key)) throw new Error('The portal returned a repeated page. Export stopped.');
        seen.add(key);
        rows.push(...page.rows.map((row) => indexes.map((index) => row[index])));
        progress.value = rows.length;
        showConsumerCsvPage(page);
        setStatus(consumerCsvStatus, `Collected ${rows.length.toLocaleString()} of ${totalRecords.toLocaleString()} records.`);
        if (rows.length >= totalRecords || consumerCsvStopped) break;
        const previous = edges(page);
        await api.consumerCsvPage('next', pageId, tabId);
        page = await waitFor(rows.length + 1, previous);
      }
      if (consumerCsvStopped) {
        setStatus(consumerCsvStatus, 'Export stopped.');
        return;
      }
      if (rows.length !== totalRecords) throw new Error('The collected row count did not match the portal total.');
      const result = await api.saveExportCsv({ tableName: 'Consumer List', columns, rows });
      setStatus(consumerCsvStatus, result.canceled ? 'Save canceled.' : `Saved ${result.rowCount.toLocaleString()} records.`);
    } catch (error) {
      setStatus(consumerCsvStatus, describe(error), 'error');
    } finally {
      consumerCsvRunning = false;
      byId('consumer-csv-start').disabled = false;
      byId('consumer-csv-stop').disabled = true;
    }
  });
  byId('consumer-csv-stop').addEventListener('click', () => { consumerCsvStopped = true; });

  const scraperRuns = [];
  let scraperResult;
  let scraperBusy = false;
  const scraperStatus = byId('scraper-status');
  function showScraperView(view) {
    byId('scraper-tools').hidden = view !== 'menu';
    byId('scraper-runs').hidden = view !== 'runs';
    byId('scraper-data').hidden = view !== 'data';
    document.querySelectorAll('[data-scraper-view]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.scraperView === view));
    });
  }
  function showScraperResult(run) {
    scraperResult = run;
    byId('scraper-export').disabled = !run.rows.length;
    byId('scraper-preview').textContent = [run.columns, ...run.rows.slice(0, 15)]
      .map((row) => row.map((value) => String(value).slice(0, 400)).join('  |  ')).join('\n');
    setStatus(scraperStatus, `${run.label}: ${run.rows.length} results${run.truncated ? ' (limit reached)' : ''}.`);
    showScraperView('data');
  }
  document.querySelectorAll('[data-scraper-view]').forEach((button) => {
    button.addEventListener('click', () => showScraperView(button.dataset.scraperView));
  });
  byId('scraper-tools').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-scrape]');
    if (!button || scraperBusy) return;
    scraperBusy = true;
    setStatus(scraperStatus, button.dataset.scrape === 'pick-list'
      ? 'Click a repeating card or row on the page. Press Escape to cancel.'
      : 'Reading the active page…');
    try {
      const data = await api.scrapePage(button.dataset.scrape);
      if (data.canceled) {
        setStatus(scraperStatus, 'Selection canceled.');
        return;
      }
      if (data.error) throw new Error(data.error);
      const run = { ...data, label: button.querySelector('strong').textContent };
      scraperRuns.unshift(run);
      scraperRuns.splice(10);
      byId('scraper-runs').replaceChildren(...scraperRuns.map((entry) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'btn';
        item.textContent = `${entry.label} · ${entry.rows.length} results`;
        item.addEventListener('click', () => showScraperResult(entry));
        return item;
      }));
      showScraperResult(run);
    } catch (error) {
      setStatus(scraperStatus, describe(error), 'error');
    } finally {
      scraperBusy = false;
    }
  });
  byId('scraper-export').addEventListener('click', async () => {
    if (!scraperResult?.rows.length) return;
    try {
      const result = await api.saveExportCsv({
        tableName: scraperResult.label, columns: scraperResult.columns, rows: scraperResult.rows,
      });
      if (!result.canceled) setStatus(scraperStatus, `Saved ${result.rowCount} rows to ${result.path}.`);
    } catch (error) {
      setStatus(scraperStatus, describe(error), 'error');
    }
  });
  dom.billsImportBtn?.addEventListener('click', importBillsInput);
  dom.billsBtnStart?.addEventListener('click', () => runBillsQueue());
  dom.billsBtnPause?.addEventListener('click', async () => {
    state.billsData.isPaused = true;
    await api.billsPause();
    await refreshBillsDashboard(state.billsData.jobId);
    setStatus(dom.billsLiveStatus, 'Paused.');
  });
  dom.billsBtnResume?.addEventListener('click', async () => {
    await api.billsResume();
    runBillsQueue(true);
  });
  dom.billsBtnStop?.addEventListener('click', async () => {
    state.billsData.isStopping = state.billsData.isRunning;
    state.billsData.isRunning = false;
    state.billsData.isPaused = false;
    await api.billsStop();
    if (state.billsData.jobId) await api.billsSetRunning(state.billsData.jobId, false);
    await refreshBillsDashboard(state.billsData.jobId);
    setStatus(dom.billsLiveStatus, 'Stopped.');
  });
  dom.billsBtnRetry?.addEventListener('click', async () => {
    if (!state.billsData.jobId) return;
    await api.billsRetry(state.billsData.jobId);
    await refreshBillsDashboard(state.billsData.jobId);
    setStatus(dom.billsLiveStatus, 'Failed items reset to pending.');
  });
  byId('bills-btn-retry-empty')?.addEventListener('click', async () => {
    const jobId = state.billsData.jobId;
    if (!jobId || state.billsData.isRunning || state.billsData.isPaused || state.billsData.isStopping) return;
    try {
      const result = await api.billsRetryEmpty(jobId);
      await refreshBillsDashboard(jobId);
      setStatus(dom.billsLiveStatus, `${result.requeued} empty connection(s) queued for a fresh lookup. Click Start to re-check them.`);
    } catch (error) {
      setStatus(dom.billsLiveStatus, describe(error), 'error');
    }
  });
  dom.billsBtnExport?.addEventListener('click', () => exportBillsFolder(state.billsData.jobId));
  byId('bills-btn-repair')?.addEventListener('click', async () => {
    const jobId = state.billsData.jobId;
    if (!jobId || state.billsData.isRunning || state.billsData.isPaused || state.billsData.isStopping) return;
    byId('bills-btn-repair').disabled = true;
    try {
      const result = await api.billsRepairIds(jobId);
      await refreshBillsDashboard(jobId);
      setStatus(dom.billsLiveStatus, `Repaired ${result.repaired} spreadsheet IDs; ${result.requeued} affected misses queued for verification. `
        + `${result.alreadyCompleted} already saved. Completed results unchanged. Click Start to continue, then Export Merged CSV.`);
    } catch (error) {
      setStatus(dom.billsLiveStatus, describe(error), 'error');
    } finally {
      await refreshBillsDashboard(jobId);
    }
  });
  byId('bills-delay-presets')?.addEventListener('click', (event) => {
    const preset = event.target.closest('button[data-delay]');
    if (preset) byId('bills-delay').value = preset.dataset.delay;
  });
  byId('bills-btn-merged')?.addEventListener('click', async () => {
    if (!state.billsData.jobId) return;
    try {
      const result = await api.billsExportCsv(state.billsData.jobId, null, true);
      if (result?.ok && !result.canceled) setStatus(dom.billsLiveStatus, `Saved merged CSV to ${result.path}.`);
    } catch (error) {
      setStatus(dom.billsLiveStatus, describe(error), 'error');
    }
  });
  byId('bills-btn-non-empty')?.addEventListener('click', async () => {
    if (!state.billsData.jobId) {
      setStatus(dom.billsLiveStatus, 'No job loaded. Import or select a job first.', 'error');
      return;
    }
    try {
      const result = await api.billsExportConnections(state.billsData.jobId, 'non-empty');
      if (result?.ok && !result.canceled) {
        setStatus(dom.billsLiveStatus,
          `Saved ${result.count} non-empty connection number(s) to ${result.path}. `
          + 'Import this CSV next time to skip the empty ones.');
      }
    } catch (error) {
      setStatus(dom.billsLiveStatus, describe(error), 'error');
    }
  });
  byId('bills-btn-export-all')?.addEventListener('click', async () => {
    try {
      const res = await api.billsExportAllJobs();
      if (res?.ok && !res.canceled) {
        const s = res.summary || {};
        setStatus(dom.billsLiveStatus,
          `Saved ${res.recordsCount} CSVs from all jobs in ${res.path}. Of ${s.given ?? '?'} given: ${s.completed ?? '?'} downloaded, `
          + `${s.empty ?? '?'} empty, ${s.failed ?? 0} failed, ${s.pending ?? 0} not processed. See "_Export Summary.txt".`,
          res.failed || s.failed || s.pending ? 'error' : undefined);
      }
    } catch (error) {
      setStatus(dom.billsLiveStatus, describe(error), 'error');
    }
  });
  for (const [id, mode] of [['bills-btn-export-empty', 'empty'], ['bills-btn-export-failed', 'failed']]) {
    byId(id)?.addEventListener('click', async () => {
      if (!state.billsData.jobId) {
        setStatus(dom.billsLiveStatus, 'No job loaded. Import or select a job first.', 'error');
        return;
      }
      try {
        const result = await api.billsExportConnections(state.billsData.jobId, mode);
        if (result?.ok && !result.canceled) {
          setStatus(dom.billsLiveStatus, `Saved ${result.count} ${mode} connection number(s) to ${result.path}. `
            + 'Check a few on the portal to confirm they really have no history.');
        }
      } catch (error) {
        setStatus(dom.billsLiveStatus, describe(error), 'error');
      }
    });
  }
  function resetBillsDashboard() {
    selectBillsJob(null);
    renderBillsRecent([]);
    byId('bills-btn-repair').disabled = true;
    if (dom.billsStatTotal) dom.billsStatTotal.textContent = '0';
    if (dom.billsStatDone) dom.billsStatDone.textContent = '0';
    if (dom.billsStatPending) dom.billsStatPending.textContent = '0';
    if (dom.billsStatEmpty) dom.billsStatEmpty.textContent = '0';
    if (dom.billsStatFail) dom.billsStatFail.textContent = '0';
    if (dom.billsProgressFill) dom.billsProgressFill.style.width = '0%';
    dom.billsBtnStart.disabled = true;
    dom.billsBtnResume.disabled = true;
    dom.billsBtnStop.disabled = true;
  }
  dom.billsBtnClear?.addEventListener('click', async () => {
    if (!state.billsData.jobId || state.billsData.isRunning || state.billsData.isPaused || state.billsData.isStopping) return;
    try {
      await api.billsClear(state.billsData.jobId);
      resetBillsDashboard();
    } catch (error) { setStatus(dom.billsLiveStatus, describe(error), 'error'); return; }
    await refreshBillsJobsList();
    setStatus(dom.billsLiveStatus, 'Queue cleared.');
  });
  byId('bills-btn-clear-all')?.addEventListener('click', async () => {
    try {
      const result = await api.billsClearAll();
      if (result.canceled) return;
      resetBillsDashboard();
      await refreshBillsJobsList();
      setStatus(dom.billsLiveStatus, 'All saved extraction jobs cleared. Exported files remain.');
    } catch (error) { setStatus(dom.billsLiveStatus, describe(error), 'error'); }
  });

  // YouTube Transcript events
  dom.transcriptUseTab?.addEventListener('click', updateTranscriptUrlFromTab);
  dom.transcriptBtnFetch?.addEventListener('click', fetchTranscript);
  dom.transcriptBtnExport?.addEventListener('click', exportTranscript);
  dom.transcriptBtnCopy?.addEventListener('click', copyTranscriptText);
  dom.transcriptFilter?.addEventListener('input', () => {
    renderTranscriptLines(dom.transcriptFilter.value);
  });

  api.onTabs((snapshot) => {
    if (!snapshot || !Array.isArray(snapshot.tabs)) return;
    const previousDomain = sectorDomain();
    state.activeId = snapshot.activeId;
    state.tabs = snapshot.tabs;
    if (state.view === 'sectors' && previousDomain !== sectorDomain()) renderSectors();
    updateLinkLabel();
  });

  // The tab snapshot pushed at startup can arrive before this page's listeners
  // exist, so read the current state once. Cheap, local, and it keeps the
  // "link to this page" label right on first paint.
  api.getState()
    .then((payload) => {
      if (!payload || !payload.tabs) return;
      state.activeId = payload.tabs.activeId;
      state.tabs = payload.tabs.tabs || [];
      updateLinkLabel();
    })
    .catch(() => {});

  const autoSkip = byId('youtube-auto-skip');
  const alternateYouTube = byId('alternate-youtube');
  const alternateYouTubeStatus = byId('alternate-youtube-status');
  alternateYouTube.addEventListener('change', async () => {
    alternateYouTube.disabled = true;
    try {
      await api.setBrowserSettings({ alternateYouTube: alternateYouTube.checked });
      setStatus(alternateYouTubeStatus, alternateYouTube.checked ? 'Enabled for YouTube video pages.' : 'Disabled.');
    } catch (error) {
      alternateYouTube.checked = !alternateYouTube.checked;
      setStatus(alternateYouTubeStatus, describe(error), 'error');
    } finally {
      alternateYouTube.disabled = false;
    }
  });
  const autoSkipStatus = byId('youtube-auto-skip-status');
  async function loadYouTubeAutoSkip() {
    try {
      autoSkip.checked = (await api.browserSettings()).youtubeAutoSkip === true;
      autoSkip.disabled = false;
    } catch (error) {
      setStatus(autoSkipStatus, describe(error), 'error');
    }
  }
  autoSkip.addEventListener('change', async () => {
    autoSkip.disabled = true;
    try {
      autoSkip.checked = await api.setYouTubeAutoSkip(autoSkip.checked);
      setStatus(autoSkipStatus, autoSkip.checked ? 'Auto Skip is on.' : 'Auto Skip is off.');
    } catch (error) {
      autoSkip.checked = !autoSkip.checked;
      setStatus(autoSkipStatus, describe(error), 'error');
    } finally {
      autoSkip.disabled = false;
    }
  });
  api.onSettings((state) => {
    if (!autoSkip.disabled && state?.browser) autoSkip.checked = state.browser.youtubeAutoSkip === true;
  });

  const linkedInText = byId('linkedin-preview-text');
  const linkedInImage = byId('linkedin-preview-image');
  const linkedInStatus = byId('linkedin-status');
  const linkedInCopy = byId('linkedin-copy');
  const linkedInSave = byId('linkedin-save');
  const linkedInActions = [byId('linkedin-text'), byId('linkedin-image')];
  async function selectLinkedIn(mode) {
    for (const button of [...linkedInActions, linkedInCopy, linkedInSave]) button.disabled = true;
    linkedInText.hidden = linkedInImage.hidden = true;
    linkedInImage.removeAttribute('src');
    linkedInText.value = '';
    setStatus(linkedInStatus, 'Click a LinkedIn post to capture it. Escape cancels selection.');
    try {
      const result = await api.captureLinkedIn(mode);
      if (result.canceled) return setStatus(linkedInStatus, 'Selection ended.');
      if (mode === 'text') {
        if (!result.text) throw new Error('This post contains no readable text.');
        linkedInText.value = result.text;
        linkedInText.hidden = false;
      } else {
        const canvas = document.createElement('canvas');
        canvas.width = result.width;
        canvas.height = result.height;
        const context = canvas.getContext('2d');
        for (const slice of result.slices) {
          const image = new Image();
          image.src = slice.dataUrl;
          await image.decode();
          context.drawImage(image, 0, slice.y, result.width, slice.height);
        }
        linkedInImage.src = canvas.toDataURL('image/png');
        linkedInImage.hidden = false;
      }
      linkedInCopy.disabled = linkedInSave.disabled = false;
      setStatus(linkedInStatus, 'Post captured.');
    } catch (error) {
      setStatus(linkedInStatus, describe(error), 'error');
    } finally {
      for (const button of linkedInActions) button.disabled = false;
    }
  }
  linkedInActions[0].addEventListener('click', () => void selectLinkedIn('text'));
  linkedInActions[1].addEventListener('click', () => void selectLinkedIn('image'));
  for (const button of [linkedInCopy, linkedInSave]) {
    button.addEventListener('click', async () => {
      const copy = button === linkedInCopy;
      try {
        const result = linkedInImage.hidden
          ? await (copy ? api.copyText(linkedInText.value) : api.saveLinkedInText(linkedInText.value))
          : await (copy ? api.copyScreenshot(linkedInImage.src) : api.saveScreenshot(linkedInImage.src));
        if (result.ok === false) throw new Error(result.error);
        if (!result.canceled) setStatus(linkedInStatus, copy ? 'Copied.' : 'Saved.');
      } catch (error) {
        setStatus(linkedInStatus, describe(error), 'error');
      }
    });
  }

  refreshState()
    .then(() => loadNotes())
    .catch((error) => setStatus(dom.settingsStatus, describe(error), 'error'));
})();
