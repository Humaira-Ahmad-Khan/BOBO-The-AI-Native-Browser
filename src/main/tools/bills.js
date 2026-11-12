'use strict';

/**
 * BOBO Bills History Extraction Service.
 *
 * Automates water & sanitation bill history extraction from
 * https://elgcd.punjab.gov.pk/e-billing/water-bill-history.
 *
 * Implements persistent SQLite queue, crash recovery, pause/resume,
 * incremental saves, individual & consolidated CSV export, and PDF reporting.
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const { cleanText, safeFileName } = require('./lib');
const { formatCsv, escapeCsvCell, DataExportService } = require('./export');
const { collectTablePages } = require('./table-pages');
const BILLS_PAGE = 'https://elgcd.punjab.gov.pk/e-billing/water-bill-history';
const PAGE_ERROR = 'Open Water Sanitation Bill History in the active tab before starting extraction.';

function normalizeConnectionNumber(value) {
  let number = String(value ?? '').trim();
  // Accept spreadsheet text wrappers only, never expressions or executable formulas.
  if (number.startsWith("'")) number = number.slice(1);
  if (number.startsWith('=')) number = number.slice(1).trim();
  if (/^"\d+"$/.test(number)) number = number.slice(1, -1);
  if (!/^\d{1,80}$/.test(number)) throw new Error('BOBO: Invalid connection number. Use digits only.');
  return number;
}

/**
 * Reduce an imported cell to the connection digits it carries.
 * Quotes and thousands separators are removed ("99,010,334" -> "99010334"),
 * portal annotations such as "99010334 B" or "98010010-A" are dropped, and
 * leading zeros stay intact. Values that are not numeric IDs are returned
 * unchanged so normalizeConnectionNumber still rejects them instead of guessing.
 */
