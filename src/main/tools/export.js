'use strict';

/**
 * BOBO Data Export Service.
 *
 * Safe DOM table extraction, RFC 4180 CSV generation with formula injection
 * protection, CSV merging, PDF report generation, and column preset management.
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const { cleanText, safeFileName } = require('./lib');

const DANGEROUS_FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r'];

/**
 * Escape a CSV value according to RFC 4180 and prevent spreadsheet formula injection.
 * Preserves leading zeros in phone numbers and identifiers.
 */
function escapeCsvCell(rawVal) {
  if (rawVal == null) return '""';
  let str = String(rawVal);

  // Formula injection defense: prepend single quote if starting with formula chars
  if (DANGEROUS_FORMULA_PREFIXES.some((prefix) => str.startsWith(prefix))) {
    str = `'${str}`;
  }

  // Keep identifiers as literal CSV text, never turn leading zeros into formulas.

  // Double quotes inside strings
  if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return `"${str}"`;
}

/**
 * Generate a valid UTF-8 CSV string with BOM for Excel compatibility.
 */
function formatCsv(columns, rows) {
  const headerLine = columns.map(escapeCsvCell).join(',');
  const rowLines = rows.map((row) =>
    columns.map((col, idx) => escapeCsvCell(row[idx] ?? row[col] ?? '')).join(',')
  );
  // Prepend UTF-8 BOM (\uFEFF)
  return `\uFEFF${headerLine}\r\n${rowLines.join('\r\n')}\r\n`;
}

/**
 * Parse a standard CSV line taking into account quotes and commas.
 */
function parseCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(cleanParsedCell(current));
      current = '';
    } else {
      current += char;
    }
  }
  result.push(cleanParsedCell(current));
  return result;
}

function cleanParsedCell(val) {
  val = val.trim();
  if (/^=\d+$/.test(val)) return val.slice(1);
  if (val.startsWith('="') && val.endsWith('"')) {
    val = val.slice(2, -1);
  } else if (val.startsWith("'")) {
    val = val.slice(1);
  }
  return val;
}

/**
 * Read and merge multiple CSV files, verifying headers and deduplicating by key.
 */
async function mergeCsvFiles(filePaths, options = {}) {
  if (!Array.isArray(filePaths) || filePaths.length === 0) {
    throw new Error('BOBO: No CSV files selected for merging');
  }

  const { dedupeKey = null } = options;
  let masterHeaders = null;
  const mergedRows = [];
  const seenKeys = new Set();
  let dedupeColIdx = -1;

  for (const file of filePaths) {
    const content = await fs.readFile(file, 'utf8');
    // Strip BOM if present
    const cleanContent = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
    const lines = cleanContent.split(/\r?\n/).filter((line) => line.trim().length > 0);
    if (!lines.length) continue;

    const fileHeaders = parseCsvLine(lines[0]);
    if (!masterHeaders) {
      masterHeaders = fileHeaders;
      if (dedupeKey) {
        dedupeColIdx = masterHeaders.findIndex(
          (h) => h.toLowerCase() === dedupeKey.toLowerCase()
        );
      }
    } else {
      // Verify compatibility
      const sameHeaders =
        masterHeaders.length === fileHeaders.length &&
        masterHeaders.every((h, i) => h.toLowerCase() === fileHeaders[i].toLowerCase());
      if (!sameHeaders) {
        throw new Error(
          `BOBO: Header mismatch in file ${path.basename(file)}. Expected: [${masterHeaders.join(', ')}], found: [${fileHeaders.join(', ')}]`
        );
      }
    }

    // Process data rows
    for (let i = 1; i < lines.length; i++) {
      const row = parseCsvLine(lines[i]);
      if (row.length === 1 && !row[0]) continue;

      if (dedupeColIdx >= 0 && dedupeColIdx < row.length) {
        const key = row[dedupeColIdx].trim();
        if (key && seenKeys.has(key)) continue;
        if (key) seenKeys.add(key);
      }
      mergedRows.push(row);
    }
  }

  if (!masterHeaders) throw new Error('BOBO: All selected CSV files were empty');

  const mergedCsv = formatCsv(masterHeaders, mergedRows);
  return {
    ok: true,
    headers: masterHeaders,
    rowCount: mergedRows.length,
    fileCount: filePaths.length,
    csv: mergedCsv,
  };
}

/**
 * In-page inspection script executed in active WebContents to detect visible table.
 */
