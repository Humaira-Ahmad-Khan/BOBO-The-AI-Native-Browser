'use strict';

/**
 * The Google services shortcut launcher.
 *
 * This is a LOCAL list of shortcuts, not Google's account-specific app list.
 * The main process owns the catalog so the renderer can never invent a URL or
 * an id, and so launcher preferences are validated against a fixed set.
 *
 * Deliberately Electron-free so `node --test` can load it with plain Node.
 */

/** Official service entry points. Order is the launcher's default order. */
const GOOGLE_APPS = [
  { id: 'account', name: 'Google Account', url: 'https://myaccount.google.com/', icon: 'google-account.svg' },
  { id: 'drive', name: 'Google Drive', url: 'https://drive.google.com/', icon: 'google-drive.svg' },
  { id: 'gmail', name: 'Gmail', url: 'https://mail.google.com/', icon: 'gmail.svg' },
  { id: 'youtube', name: 'YouTube', url: 'https://www.youtube.com/', icon: 'youtube.svg' },
  { id: 'maps', name: 'Google Maps', url: 'https://maps.google.com/', icon: 'google-maps.svg' },
  { id: 'search', name: 'Google Search', url: 'https://www.google.com/', icon: 'google-search.svg' },
  { id: 'calendar', name: 'Google Calendar', url: 'https://calendar.google.com/', icon: 'google-calendar.svg' },
  { id: 'news', name: 'Google News', url: 'https://news.google.com/', icon: 'google-news.svg' },
  { id: 'photos', name: 'Google Photos', url: 'https://photos.google.com/', icon: 'google-photos.svg' },
  { id: 'meet', name: 'Google Meet', url: 'https://meet.google.com/', icon: 'google-meet.svg' },
  { id: 'translate', name: 'Google Translate', url: 'https://translate.google.com/', icon: 'google-translate.svg' },
  { id: 'docs', name: 'Google Docs', url: 'https://docs.google.com/document/u/0/', icon: 'google-docs.svg' },
  { id: 'sheets', name: 'Google Sheets', url: 'https://docs.google.com/spreadsheets/u/0/', icon: 'google-sheets.svg' },
  { id: 'slides', name: 'Google Slides', url: 'https://docs.google.com/presentation/u/0/', icon: 'google-slides.svg' },
  { id: 'contacts', name: 'Google Contacts', url: 'https://contacts.google.com/', icon: 'google-contacts.svg' },
  { id: 'keep', name: 'Google Keep', url: 'https://keep.google.com/', icon: 'google-keep.svg' },
  { id: 'forms', name: 'Google Forms', url: 'https://docs.google.com/forms/u/0/', icon: 'google-forms.svg' },
];

const GOOGLE_APP_IDS = GOOGLE_APPS.map((app) => app.id);
const GOOGLE_APP_ID_SET = new Set(GOOGLE_APP_IDS);
const GOOGLE_APP_BY_ID = new Map(GOOGLE_APPS.map((app) => [app.id, app]));

const DEFAULT_LAUNCHER_PREFS = Object.freeze({
  order: Object.freeze(GOOGLE_APP_IDS.slice()),
  hidden: Object.freeze([]),
  openInNewTab: false,
});

function uniqueIds(value) {
  const seen = new Set();
  const ids = [];
  if (!Array.isArray(value)) return ids;
  for (const raw of value) {
    if (typeof raw !== 'string' || !GOOGLE_APP_ID_SET.has(raw) || seen.has(raw)) continue;
    seen.add(raw);
    ids.push(raw);
  }
  return ids;
}

/**
 * Validate untrusted launcher preferences.
 *
 * - unknown/duplicate ids are dropped
 * - ids missing from `order` are appended in catalog order (so new services
 *   appear even for users who reordered years ago)
 * - hidden keeps its position in `order`, so showing a service restores it
 *   where the user originally put it
 */
function normalizeLauncherPrefs(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const order = uniqueIds(source.order);
  for (const id of GOOGLE_APP_IDS) {
    if (!order.includes(id)) order.push(id);
  }
  return {
    order,
    hidden: uniqueIds(source.hidden),
    openInNewTab: source.openInNewTab === true,
  };
}

/** The catalog as the renderer needs it: no filesystem paths, no secrets. */
function publicGoogleApps() {
  return GOOGLE_APPS.map(({ id, name, url, icon }) => ({ id, name, url, icon }));
}

function googleAppById(id) {
  return GOOGLE_APP_BY_ID.get(id) || null;
}

module.exports = {
  DEFAULT_LAUNCHER_PREFS,
  GOOGLE_APPS,
  GOOGLE_APP_IDS,
  googleAppById,
  normalizeLauncherPrefs,
  publicGoogleApps,
};
