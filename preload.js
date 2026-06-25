const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Dialogs
  openFileDialog: () => ipcRenderer.invoke('dialog:openFile'),
  openFolderDialog: () => ipcRenderer.invoke('dialog:openFolder'),

  // File system
  readFile: (p) => ipcRenderer.invoke('fs:readFile', p),
  fileExists: (p) => ipcRenderer.invoke('fs:exists', p),
  listTree: (root) => ipcRenderer.invoke('fs:listTree', root),

  // Links
  resolveLink: (currentFile, href) => ipcRenderer.invoke('path:resolveLink', currentFile, href),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  // Recent files / folders
  addRecentFile: (p) => ipcRenderer.invoke('recent:addFile', p),
  addRecentFolder: (p) => ipcRenderer.invoke('recent:addFolder', p),

  // Folder watching (auto-refresh)
  watchFolder: (root) => ipcRenderer.invoke('fs:watchFolder', root),
  onFolderChanged: (cb) => ipcRenderer.on('folder:changed', () => cb()),

  // Workspace / session
  loadWorkspace: () => ipcRenderer.invoke('workspace:load'),
  saveWorkspace: (data) => ipcRenderer.invoke('workspace:save', data),

  // App info
  getVersion: () => ipcRenderer.invoke('app:getVersion'),
  showAbout: () => ipcRenderer.invoke('app:showAbout'),

  // Menu / app events -> renderer
  onMenu: (handlers) => {
    const map = {
      'menu:open-file': handlers.openFile,
      'menu:open-folder': handlers.openFolder,
      'menu:open-path': handlers.openPath,
      'menu:open-folder-path': handlers.openFolderPath,
      'session:restore': handlers.restoreSession,
      'menu:reload-doc': handlers.reloadDoc,
      'menu:back': handlers.back,
      'menu:forward': handlers.forward,
      'menu:toggle-sidebar': handlers.toggleSidebar,
      'menu:toggle-outline': handlers.toggleOutline,
      'menu:close-tab': handlers.closeTab,
      'menu:next-tab': handlers.nextTab,
      'menu:prev-tab': handlers.prevTab,
      'menu:refresh-folder': handlers.refreshFolder,
    };
    for (const [channel, fn] of Object.entries(map)) {
      if (fn) ipcRenderer.on(channel, (_e, ...args) => fn(...args));
    }
  },
});