const TABLE_DETECTION_SCRIPT = `
(() => {
  try {
    // 1. Locate primary data table
    const tables = Array.from(document.querySelectorAll('table, mat-table, [role="table"], [role="grid"]'));
    const rowSelector = 'tr, mat-row, [role="row"]';
    const headerSelector = 'th, mat-header-cell, [role="columnheader"]';
    if (!tables.length) {
      return { ok: true, detected: false, message: 'No <table> elements found on page.' };
    }

    // Pick table with most rows or with th elements
    let bestTable = tables[0];
    let maxScore = -1;
    for (const t of tables) {
      const rows = t.querySelectorAll(rowSelector).length;
      const ths = t.querySelectorAll(headerSelector).length;
      const score = rows + ths * 3;
      if (score > maxScore) {
        maxScore = score;
        bestTable = t;
      }
    }

    // Extract headers
    let thElements = Array.from(bestTable.querySelectorAll(headerSelector));
    if (!thElements.length) {
      thElements = Array.from(bestTable.querySelectorAll('tr:first-child th, tr:first-child td'));
    }
    const columns = thElements.map((th, i) => th.textContent.replace(/\\s+/g, ' ').trim() || ('Col ' + (i + 1)));

    // Extract visible rows
    const rows = Array.from(bestTable.querySelectorAll(rowSelector)).flatMap((row) => {
      if (row.hidden || row.closest('thead, tfoot') || row.querySelector(headerSelector)) return [];
      const cells = Array.from(row.querySelectorAll('td, mat-cell, [role="cell"], [role="gridcell"]'));
      if (cells.length !== columns.length || cells.some(cell => cell.colSpan > 1)) return [];
      if (cells.some(cell => thElements.includes(cell))) return [];
      return [cells.map(cell => cell.textContent.replace(/\\s+/g, ' ').trim())];
    });

    // Extract pagination / record count info
    let totalRecords = rows.length;
    let currentPage = 1;
    let pageSize = rows.length || 10;
    const bodyText = document.body.innerText || '';

    // Look for "Showing 1 to 10 of 27,888 entries" pattern
    const match = bodyText.match(/showing\\s+\\d+\\s+to\\s+\\d+\\s+of\\s+([\\d,]+)\\s+(?:entries|records|items)/i);
    if (match) {
      const parsed = parseInt(match[1].replace(/,/g, ''), 10);
      if (!isNaN(parsed)) totalRecords = parsed;
    }
    const range = document.querySelector('.mat-mdc-paginator-range-label, .mat-paginator-range-label')
      ?.textContent.match(/([\\d,]+)\\s*[-–]\\s*([\\d,]+)\\s+of\\s+([\\d,]+)/i);
    if (range) {
      const [first, last, total] = range.slice(1).map(value => Number(value.replace(/,/g, '')));
      totalRecords = Math.max(rows.length, total);
      const sizeText = document.querySelector('.mat-mdc-paginator-page-size-value, .mat-paginator-page-size-value, .mat-mdc-paginator-page-size .mat-mdc-select-value-text, .mat-paginator-page-size .mat-select-value-text')?.textContent
        || document.querySelector('mat-paginator select, .mat-paginator select, .mat-mdc-paginator select')?.value;
      const size = Number((sizeText || '').replace(/[^0-9]/g, ''));
      pageSize = size || Math.max(pageSize, last - first + 1);
      currentPage = Math.floor((first - 1) / pageSize) + 1;
    }

    // Check pagination active element
    const activePageEl = document.querySelector('.pagination .active, .pagination .current, [aria-current="page"]');
    if (activePageEl) {
      const p = parseInt(activePageEl.textContent.trim(), 10);
      if (!isNaN(p)) currentPage = p;
    }

    // Table title/caption
    let tableName = 'Web Data Table';
    const caption = bestTable.querySelector('caption');
    if (caption) tableName = caption.textContent.trim();
    else if (document.title) tableName = document.title.split(/[-|]/)[0].trim();

    return {
      ok: true,
      detected: true,
      tableName,
      columns,
      rows,
      sampleRows: rows.slice(0, 10),
      rowCount: rows.length,
      totalRecords,
      rangeStart: range ? Number(range[1].replace(/,/g, '')) : null,
      rangeEnd: range ? Number(range[2].replace(/,/g, '')) : null,
      paginationDetected: Boolean(document.querySelector('mat-paginator, .mat-paginator, .mat-mdc-paginator')),
      currentPage,
      pageSize,
      totalPages: Math.max(1, currentPage, Math.ceil(totalRecords / pageSize)),
      url: window.location.href
    };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
})()
`;

/**
 * Generate formatted HTML report for PDF printing.
 */
