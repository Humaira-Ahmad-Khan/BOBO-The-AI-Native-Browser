'use strict';

/**
 * Pure formatting and page-safety rules for the BOBO tools.
 *
 * Electron-free on purpose: the Reader's "is this page safe to read?" decision
 * and the Markdown exports are exactly the kind of logic that must be unit
 * tested with plain Node.
 */

/** Sign-in, webmail, banking and password-manager hosts the Reader stays out of. */
const SENSITIVE_HOSTS = [
  'accounts.google.com',
  'mail.google.com',
  'gmail.com',
  'outlook.live.com',
  'outlook.office.com',
  'outlook.office365.com',
  'login.microsoftonline.com',
  'login.live.com',
  'mail.yahoo.com',
  'mail.proton.me',
  'protonmail.com',
  'icloud.com',
  'paypal.com',
  '1password.com',
  'lastpass.com',
  'bitwarden.com',
  'dashlane.com',
  'keeper.com',
];

/** Paths that smell like authentication, where reading text is not our business. */
const AUTH_PATH_RE = /(^|\/)(log-?in|sign-?in|sign-?up|auth|oauth|sso|session|password|reset|account|checkout)(\/|$)/i;

function hostOf(value) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function isSensitiveHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (!host) return false;
  return SENSITIVE_HOSTS.some((blocked) => host === blocked || host.endsWith(`.${blocked}`));
}

function isAuthPath(url) {
  try {
    return AUTH_PATH_RE.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** True when the Reader must not touch this URL at all. */
function isSensitiveUrl(url) {
  return isSensitiveHost(hostOf(url)) || isAuthPath(url);
}

function stamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString().replace('T', ' ').slice(0, 16);
}

/** Notes -> Markdown, used by the export dialog. */
function notesToMarkdown(notes, { title = 'BOBO notes' } = {}) {
  const lines = [`# ${title}`, ''];

  for (const note of notes) {
    lines.push(`## ${note.title || 'Untitled note'}`);
    lines.push(`_Updated ${stamp(note.updatedAt || Date.now())}_`);
    if (note.url) lines.push(`Source: ${note.url}`);
    lines.push('', note.body || '', '');
  }

  return `${lines.join('\n').trim()}\n`;
}

/** One note -> Markdown. */
function noteToMarkdown(note) {
  return notesToMarkdown([note], { title: note.title || 'Untitled note' });
}

/** Reader document -> Markdown. */
function readerToMarkdown(doc) {
  const lines = [`# ${doc.title || 'Untitled page'}`, ''];
  if (doc.url) lines.push(`Source: ${doc.url}`, '');
  for (const block of doc.blocks || []) {
    lines.push(block.kind === 'heading' ? `## ${block.text}` : block.text, '');
  }
  return `${lines.join('\n').trim()}\n`;
}

module.exports = {
  AUTH_PATH_RE,
  SENSITIVE_HOSTS,
  hostOf,
  isAuthPath,
  isSensitiveHost,
  isSensitiveUrl,
  noteToMarkdown,
  notesToMarkdown,
  readerToMarkdown,
  stamp,
};
