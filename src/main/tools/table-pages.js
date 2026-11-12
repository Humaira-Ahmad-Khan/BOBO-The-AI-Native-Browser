'use strict';

const MAX_ROWS = 100000;

function pageCommand(action, size) {
  const paginator = document.querySelector('mat-paginator, .mat-paginator, .mat-mdc-paginator');
  if (!paginator) return false;
  if (action === 'size') {
    const select = paginator.querySelector('select');
    if (select) {
      const option = [...select.options].find(option => Number(option.value) === size);
      if (!option || select.value === option.value) return false;
      select.value = option.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    const selectButton = paginator.querySelector('mat-select, [role="combobox"]');
    if (!selectButton || Number(selectButton.textContent.replace(/[^0-9]/g, '')) === size) return false;
    selectButton.click();
    return 'options';
  }
  if (action === 'option') {
    const option = [...document.querySelectorAll('mat-option, [role="option"]')]
      .find(el => Number(el.textContent.replace(/[^0-9]/g, '')) === size && el.getClientRects().length);
    if (option) { option.click(); return true; }
    return false;
  }
  const button = paginator.querySelector(`.mat-mdc-paginator-navigation-${action}, .mat-paginator-navigation-${action}, button[aria-label^="${action} page" i]`);
  if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') return false;
  button.click(); return true;
}

async function collectTablePages(contents, inspect, options, progress = () => {}) {
  const { scope, from = 1, to = 1, pageSize = 'default', url, columns } = options || {};
  if (!['current', 'all', 'range'].includes(scope) ||
      !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from || to > 10000 ||
      !['default', 100, 500, 1000, 5000].includes(pageSize) ||
      !Array.isArray(columns) || !columns.length || columns.length > 200 ||
      !columns.every(column => typeof column === 'string')) throw new Error('BOBO: invalid export options');
  const check = () => {
    if (!contents || contents.isDestroyed() || contents.getURL() !== url) {
      throw new Error('The source tab closed or navigated during export. Inspect its table again.');
    }
  };
  const read = async () => {
    check();
    const page = await inspect(contents);
    check();
    if (!page?.detected || !page.rows?.length) throw new Error('No table rows are available.');
    if (JSON.stringify(page.columns) !== JSON.stringify(columns)) throw new Error('The table columns changed. Inspect again.');
    if (page.totalRecords > MAX_ROWS) throw new Error('Filter the table to 100,000 records or fewer.');
    return page;
  };
  const command = async (action, size) => {
    check();
    return contents.executeJavaScript(`(${pageCommand.toString()})(${JSON.stringify(action)},${JSON.stringify(size)})`);
  };
  const edges = page => JSON.stringify([page.rows[0], page.rows.at(-1)]);
  const waitFor = async (start, previous, size) => {
    const deadline = Date.now() + 30000;
    let signature, stable = 0;
    while (Date.now() < deadline) {
      const page = await read();
      if (page.rangeStart === start && page.rowCount === page.rangeEnd - start + 1 &&
          (!size || page.pageSize === size) && (!previous || edges(page) !== previous)) {
        const current = JSON.stringify([page.rangeStart, page.rangeEnd, page.totalRecords, edges(page)]);
        if (signature === current && Date.now() - stable >= 400) return page;
        if (signature !== current) { signature = current; stable = Date.now(); }
      } else signature = undefined;
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw new Error(`Page starting at record ${start} did not finish loading. No incomplete export was saved.`);
  };
  let page = await read();
  if (scope === 'current') return { ...page, pagesCollected: 1 };
  if (page.rangeStart == null && (page.paginationDetected || page.totalPages > 1)) {
    throw new Error('This table’s page counter could not be read. Use Current page or inspect its paginator again.');
  }
  if (page.rangeStart == null) {
    if (scope === 'range' && (from !== 1 || to !== 1)) throw new Error('Only one page was detected. Inspect its paginator before selecting a range.');
    return { ...page, pagesCollected: 1 };
  }
  if (page.rangeStart > 1) {
    const previous = edges(page);
    if (!await command('first')) throw new Error('The first-page button is unavailable.');
    page = await waitFor(1, previous);
  }
  if (pageSize !== 'default') {
    let resized = await command('size', pageSize);
    if (resized === 'options') {
      resized = false;
      for (let attempt = 0; attempt < 15; attempt++) {
        if (await command('option', pageSize)) { resized = true; break; }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (!resized) {
        // Close only the picker opened by this operation when its option is unsupported.
        await contents.executeJavaScript(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',keyCode:27,bubbles:true}))`);
      }
    }
    if (resized) page = await waitFor(1, null, pageSize);
  }
  const total = page.totalRecords;
  const size = page.pageSize || page.rowCount;
  const totalPages = Math.ceil(total / size);
  const last = scope === 'all' ? totalPages : to;
  const first = scope === 'all' ? 1 : from;
  if (last > totalPages) throw new Error(`There are only ${totalPages} pages at ${size.toLocaleString()} records per page.`);
  const rows = [];
  let bytes = 0;
  for (let number = 1; number <= last; number++) {
    const expected = Math.min(size, total - (number - 1) * size);
    if (page.totalRecords !== total || page.rangeStart !== (number - 1) * size + 1 || page.rowCount !== expected) {
      throw new Error('The record count or page size changed during export. No incomplete export was saved.');
    }
    if (number >= first) {
      bytes += Buffer.byteLength(JSON.stringify(page.rows));
      if (bytes > 64 * 1024 * 1024) throw new Error('The export exceeds 64 MB. Select a smaller page range.');
      rows.push(...page.rows);
      progress({ page: number, last, count: rows.length, total: Math.min(last * size, total) - (first - 1) * size });
    }
    if (number < last) {
      const previous = edges(page);
      if (!await command('next')) throw new Error(`Next page is unavailable after page ${number}. No incomplete export was saved.`);
      page = await waitFor(number * size + 1, previous);
    }
  }
  return { ...page, rows, rowCount: rows.length, pagesCollected: last - first + 1 };
}

module.exports = { collectTablePages };