function buildPdfHtml({ title, url, columns, rows, metadata = {} }) {
  const htmlText = (value, max) => cleanText(value, max)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const dateStr = new Date().toLocaleString();
  const filterDesc = metadata.filterDesc ? `<p class="pdf-filter"><strong>Active Filters:</strong> ${htmlText(metadata.filterDesc, 500)}</p>` : '';
  const totalCount = rows.length;

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${htmlText(title, 100)}</title>
  <style>
    @page {
      size: ${columns.length > 6 ? 'landscape' : 'portrait'};
      margin: 14mm 10mm 14mm 10mm;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
      font-size: 10px;
      color: #192734;
      margin: 0;
      padding: 0;
    }
    .pdf-header {
      border-bottom: 2px solid #5c8aa6;
      padding-bottom: 8px;
      margin-bottom: 12px;
    }
    .pdf-title {
      font-size: 16px;
      font-weight: 700;
      color: #192734;
      margin: 0 0 4px;
    }
    .pdf-meta {
      font-size: 9px;
      color: #5c8aa6;
      display: flex;
      justify-content: space-between;
      margin: 0;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      page-break-inside: auto;
    }
    thead {
      display: table-header-group;
    }
    tr {
      page-break-inside: avoid;
      page-break-after: auto;
    }
    th {
      background: #192734;
      color: #ffffff;
      font-weight: 600;
      text-align: left;
      padding: 5px 6px;
      border: 1px solid #c2dbe8;
      font-size: 9.5px;
    }
    td {
      padding: 4px 6px;
      border: 1px solid #d9e7ef;
      font-size: 9px;
      word-break: break-word;
    }
    tbody tr:nth-child(even) {
      background: #f4f9fc;
    }
    .pdf-footer {
      margin-top: 10px;
      font-size: 8.5px;
      color: #7d9aac;
      display: flex;
      justify-content: space-between;
    }
  </style>
</head>
<body>
  <header class="pdf-header">
    <h1 class="pdf-title">${htmlText(title, 100)}</h1>
    <div class="pdf-meta">
      <span>Source: ${htmlText(url, 150)}</span>
      <span>Generated: ${dateStr}</span>
    </div>
    ${filterDesc}
  </header>
  <table>
    <thead>
      <tr>
        ${columns.map((c) => `<th>${htmlText(c, 50)}</th>`).join('')}
      </tr>
    </thead>
    <tbody>
      ${rows
        .map(
          (row) => `<tr>${columns.map((c, idx) => `<td>${htmlText(row[idx] ?? row[c] ?? '', 200)}</td>`).join('')}</tr>`
        )
        .join('')}
    </tbody>
  </table>
  <footer class="pdf-footer">
    <span>BOBO Data Export &bull; Total records: ${totalCount}</span>
    <span>CONFIDENTIAL &bull; Authorized use only</span>
  </footer>
</body>
</html>`;
}

class DataExportService {
  #store;

  constructor({ store }) {
    this.#store = store;
  }

  #db() {
    return this.#store.open();
  }

  async inspectTable(webContents) {
    if (!webContents || webContents.isDestroyed()) {
      throw new Error('BOBO: Active tab web contents unavailable');
    }
    return webContents.executeJavaScript(TABLE_DETECTION_SCRIPT);
  }

  savePreset(payload = {}) {
    const domain = cleanText(payload.domain, 100) || 'default';
    const name = cleanText(payload.name, 80);
    if (!name) throw new Error('BOBO: Preset name required');
    const cols = Array.isArray(payload.columns) ? payload.columns : [];
    if (!cols.length) throw new Error('BOBO: At least one column must be selected');

    const json = JSON.stringify(cols);
    const now = Date.now();
    const result = this.#db()
      .prepare(
        'INSERT INTO column_presets (domain, name, columns_json, created_at) VALUES (?, ?, ?, ?)'
      )
      .run(domain, name, json, now);
    return { id: Number(result.lastInsertRowid), domain, name, columns: cols };
  }

  listPresets(payload = {}) {
    const domain = cleanText(payload && payload.domain, 100);
    let rows;
    if (domain) {
      rows = this.#db()
        .prepare('SELECT * FROM column_presets WHERE domain = ? OR domain = "default" ORDER BY id DESC')
        .all(domain);
    } else {
      rows = this.#db().prepare('SELECT * FROM column_presets ORDER BY id DESC').all();
    }
    return rows.map((r) => ({
      id: r.id,
      domain: r.domain,
      name: r.name,
      columns: JSON.parse(r.columns_json || '[]'),
      createdAt: r.created_at,
    }));
  }

  deletePreset(payload = {}) {
    const id = Number(payload.id);
    if (!id) throw new Error('BOBO: Invalid preset id');
    this.#db().prepare('DELETE FROM column_presets WHERE id = ?').run(id);
    return { ok: true, id };
  }
}

module.exports = {
  DataExportService,
  formatCsv,
  escapeCsvCell,
  parseCsvLine,
  mergeCsvFiles,
  buildPdfHtml,
};
