'use strict';

(() => {
  const api = window.boboProfiles;
  const grid = document.getElementById('profiles');
  const status = document.getElementById('profile-status');
  const editor = document.getElementById('profile-editor');
  const name = document.getElementById('profile-name');
  const color = document.getElementById('profile-color');
  const save = document.getElementById('editor-save');
  const editorStatus = document.getElementById('editor-status');
  const remove = document.getElementById('editor-delete');
  let editing;
  let opening = false;
  function edit(profile) {
    editing = profile?.id;
    name.value = profile?.name || '';
    color.value = profile?.color || color.options[0].value;
    document.getElementById('editor-title').textContent = profile ? 'Edit profile' : 'Add profile';
    editorStatus.textContent = '';
    remove.hidden = !profile || profile.id === 'default';
    remove.textContent = 'Delete profile';
    editor.showModal();
    name.focus();
  }
  async function refresh() {
    const state = await api.list();
    color.replaceChildren(...state.colors.map((value, index) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = ['Arctic blue', 'Purple', 'Orange', 'Green', 'Pink'][index];
      return option;
    }));
    const cards = state.profiles.map((profile) => {
      const card = document.createElement('section');
      card.className = 'profile-card';
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'profile-open';
      open.dataset.profile = profile.id;
      const avatar = document.createElement('span');
      avatar.className = 'profile-avatar';
      avatar.style.backgroundColor = profile.color;
      avatar.textContent = [...profile.name][0].toLocaleUpperCase();
      const label = document.createElement('span');
      label.className = 'profile-name';
      label.textContent = profile.name;
      open.append(avatar, label);
      open.addEventListener('click', async () => {
        if (opening) return;
        opening = true;
        open.disabled = true;
        status.textContent = 'Opening ' + profile.name + '…';
        try { await api.open(profile.id); }
        catch (error) { status.textContent = error.message; open.disabled = false; opening = false; }
      });
      const change = document.createElement('button');
      change.type = 'button';
      change.className = 'profile-edit';
      change.textContent = '⋮';
      change.setAttribute('aria-label', 'Edit ' + profile.name);
      change.addEventListener('click', () => edit(profile));
      card.append(open, change);
      return card;
    });
    const add = document.createElement('button');
    add.className = 'profile-add';
    add.id = 'profile-add';
    add.type = 'button';
    add.textContent = '+ Add profile';
    add.addEventListener('click', () => edit());
    grid.replaceChildren(...cards, add);
  }
  document.getElementById('editor-cancel').addEventListener('click', () => editor.close());
  remove.addEventListener('click', async () => {
    // Two-step confirmation: the first click arms the button, the second deletes.
    if (remove.textContent === 'Delete profile') {
      remove.textContent = 'Click again to confirm delete';
      return;
    }
    remove.disabled = true;
    try {
      await api.remove(editing);
      await refresh();
      editor.close();
    } catch (error) { editorStatus.textContent = error.message; }
    finally { remove.disabled = false; remove.textContent = 'Delete profile'; }
  });
  document.getElementById('profile-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    save.disabled = true;
    try {
      await api.edit({ id: editing, name: name.value, color: color.value });
      await refresh();
      editor.close();
    } catch (error) { editorStatus.textContent = error.message; }
    finally { save.disabled = false; }
  });
  void refresh().catch((error) => { status.textContent = error.message; });
})();
