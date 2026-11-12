'use strict';

const MODES = new Set(['list', 'pick-list', 'page', 'images', 'email', 'products', 'phone', 'social', 'text']);

function pickRepeatingList() {
  return new Promise((resolve) => {
    const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
    const signature = (node) => [node.tagName, ...node.classList].join(' ');
    const finish = (result) => {
      clearTimeout(timer);
      document.removeEventListener('click', click, true);
      document.removeEventListener('keydown', escape, true);
      resolve(result);
    };
    const escape = (event) => {
      if (event.key === 'Escape') finish({ canceled: true });
    };
    const click = (event) => {
      if (!event.isTrusted) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      let rows = [];
      for (let node = event.target; node?.parentElement && node !== document.body; node = node.parentElement) {
        const key = signature(node);
        const siblings = [...node.parentElement.children].filter((item) => signature(item) === key);
        if (siblings.length > rows.length) rows = siblings;
      }
      if (rows.length < 2) {
        finish({ error: 'No repeating rows found. Pick a card or row with matching siblings.' });
        return;
      }
      const output = rows.slice(0, 5000).map((row) => {
        const link = row.closest('a[href]') || row.querySelector('a[href]');
        const href = link?.href || '';
        return [clean(row.innerText), /^https?:\/\//i.test(href) ? href.slice(0, 2000) : ''];
      });
      finish({ columns: ['Item', 'URL'], rows: output, truncated: rows.length > 5000 });
    };
    const timer = setTimeout(() => finish({ canceled: true }), 30000);
    document.addEventListener('click', click, true);
    document.addEventListener('keydown', escape, true);
  });
}

function collect(mode) {
  if (!/^https?:$/.test(location.protocol)) return null;
  const all = (selector) => [...document.querySelectorAll(selector)];
  const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const webUrl = (value) => {
    if (!value) return '';
    try {
      const url = new URL(value, document.baseURI);
      return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : '';
    } catch { return ''; }
  };
  const body = () => document.body?.innerText || '';
  const links = () => all('a[href]');
  const unique = (values) => [...new Set(values.filter(Boolean))];
  const result = (columns, rows) => ({
    columns,
    rows: rows.slice(0, 5000).map((row) => row.map((value) => String(value ?? '').slice(0, 20000))),
    truncated: rows.length > 5000,
  });

  switch (mode) {
    case 'list':
      return result(['Item'], all('main li, article li, body li').map((node) => clean(node.innerText)).filter(Boolean).map((text) => [text]));
    case 'page':
      return result(['Title', 'URL', 'Description', 'Headings'], [[document.title, location.href,
        document.querySelector('meta[name="description"]')?.content || '',
        all('h1, h2, h3').map((node) => clean(node.innerText)).filter(Boolean).join(' | ')]]);
    case 'images': {
      const images = new Map();
      for (const image of all('img')) {
        const url = webUrl(image.currentSrc || image.getAttribute('src'));
        if (url && !images.has(url)) images.set(url, image.alt);
      }
      return result(['Image URL', 'Alt text'], [...images]);
    }
    case 'email':
      return result(['Email'], unique([
        ...(body().match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || []),
        ...links().filter((link) => /^mailto:/i.test(link.href)).map((link) => link.href.slice(7).split('?')[0]),
      ].map((value) => value.toLowerCase())).map((value) => [value]));
    case 'phone':
      return result(['Phone'], unique([
        ...(body().match(/(?:\+\d|\(?\d{2,4}\)?)[ .()-]*\d(?:[ .()-]*\d){5,13}/g) || []),
        ...links().filter((link) => /^tel:/i.test(link.href)).map((link) => link.href.slice(4).split('?')[0]),
      ].map(clean)).map((value) => [value]));
    case 'social':
      return result(['Social URL'], unique(links().map((link) => webUrl(link.href)).filter((url) => {
        if (!url) return false;
        return /(^|\.)(facebook\.com|instagram\.com|linkedin\.com|x\.com|twitter\.com|youtube\.com|tiktok\.com|pinterest\.com|threads\.net|github\.com)$/i.test(new URL(url).hostname);
      })).map((url) => [url]));
    case 'products': {
      const products = [];
      for (const script of all('script[type="application/ld+json"]')) {
        let data;
        try { data = JSON.parse(script.textContent); } catch { continue; }
        const pending = [data];
        while (pending.length && products.length <= 5000) {
          const item = pending.pop();
          if (!item || typeof item !== 'object') continue;
          if ([item['@type']].flat().includes('Product')) {
            const offer = [item.offers].flat()[0];
            products.push([item.name, item.sku, offer?.price, offer?.priceCurrency, webUrl(item.url || offer?.url)]);
          }
          for (const child of Object.values(item)) if (child && typeof child === 'object') pending.push(child);
        }
      }
      return result(['Product', 'SKU', 'Price', 'Currency', 'URL'], products);
    }
    case 'text':
      return result(['Title', 'URL', 'Text'], [[document.title, location.href, body().trim()]]);
  }
  return null;
}

async function scrapePage(contents, mode, exportService) {
  if (!MODES.has(mode)) throw new Error('Choose a supported extractor.');
  if (!contents || contents.isDestroyed() || !/^https?:\/\//i.test(contents.getURL())) {
    throw new Error('Open a webpage in the active tab first.');
  }
  if (mode === 'pick-list') {
    contents.focus();
    return contents.executeJavaScript(`(${pickRepeatingList.toString()})()`);
  }
  if (mode === 'list') {
    const table = await exportService.inspectTable(contents);
    if (table?.rows?.length) {
      return { columns: table.columns, rows: table.rows.slice(0, 5000), truncated: table.rows.length > 5000 };
    }
  }
  const data = await contents.executeJavaScript(`(${collect.toString()})(${JSON.stringify(mode)})`);
  if (!data) throw new Error('Open a webpage in the active tab first.');
  return data;
}

module.exports = { scrapePage };
