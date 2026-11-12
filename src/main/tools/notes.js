'use strict';

/**
 * Quick Notes storage: a local JSON file, no account, no network.
 *
 * Notes are validated here (title/body ceilings, http(s)-only source URL) so a
 * compromised renderer cannot stuff the file with arbitrary payloads.
 */

const crypto = require('node:crypto');
const { JsonFile, LIMITS, noteId, optionalText, optionalUrl, requireText } = require('./lib');
const { noteToMarkdown, notesToMarkdown } = require('./format');

const EMPTY = { version: 1, notes: [] };

/** Ceiling: a personal notes file does not need more than this. */
const MAX_NOTES = 2000;

function readNoteInput(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('BOBO: invalid note');

  const note = {
    id: payload.id ? noteId(payload.id) : '',
    title: requireText(payload.title, LIMITS.title, 'title'),
    body: optionalText(payload.body, LIMITS.body),
    url: optionalUrl(payload.url),
    pageTitle: optionalText(payload.pageTitle, LIMITS.title),
  };

  if (!note.body && !note.title) throw new Error('BOBO: empty note');
  return note;
}

class NotesService {
  #json;

  constructor({ file }) {
    this.#json = new JsonFile(file, EMPTY);
  }

  get file() {
    return this.#json.file;
  }

  async #readNotes() {
    const data = await this.#json.read();
    return Array.isArray(data.notes) ? data.notes : [];
  }

  async #writeNotes(notes) {
    await this.#json.write({ version: EMPTY.version, notes });
  }

  async list() {
    const notes = await this.#readNotes();
    return {
      notes: notes.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
      recovered: this.#json.recovered,
      storage: this.#json.file,
    };
  }

  /** Create (no id) or update (id) one note. */
  async save(payload) {
    const input = readNoteInput(payload);
    const notes = await this.#readNotes();
    const now = Date.now();

    if (input.id) {
      const existing = notes.find((note) => note.id === input.id);
      if (!existing) throw new Error('BOBO: note not found');
      Object.assign(existing, input, { updatedAt: now });
      await this.#writeNotes(notes);
      return { ok: true, note: existing };
    }

    if (notes.length >= MAX_NOTES) throw new Error('BOBO: note limit reached');

    const note = {
      ...input,
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    notes.unshift(note);
    await this.#writeNotes(notes);
    return { ok: true, note };
  }

  async remove(payload) {
    const id = noteId(payload && payload.id);
    const notes = await this.#readNotes();
    const next = notes.filter((note) => note.id !== id);
    if (next.length === notes.length) return { ok: false, error: 'That note no longer exists.' };
    await this.#writeNotes(next);
    return { ok: true, removed: id };
  }

  async clear() {
    await this.#writeNotes([]);
    return { ok: true };
  }

  /** Markdown for one note, or for all of them. */
  async markdown(payload) {
    const notes = await this.#readNotes();
    if (payload && payload.id) {
      const note = notes.find((entry) => entry.id === noteId(payload.id));
      if (!note) throw new Error('BOBO: note not found');
      return { text: noteToMarkdown(note), name: note.title };
    }
    if (!notes.length) throw new Error('BOBO: there are no notes to export');
    return { text: notesToMarkdown(notes), name: 'bobo-notes' };
  }
}

module.exports = { MAX_NOTES, NotesService, readNoteInput };
