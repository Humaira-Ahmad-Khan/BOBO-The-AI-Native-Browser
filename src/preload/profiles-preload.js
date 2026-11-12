'use strict';

const { contextBridge, ipcRenderer } = require('electron');

if (process.isMainFrame && location.protocol === 'file:' && /\/renderer\/profiles\.html$/.test(location.pathname)) {
  contextBridge.exposeInMainWorld('boboProfiles', {
    list: () => ipcRenderer.invoke('bobo:profiles:list'),
    edit: (profile) => ipcRenderer.invoke('bobo:profiles:edit', profile),
    remove: (id) => ipcRenderer.invoke('bobo:profiles:remove', { id }),
    open: (id) => ipcRenderer.invoke('bobo:profiles:open', { id }),
  });
}
