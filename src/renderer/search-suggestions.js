'use strict';

window.bindSearchSuggestions = (input, list, api, navigate, onLayout = () => {}) => {
  let request = 0;
  let results = [];
  let selected = -1;
  const close = () => {
    request += 1;
    results = [];
    selected = -1;
    list.hidden = true;
    list.replaceChildren();
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    onLayout();
  };
  const choose = (index) => {
    const result = results[index];
    if (!result) return;
    close();
    navigate(result.url);
  };
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', list.id);
  input.setAttribute('aria-expanded', 'false');
  input.addEventListener('input', async () => {
    close();
    const query = input.value.trim();
    const current = request;
    if (!query || query.length > 200) return;
    try {
      const entries = await api.suggestSearch(query);
      if (current !== request || document.activeElement !== input || !entries.length) return;
      results = entries;
      list.replaceChildren(...results.map(({ title, url, kind }, index) => {
        const row = document.createElement('div');
        row.id = `${list.id}-${index}`;
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', 'false');
        const label = document.createElement('strong');
        label.textContent = `${kind === 'bookmark' ? '★' : '◷'} ${title || url}`;
        const address = document.createElement('span');
        address.textContent = url;
        row.append(label, address);
        row.addEventListener('pointerdown', (event) => event.preventDefault());
        row.addEventListener('click', () => choose(index));
        return row;
      }));
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      onLayout();
    } catch {}
  });
  input.addEventListener('blur', close);
  input.addEventListener('keydown', (event) => {
    if (!results.length || event.isComposing) return;
    if (!['ArrowDown', 'ArrowUp', 'Escape'].includes(event.key) &&
        !(event.key === 'Enter' && selected >= 0)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.key === 'Escape') close();
    else if (event.key === 'Enter') choose(selected);
    else {
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      selected = selected < 0 && delta < 0 ? results.length - 1
        : (selected + delta + results.length) % results.length;
      for (const [index, row] of Array.from(list.children).entries()) {
        row.setAttribute('aria-selected', String(index === selected));
      }
      const row = list.children[selected];
      input.setAttribute('aria-activedescendant', row.id);
      row.scrollIntoView({ block: 'nearest' });
    }
  }, true);
  return close;
};
