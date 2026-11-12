'use strict';

(() => {
  const api = window.bobo;
  if (!api?.passwordManager) return;
  const element = id => document.getElementById(`passwords-${id}`);
  const call = (op, value = {}) => api.passwordManager({ op, ...value });
  const status = message => { element('status').textContent = message; };
  let selected = null;
  let timer;
  let opening = false;
  function lock() {
    clearTimeout(timer);
    selected = null;
    element('username').value = '';
    element('secret').value = '';
    element('secret').type = 'password';
    element('reveal').textContent = 'Reveal Password';
    element('edit-origin').textContent = '';
    if (element('editor').open) element('editor').close();
    void call('lock').catch(() => {});
  }
  const button = (label, action) => {
    const node = document.createElement('button');
    node.type = 'button'; node.className = 'btn'; node.textContent = label;
    node.addEventListener('click', async () => {
      node.disabled = true;
      try { await action(); } catch { status('Could not complete this action. Verify your Windows identity and try again.'); }
      finally { node.disabled = false; }
    });
    return node;
  };
  function render(state) {
    element('enabled').disabled = !state.available;
    element('enabled').checked = state.enabled;
    status(state.failed ? 'Vault unavailable. Existing encrypted data has been preserved; no new credentials will be saved.' :
      !state.available ? 'Windows protected storage is unavailable or the password manager kill switch is active.' :
        state.enabled ? 'Enabled. Each save or update requires approval. Reveal and editing require Windows verification.' :
          'Disabled. Turn on Save Passwords to receive Save Password prompts and fill saved accounts. Existing saved accounts are preserved.');
    element('accounts').replaceChildren();
    for (const account of state.accounts) {
      const row = document.createElement('div'); row.className = 'setting-row';
      const label = document.createElement('span'); label.textContent = `${account.origin} — ${account.label}`;
      row.append(label, button('View / Edit…', async () => {
        lock(); opening = true;
        let granted;
        try { granted = await call('unlock'); } finally { opening = false; }
        if (!granted.authenticated) { status('Windows verification was cancelled or is unavailable. The account remains locked.'); return; }
        const value = await call('reveal', { id: account.id });
        selected = value.id;
        element('edit-origin').textContent = value.origin;
        element('username').value = value.username;
        element('secret').value = value.password;
        element('editor').showModal();
        timer = setTimeout(lock, 30000);
      }), button('Delete…', async () => { lock(); render(await call('delete', { id: account.id })); }));
      element('accounts').append(row);
    }
    if (!state.accounts.length) element('accounts').textContent = 'No saved accounts.';
    element('never').replaceChildren();
    for (const origin of state.never) {
      const row = document.createElement('div'); row.className = 'setting-row';
      const label = document.createElement('span'); label.textContent = origin;
      row.append(label, button('Allow Saving', async () => render(await call('allow', { origin }))));
      element('never').append(row);
    }
    if (!state.never.length) element('never').textContent = 'No excluded websites.';
  }
  async function refresh() { try { render(await call('status')); } catch { status('Password Manager is unavailable.'); } }
  element('enabled').addEventListener('change', async () => {
    lock();
    try { render(await call('enable', { enabled: element('enabled').checked })); }
    catch { status('Could not change password saving. Existing data has been preserved.'); await refresh(); }
  });
  element('refresh').addEventListener('click', () => { lock(); void refresh(); });
  element('close').addEventListener('click', lock);
  element('editor').addEventListener('cancel', lock);
  element('reveal').addEventListener('click', () => {
    const hidden = element('secret').type === 'password';
    element('secret').type = hidden ? 'text' : 'password';
    element('reveal').textContent = hidden ? 'Hide Password' : 'Reveal Password';
  });
  element('edit-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (!selected) return;
    const request = call('edit', { id: selected, username: element('username').value, password: element('secret').value });
    lock();
    try { render(await request); } catch { status('Could not save changes. Verify your Windows identity and try again.'); }
  });
  addEventListener('blur', () => { if (!opening) lock(); });
  addEventListener('pagehide', lock);
  document.addEventListener('visibilitychange', () => { if (document.hidden) lock(); });
  document.querySelectorAll('.settings-nav-btn').forEach(node => node.addEventListener('click', lock));
  void refresh();
})();