function cleanConnectionNumber(value) {
  let text = String(value ?? '').replace(/["',]/g, '').trim();
  if (text.startsWith('=')) text = text.slice(1).trim();
  const match = /^(\d{1,80})(?:[\s.-]*[A-Za-z]{0,2})$/.exec(text);
  return match ? match[1] : text;
}

const BILLS_COLUMNS = [
  'Connection No',
  'Consumer Name',
  'Consumer F/H Name',
  'Sector',
  'Locality',
  'Sr #',
  'Bill No',
  'Bill Type',
  'Billing Period',
  'Arrears',
  'Water Fee',
  'Sanitation',
  'Drainage',
  'Billing Fee',
  'Total Bill',
  'Fine',
  'After Due Date',
  'Due Date',
  'Status',
  'Amount Received',
  'Receive Date',
];

/**
 * Script injected into active WebContents to query or fill water bill history.
 */
function makeExtractionScript(connectionNo) {
  return `
(async () => {
  try {
    if (location.origin + location.pathname.replace(/\\/$/, '') !== ${JSON.stringify(BILLS_PAGE)}) {
      return { ok: false, error: ${JSON.stringify(PAGE_ERROR)} };
    }
    const connInput = document.querySelector('input#Connection_No, input[name="Connection_No"], input[name*="connection" i], input[id*="connection" i]')
      || Array.from(document.querySelectorAll('label')).find(label => /connection\\s*(?:no|number)/i.test(label.textContent))?.control
      || document.querySelector('input[placeholder*="connection" i], input[aria-label*="connection" i]');
    if (!connInput) {
      return { ok: false, error: 'Connection No input field not found on current page' };
    }

    // Set connection number
    connInput.value = ${JSON.stringify(connectionNo)};
    connInput.dispatchEvent(new Event('input', { bubbles: true }));
    connInput.dispatchEvent(new Event('change', { bubbles: true }));

    // Find Show History button
    const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], a.btn'));
    const submitBtn = buttons.find(b => (b.innerText || b.value || '').trim().toLowerCase() === 'show history');
    if (!submitBtn) {
      return { ok: false, error: 'Show History button not found' };
    }

    // Toasts already on screen belong to the previous lookup. A leftover
    // "No Records Found" toast must never classify this connection as empty.
    const TOAST = '.mat-snack-bar-container, .mat-mdc-snack-bar-container, simple-snack-bar, .mat-no-data-row, .mat-mdc-no-data-row';
    const staleToasts = new Map(Array.from(document.querySelectorAll(TOAST)).map((el) => [el, el.textContent]));
    const freshMiss = () => {
      let rest = document.body.innerText || '';
      for (const [el, text] of staleToasts) {
        if (el.isConnected && el.textContent === text) {
          const old = (el.innerText || '').trim();
          if (old) rest = rest.split(old).join(' ');
        }
      }
      return /no records? found|record not found|no bill history|no data found/i.test(rest);
    };
    return await new Promise((resolve) => {
      let changed = false;
      let lastChange = 0;
      let activeRequests = 0;
      const started = performance.now();
      // Track in-flight requests so an already-empty page is not treated as a
      // fresh miss while the portal is still fetching the real answer.
      const nativeFetch = window.fetch;
      const nativeSend = XMLHttpRequest.prototype.send;
      if (typeof nativeFetch === 'function') {
        window.fetch = function (...args) {
          activeRequests++;
          try {
            return Promise.resolve(nativeFetch.apply(this, args))
              .finally(() => { activeRequests--; });
          } catch (error) {
            activeRequests--;
            throw error;
          }
        };
      }
      XMLHttpRequest.prototype.send = function (...args) {
        activeRequests++;
        this.addEventListener('loadend', () => { activeRequests--; }, { once: true });
        return nativeSend.apply(this, args);
      };
      const restoreNetwork = () => {
        if (typeof nativeFetch === 'function') window.fetch = nativeFetch;
        XMLHttpRequest.prototype.send = nativeSend;
      };
      const relevant = (node, added = false) => {
        const element = node.nodeType === 1 ? node : node.parentElement;
        return element && (element.closest('table, #result, .mat-no-data-row, .mat-mdc-no-data-row,'
          + ' .mat-snack-bar-container, .mat-mdc-snack-bar-container, simple-snack-bar')
          || (added && (element.querySelector('table')
            || /no records? found|record not found|no bill history|no data found/i.test(element.textContent || ''))));
      };
      const observer = new MutationObserver((records) => {
        if (records.some((record) => relevant(record.target)
          || [...record.addedNodes, ...record.removedNodes].some((node) => relevant(node, true)))) {
          changed = true;
          lastChange = Date.now();
        }
      });
      const finish = (result) => {
        observer.disconnect();
        restoreNetwork();
        clearInterval(timer);
        clearTimeout(timeout);
        resolve(result);
      };
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      const timer = setInterval(() => {
        if (document.querySelector('[aria-busy="true"], mat-progress-spinner, mat-spinner')) return;
        const result = ${READ_RESULTS_SCRIPT.trim().replace(/;$/, '')};
        if (!result.ok) return;
        if (result.empty) {
          // Never accept a miss while a request is in flight, even if an old
          // toast disappearing counted as a change.
          if (activeRequests > 0) return;
          if (!freshMiss()) return;
          if (changed) {
            // A fresh "No Records Found" / "No Data Found" toast is the portal's
            // final answer. Settle briefly instead of waiting seconds.
            if (Date.now() - lastChange < 200) return;
          } else {
            // Nothing moved and nothing was requested: the portal answered
            // client-side. Skip the miss instead of waiting for a timeout.
            if (Date.now() - started < 900) return;
          }
        } else {
          if (!changed || Date.now() - lastChange < 100) return;
          if (/^\\d+$/.test(result.details.connectionNo)
            && result.details.connectionNo !== ${JSON.stringify(connectionNo)}) return;
        }
        finish(result);
      }, 50);
      const timeout = setTimeout(() => finish({ ok: false,
        error: 'Timed out waiting for a fresh bill history result. This connection was not marked empty; retry it.' }), 10000);
      try { submitBtn.click(); }
      catch (error) { finish({ ok: false, error: String(error) }); }
    });
  } catch (err) {
    return { ok: false, error: String(err) };
  }
})()
`;
}

/**
 * Script to read the extracted connection details and table after submission.
 */
const READ_RESULTS_SCRIPT = `
(() => {
  try {
    const bodyText = document.body.innerText || '';
    if (location.origin + location.pathname.replace(/\\/$/, '') !== ${JSON.stringify(BILLS_PAGE)}) {
      return { ok: false, error: ${JSON.stringify(PAGE_ERROR)} };
    }

    // Extract connection details from text or labels
    const details = {
      connectionNo: '',
      consumerName: '',
      fhName: '',
      sector: '',
      locality: ''
    };

    const extractField = (pattern) => {
      const m = bodyText.match(pattern);
      return m ? m[1].replace(/\\s+/g, ' ').trim() : '';
    };

    details.connectionNo = Array.from(document.querySelectorAll('tr')).map(row => Array.from(row.querySelectorAll('th, td')))
      .find(cells => cells.length === 2 && /^connection\\s*(?:no|number|#)\\s*:?$/i.test(cells[0].innerText.trim()))?.[1].innerText.trim() || '';
    details.consumerName = extractField(/Consumer\\s*Name\\s*[:\\-]?\\s*([^\\n\\r]+)/i);
    details.fhName = extractField(/(?:F\\/H|Father|Husband)\\s*Name\\s*[:\\-]?\\s*([^\\n\\r]+)/i);
    details.sector = extractField(/Sector\\s*[:\\-]?\\s*([^\\n\\r]+)/i);
    details.locality = extractField(/Locality\\s*[:\\-]?\\s*([^\\n\\r]+)/i);

    // Extract table rows
    const tables = Array.from(document.querySelectorAll('table'));
    let billRows = [];
    for (const t of tables) {
      const rows = Array.from(t.querySelectorAll('tr'));
      if (rows.length < 2) continue;
      const headerText = rows[0].innerText || '';
      if (headerText.toLowerCase().includes('bill') || headerText.toLowerCase().includes('period') || headerText.toLowerCase().includes('arrear')) {
        for (let i = 1; i < rows.length; i++) {
          const cells = Array.from(rows[i].querySelectorAll('td')).map(td => td.innerText.replace(/\\s+/g, ' ').trim());
          if (cells.length >= 5) {
            billRows.push(cells);
          }
        }
        break;
      }
    }

    return {
      ok: billRows.length > 0 || /no records? found|record not found|no bill history/i.test(bodyText),
      error: 'No bill history result appeared. Check that you are signed in and that Show History works manually.',
      empty: billRows.length === 0,
      paginationDetected: Boolean(document.querySelector('mat-paginator, .mat-paginator, .mat-mdc-paginator')),
      details,
      billRows
    };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
})()
`;

class BillsExtractionService {
  #processingJobs = new Set();
  #runningJobs = new Map();
  #store;
  #activeJobId = null;
  #isPaused = false;
  #isCancelled = false;

  constructor({ store }) {
    this.#store = store;
  }

  #db() {
    return this.#store.open();
  }

  createJob(payload = {}) {
    const name = cleanText(payload.name, 100) || `Bills Job ${new Date().toLocaleDateString()}`;
    const rawList = Array.isArray(payload.connectionNumbers) ? payload.connectionNumbers : [];

    // Normalize connection numbers, preserve leading zeros, remove blank lines
    // and portal annotations. Unusable values are reported, not fatal, so one
    // bad row cannot discard an entire spreadsheet import.
    const numbers = [];
    const seen = new Set();
    const invalidSamples = [];
    let invalidCount = 0;
    let duplicateCount = 0;
    let strippedCount = 0;
    const strippedSamples = [];
    for (const item of rawList) {
      if (!String(item ?? '').trim()) continue;
      let str;
      try {
        str = normalizeConnectionNumber(cleanConnectionNumber(item));
      } catch {
        invalidCount++;
        if (invalidSamples.length < 5) invalidSamples.push(String(item).trim().slice(0, 40));
        continue;
      }
      if (/[A-Za-z]/.test(String(item))) {
        strippedCount++;
        if (strippedSamples.length < 5) strippedSamples.push(`${String(item).trim().slice(0, 20)} -> ${str}`);
      }
      if (seen.has(str)) duplicateCount++;
      if (!seen.has(str)) {
        seen.add(str);
        numbers.push(str);
      }
    }

    if (!numbers.length) {
      throw new Error(invalidCount
        ? `BOBO: No valid connection numbers found. Skipped: ${invalidSamples.join(', ')}`
        : 'BOBO: At least one connection number is required');
    }

    const now = Date.now();
    let jobId;

    this.#store.transaction((db) => {
      const res = db
        .prepare(
          "INSERT INTO bills_jobs (name, created_at, status, total_count, done_count, fail_count, empty_count) VALUES (?, ?, 'pending', ?, 0, 0, 0)"
        )
        .run(name, now, numbers.length);
      jobId = Number(res.lastInsertRowid);

      const stmt = db.prepare(
        "INSERT INTO bills_queue (job_id, connection_no, status, consumer_info, bills_data, error, retry_count, updated_at) VALUES (?, ?, 'pending', '', '', '', 0, ?)"
      );
      for (const num of numbers) {
        stmt.run(jobId, num, now);
      }
    });

    return { ...this.getJob(jobId), invalidCount, invalidSamples, duplicateCount, strippedCount, strippedSamples };
  }

  getJob(jobId) {
    const job = this.#db().prepare('SELECT * FROM bills_jobs WHERE id = ?').get(Number(jobId));
    if (!job) return null;

    const counts = this.#db()
      .prepare(
        `SELECT
           COUNT(*) as total,
           SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
           SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
           SUM(CASE WHEN status = 'empty' THEN 1 ELSE 0 END) as empty,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
           SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) as skipped
         FROM bills_queue WHERE job_id = ?`
      )
      .get(Number(jobId));

    return {
      id: job.id,
      name: job.name,
      status: counts.total > 0 && counts.total === (counts.completed || 0) + (counts.empty || 0) + (counts.skipped || 0)
        ? 'completed' : job.status,
      createdAt: job.created_at,
      total: counts.total || 0,
      completed: counts.completed || 0,
      pending: counts.pending || 0,
      empty: counts.empty || 0,
      failed: counts.failed || 0,
      skipped: counts.skipped || 0,
    };
  }

  listJobs() {
    const rows = this.#db().prepare('SELECT id FROM bills_jobs ORDER BY id DESC LIMIT 50').all();
    return rows.map((r) => this.getJob(r.id)).filter(Boolean);
  }

  recoverInterrupted() {
    return this.#db().prepare(
      "UPDATE bills_queue SET status = 'pending', error = '', updated_at = ? WHERE status = 'processing'"
    ).run(Date.now()).changes;
  }

  getQueue(jobId, recent = false) {
    const rows = this.#db()
      .prepare(`SELECT id, connection_no, status, error, retry_count, updated_at,
        CASE WHEN status = 'completed' AND json_valid(bills_data) THEN json_array_length(bills_data) ELSE 0 END AS bill_count
        FROM bills_queue WHERE job_id = ? ${recent === true
          ? "ORDER BY CASE status WHEN 'processing' THEN 0 WHEN 'pending' THEN 2 ELSE 1 END, CASE WHEN status = 'pending' THEN id END ASC, updated_at DESC, id DESC LIMIT 10"
          : 'ORDER BY id ASC'}`)
      .all(Number(jobId));
    return rows.map((r) => ({
      id: r.id,
      connectionNo: r.connection_no,
      status: r.status,
      error: r.error,
      retryCount: r.retry_count,
      updatedAt: r.updated_at,
      billCount: r.bill_count,
    }));
  }

  pause() {
    this.#isPaused = true;
    if (this.#activeJobId) {
      this.#db().prepare("UPDATE bills_jobs SET status = 'paused' WHERE id = ?").run(this.#activeJobId);
    }
    return { ok: true, status: 'paused' };
  }

  resume() {
    this.#isPaused = false;
    this.#isCancelled = false;
    if (this.#activeJobId) {
      this.#db().prepare("UPDATE bills_jobs SET status = 'processing' WHERE id = ?").run(this.#activeJobId);
    }
    return { ok: true, status: 'processing' };
  }

  stop() {
    this.#isCancelled = true;
    if (this.#activeJobId) {
      this.#db().prepare("UPDATE bills_jobs SET status = 'stopped' WHERE id = ?").run(this.#activeJobId);
    }
    return { ok: true, status: 'stopped' };
  }

  retryFailed(jobId) {
    const now = Date.now();
    this.#db()
      .prepare("UPDATE bills_queue SET status = 'pending', error = '' WHERE job_id = ? AND status = 'failed'")
      .run(Number(jobId));
    this.#db().prepare("UPDATE bills_jobs SET status = 'pending' WHERE id = ?").run(Number(jobId));
    return this.getJob(jobId);
  }

  /** Put every "empty" result back in the queue so it is looked up again. */
  retryEmpty(jobId) {
    this.#assertIdle(jobId);
    const requeued = this.#db()
      .prepare("UPDATE bills_queue SET status = 'pending', error = '', updated_at = ? WHERE job_id = ? AND status = 'empty'")
      .run(Date.now(), Number(jobId)).changes;
    if (requeued) this.#db().prepare("UPDATE bills_jobs SET status = 'pending' WHERE id = ?").run(Number(jobId));
    return { requeued, job: this.getJob(jobId) };
  }

  setRunning(jobId, running, owner) {
    if (!Number.isSafeInteger(jobId) || jobId <= 0 || typeof running !== 'boolean' || (running && !this.getJob(jobId))) {
      throw new Error('BOBO: Invalid extraction run.');
    }
    if (this.#runningJobs.has(jobId) && this.#runningJobs.get(jobId) !== owner) {
      throw new Error('BOBO: This queue is running in another window.');
    }
    if (running) this.#runningJobs.set(jobId, owner);
    else this.#runningJobs.delete(jobId);
    return { ok: true };
  }

  releaseOwner(owner) {
    for (const [id, runningOwner] of this.#runningJobs) if (runningOwner === owner) this.#runningJobs.delete(id);
  }

  #assertIdle(jobId) {
    if (this.#runningJobs.has(Number(jobId)) || this.#processingJobs.has(Number(jobId))
      || this.#db().prepare("SELECT id FROM bills_queue WHERE job_id = ? AND status = 'processing' LIMIT 1").get(Number(jobId))) {
      throw new Error('BOBO: Stop this queue and wait for the current lookup to finish before clearing it.');
    }
  }

  clearAllJobs() {
    // Include older jobs beyond the 50-job UI list.
    for (const row of this.#db().prepare('SELECT id FROM bills_jobs').all()) this.#assertIdle(row.id);
    this.#store.transaction((db) => db.prepare('DELETE FROM bills_jobs').run());
    return { ok: true };
  }

  repairSpreadsheetIds(jobId) {
    if (!Number.isSafeInteger(jobId) || jobId <= 0 || !this.getJob(jobId)) {
      throw new Error('BOBO: Invalid saved job.');
    }
    if (this.#processingJobs.has(jobId) || this.#runningJobs.has(jobId)) throw new Error('BOBO: Stop extraction before repairing the queue.');
    let repaired = 0;
    let requeued = 0;
    let alreadyCompleted = 0;
    this.#store.transaction((db) => {
      const rows = db.prepare('SELECT id, connection_no, status FROM bills_queue WHERE job_id = ? ORDER BY id').all(jobId);
      if (rows.some((row) => row.status === 'processing')) throw new Error('BOBO: Stop extraction before repairing the queue.');
      const completed = new Set();
      for (const row of rows.filter((item) => item.status === 'completed')) {
        try { completed.add(normalizeConnectionNumber(row.connection_no)); } catch { /* Preserve existing results. */ }
      }
      const update = db.prepare('UPDATE bills_queue SET connection_no = ?, status = ?, error = ?, updated_at = ? WHERE id = ?');
      for (const row of rows) {
        if (row.status === 'completed') continue;
        let number;
        try { number = normalizeConnectionNumber(row.connection_no); } catch { continue; }
        if (number === row.connection_no) continue;
        const retry = ['empty', 'failed', 'skipped'].includes(row.status);
        const saved = completed.has(number);
        // Completed rows are never changed or queried again, including canonical duplicates.
        update.run(number, saved ? 'skipped' : retry ? 'pending' : row.status,
          saved ? 'Already completed in this saved job' : '', Date.now(), row.id);
        repaired++;
        if (saved) alreadyCompleted++;
        else if (retry) requeued++;
      }
      if (requeued) db.prepare("UPDATE bills_jobs SET status = 'pending' WHERE id = ?").run(jobId);
    });
    return { repaired, requeued, alreadyCompleted, job: this.getJob(jobId) };
  }

  clearJob(jobId) {
    this.#assertIdle(jobId);
    this.#db().prepare('DELETE FROM bills_jobs WHERE id = ?').run(Number(jobId));
    return { ok: true, id: Number(jobId) };
  }

  /**
   * Safe automation step to query single connection or loop through queue.
   */
  async processSingle(webContents, jobId, queueItemId) {
    const key = Number(jobId);
    if (this.#processingJobs.has(key)) throw new Error('BOBO: This job already has a lookup in progress.');
    this.#processingJobs.add(key);
    try { return await this.#processSingle(webContents, jobId, queueItemId); }
    finally { this.#processingJobs.delete(key); }
  }

  async #processSingle(webContents, jobId, queueItemId) {
    if (!webContents || webContents.isDestroyed()) {
      return { ok: false, error: 'The billing tab was closed. Open Water Sanitation Bill History and start the remaining queue again.' };
    }
    const currentUrl = webContents?.getURL().split(/[?#]/, 1)[0].replace(/\/$/, '');
    if (currentUrl !== BILLS_PAGE) return { ok: false, error: PAGE_ERROR };
    const row = this.#db().prepare("SELECT * FROM bills_queue WHERE id = ? AND job_id = ? AND status = 'pending'")
      .get(Number(queueItemId), Number(jobId));
    if (!row) throw new Error('BOBO: Queue item not found');

    const connNo = normalizeConnectionNumber(row.connection_no);
    if (connNo !== row.connection_no) {
      this.#db().prepare('UPDATE bills_queue SET connection_no = ? WHERE id = ?').run(connNo, row.id);
    }
    this.#db().prepare("UPDATE bills_queue SET status = 'processing', updated_at = ? WHERE id = ?").run(Date.now(), row.id);

    // 1. Submit connection number
    const execute = async (script) => {
      try {
        return await webContents.executeJavaScript(script);
      } catch {
        return { ok: false, error: 'The billing page became unavailable during extraction.' };
      }
    };
    let readRes = await execute(makeExtractionScript(connNo));
    if (readRes?.ok && readRes.empty) {
      // Never trust a single miss: look the connection up once more before
      // calling it empty. If the confirmation cannot be completed the row
      // fails (retryable) instead of silently losing a real history.
      await new Promise((resolve) => setTimeout(resolve, 800));
      readRes = await execute(makeExtractionScript(connNo));
    }
    if (!readRes || !readRes.ok) {
      this.#db()
        .prepare("UPDATE bills_queue SET status = 'failed', error = ?, retry_count = retry_count + 1, updated_at = ? WHERE id = ?")
        .run(readRes?.error || 'Submission failed', Date.now(), row.id);
      return { ok: false, error: readRes?.error };
    }
    const now = Date.now();

    if (readRes.empty) {
      this.#db()
        .prepare("UPDATE bills_queue SET status = 'empty', error = 'No bills found', updated_at = ? WHERE id = ?")
        .run(now, row.id);
      return { ok: true, empty: true, connectionNo: connNo };
    }

    if (readRes.paginationDetected) {
      try {
        const inspector = new DataExportService({ store: this.#store });
        const first = await inspector.inspectTable(webContents);
        if (!first.columns?.some((column) => /bill|period|arrear/i.test(column))) {
          throw new Error('The bill history table could not be identified.');
        }
        const all = await collectTablePages(webContents, (wc) => inspector.inspectTable(wc), {
          scope: 'all', pageSize: 'default', url: webContents.getURL(), columns: first.columns,
        });
        readRes.billRows = all.rows;
      } catch (error) {
        this.#db().prepare("UPDATE bills_queue SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
          .run(`Incomplete bill history: ${error.message}`, Date.now(), row.id);
        return { ok: false, error: `Incomplete bill history: ${error.message}` };
      }
    }

    // Store completed results
    const infoJson = JSON.stringify(readRes.details || {});
    const billsJson = JSON.stringify(readRes.billRows || []);
    this.#db()
      .prepare("UPDATE bills_queue SET status = 'completed', consumer_info = ?, bills_data = ?, error = '', updated_at = ? WHERE id = ?")
      .run(infoJson, billsJson, now, row.id);

    return { ok: true, completed: true, connectionNo: connNo, count: (readRes.billRows || []).length };
  }

  /**
   * Export just the connection numbers of a job, filtered by result, so a CSV
   * without empty connections can be reused for a future import.
   * "non-empty" keeps every row the portal did not answer with no records.
   */
  exportConnectionListCsv(jobId, mode = 'non-empty') {
    const where = mode === 'empty' ? "status = 'empty'"
      : mode === 'failed' ? "status = 'failed'" : "status <> 'empty'";
    const rows = this.#db()
      .prepare(`SELECT connection_no FROM bills_queue WHERE job_id = ? AND ${where} ORDER BY id`)
      .all(Number(jobId));
    const seen = new Set();
    const numbers = [];
    for (const row of rows) {
      if (seen.has(row.connection_no)) continue;
      seen.add(row.connection_no);
      numbers.push([row.connection_no]);
    }
    return { csv: formatCsv(['Connection No'], numbers), count: numbers.length };
  }

  /**
   * Export all completed records for a job to combined CSV.
   */
  exportCombinedCsv(jobId) {
    const rows = this.#db()
      .prepare("SELECT connection_no, consumer_info, bills_data FROM bills_queue WHERE job_id = ? AND status = 'completed'")
      .all(Number(jobId));

    if (!rows.length) throw new Error('BOBO: No completed records found to export');

    const csvRows = [];

    for (const r of rows) {
      const details = JSON.parse(r.consumer_info || '{}');
      const bills = JSON.parse(r.bills_data || '[]');

      for (const b of bills) {
        csvRows.push([
          r.connection_no,
          details.consumerName || '',
          details.fhName || '',
          details.sector || '',
          details.locality || '',
          b[0] || '', // Sr #
          b[1] || '', // Bill No
          b[2] || '', // Bill Type
          b[3] || '', // Billing Period
          b[4] || '', // Arrears
          b[5] || '', // Water Fee
          b[6] || '', // Sanitation
          b[7] || '', // Drainage
          b[8] || '', // Billing Fee
          b[9] || '', // Total Bill
          b[10] || '', // Fine
          b[11] || '', // After Due Date
          b[12] || '', // Due Date
          b[13] || '', // Status
          b[14] || '', // Amount Received
          b[15] || '', // Receive Date
        ]);
      }
    }

    return formatCsv(BILLS_COLUMNS, csvRows);
  }

  /**
   * Export single connection to individual CSV.
   */
  exportIndividualCsv(jobId, connectionNo) {
    const row = this.#db()
      .prepare("SELECT connection_no, consumer_info, bills_data FROM bills_queue WHERE job_id = ? AND connection_no = ? AND status = 'completed'")
      .get(Number(jobId), String(connectionNo));

    if (!row) throw new Error(`BOBO: No completed data for connection ${connectionNo}`);
    return this.#individualCsv(row);
  }

  #individualCsv(row) {
    const details = JSON.parse(row.consumer_info || '{}');
    const bills = JSON.parse(row.bills_data || '[]');
    const csvRows = bills.map((b) => [
      row.connection_no,
      details.consumerName || '',
      details.fhName || '',
      details.sector || '',
      details.locality || '',
      ...b,
    ]);

    return formatCsv(BILLS_COLUMNS, csvRows);
  }

  async exportHistoryFolder(jobId, parent, date = new Date()) {
    // Serial = position in the imported list, so a gap in the numbering is
    // always explained by the summary (empty / failed / not processed).
    // jobId may be one id or a list: several batches (e.g. Regular, then
    // Suspended) export into ONE folder with one continuous serial and summary.
    const jobIds = (Array.isArray(jobId) ? jobId : [jobId]).map(Number);
    const everyRow = this.#db().prepare(
      `SELECT id, connection_no, status, consumer_info, bills_data, error FROM bills_queue
       WHERE job_id IN (${jobIds.map(() => '?').join(',')}) ORDER BY job_id, id`
    ).all(...jobIds);
    const width = Math.max(3, String(everyRow.length).length);
    everyRow.forEach((row, index) => { row.serial = String(index + 1).padStart(width, '0'); });
    const rows = everyRow.filter((row) => row.status === 'completed');
    if (!rows.length) throw new Error('BOBO: No completed records found to export');
    const sectorOf = (row) => {
      try { return cleanText(JSON.parse(row.consumer_info || '{}').sector, 200) || 'Unknown Sector'; } catch { return 'Unknown Sector'; }
    };

    const stamp = [date.getDate(), date.getMonth() + 1, date.getFullYear() % 100]
      .map((part) => String(part).padStart(2, '0')).join('-');
    const directory = path.join(parent, `${stamp} receiving amount history`);
    const makeDirectory = async (folder) => {
      await fs.mkdir(folder).catch((error) => {
        if (error.code !== 'EEXIST') throw error;
      });
      if (!(await fs.lstat(folder)).isDirectory()) throw new Error(`Unsafe export folder: ${folder}`);
    };
    await makeDirectory(directory);
    const files = [];
    let skipped = 0;
    let failed = 0;
    const fileOf = new Map();
    for (const row of rows) {
      try {
        if (!/^\d+$/.test(row.connection_no)) throw new Error('Invalid connection number');
        let sector = safeFileName(JSON.parse(row.consumer_info || '{}').sector, 'Unknown Sector').replace(/[. ]+$/, '');
        if (/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(sector)) sector = `_${sector}`;
        const folder = path.join(directory, sector || 'Unknown Sector');
        await makeDirectory(folder);
        const fileName = `${row.serial} - ${row.connection_no}.csv`;
        const filePath = path.join(folder, fileName);
        const csv = this.#individualCsv(row);
        try {
          await fs.writeFile(filePath, csv, { encoding: 'utf8', flag: 'wx' });
          files.push({ filePath, totalBytes: Buffer.byteLength(csv, 'utf8') });
          fileOf.set(row.id, 'saved');
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          fileOf.set(row.id, 'already existed');
          throw error;
        }
      } catch (error) {
        if (error.code === 'EEXIST') skipped++;
        else { failed++; fileOf.set(row.id, 'WRITE FAILED'); }
      }
    }
    const summary = await this.#writeSummary(directory, everyRow, sectorOf, fileOf);
    return { directory, files, skipped, failed, summary };
  }

  /** Per-sector verification report: text for reading, CSV for every connection. */
  async #writeSummary(directory, everyRow, sectorOf, fileOf) {
    const label = { completed: 'Downloaded', empty: 'Empty (no history)', failed: 'FAILED - retry',
      pending: 'NOT PROCESSED', processing: 'NOT PROCESSED', skipped: 'Skipped (duplicate)' };
    const sectors = new Map();
    const totals = { given: 0, completed: 0, empty: 0, failed: 0, pending: 0, skipped: 0 };
    const detail = [];
    for (const row of everyRow) {
      const status = row.status === 'processing' ? 'pending' : row.status;
      const sector = status === 'completed' ? sectorOf(row) : 'Not downloaded (sector unknown)';
      const entry = sectors.get(sector) || { given: 0, completed: 0, empty: 0, failed: 0, pending: 0, skipped: 0 };
      entry.given++; entry[status]++; totals.given++; totals[status]++;
      sectors.set(sector, entry);
      detail.push([row.serial, row.connection_no, label[status] || status, sector,
        status === 'completed' ? (fileOf.get(row.id) || '') : '', row.error || '']);
    }
    const pad = (value, size) => String(value).padEnd(size);
    const lines = [
      'BOBO Bills History - export summary',
      `Connections given: ${totals.given}`,
      `Downloaded: ${totals.completed} | Empty: ${totals.empty} | Failed: ${totals.failed} | Not processed: ${totals.pending} | Duplicate skipped: ${totals.skipped}`,
      totals.completed + totals.empty + totals.skipped === totals.given
        ? 'CHECK: every connection is accounted for.'
        : `CHECK: ${totals.failed + totals.pending} connection(s) still need a retry/run - the numbers do not add up yet.`,
      '',
      `${pad('Sector', 46)}${pad('Given', 8)}${pad('Downloaded', 12)}${pad('Empty', 8)}${pad('Failed', 8)}Pending`,
    ];
    for (const [sector, e] of [...sectors].sort((a, b) => a[0].localeCompare(b[0]))) {
      lines.push(`${pad(sector.slice(0, 44), 46)}${pad(e.given, 8)}${pad(e.completed, 12)}${pad(e.empty, 8)}${pad(e.failed, 8)}${e.pending}`);
    }
    lines.push('', 'Note: Sector is only known for downloaded connections, so empty/failed ones are listed together.',
      'Full per-connection list: "_Export Summary.csv" in this folder.');
    await fs.writeFile(path.join(directory, '_Export Summary.txt'), lines.join('\r\n') + '\r\n', 'utf8');
    await fs.writeFile(path.join(directory, '_Export Summary.csv'),
      formatCsv(['Serial', 'Connection No', 'Result', 'Sector', 'File', 'Error'], detail), 'utf8');
    return totals;
  }
}

module.exports = {
  normalizeConnectionNumber,
  cleanConnectionNumber,
  BillsExtractionService,
  BILLS_COLUMNS,
  makeExtractionScript,
  READ_RESULTS_SCRIPT,
};
