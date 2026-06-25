const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;

function sendToRenderer(channel, ...args) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args);
}

// ---- Recent files / folders (persisted to userData) ----

const MAX_RECENT = 12;
let recent = { files: [], folders: [] };

function recentStorePath() {
  return path.join(app.getPath('userData'), 'recent.json');
}

function loadRecent() {
  try {
    const data = JSON.parse(fs.readFileSync(recentStorePath(), 'utf8'));
    recent.files = Array.isArray(data.files) ? data.files : [];
    recent.folders = Array.isArray(data.folders) ? data.folders : [];
  } catch {
    recent = { files: [], folders: [] };
  }
}

function saveRecent() {
  try {
    fs.writeFileSync(recentStorePath(), JSON.stringify(recent));
  } catch { /* ignore write errors */ }
}

function addRecent(list, p) {
  const i = list.findIndex((x) => x.toLowerCase() === p.toLowerCase());
  if (i >= 0) list.splice(i, 1);
  list.unshift(p);
  if (list.length > MAX_RECENT) list.length = MAX_RECENT;
}

// ---- Workspace / session (persisted to userData) ----

let workspace = null;

function workspaceStorePath() {
  return path.join(app.getPath('userData'), 'workspace.json');
}

function loadWorkspace() {
  try {
    workspace = JSON.parse(fs.readFileSync(workspaceStorePath(), 'utf8'));
  } catch {
    workspace = null;
  }
}

function saveWorkspaceData(data) {
  workspace = data;
  try {
    fs.writeFileSync(workspaceStorePath(), JSON.stringify(data));
  } catch { /* ignore write errors */ }
}

// ---- Folder watcher: auto-refresh the sidebar tree on disk changes ----

let folderWatcher = null;
let watchTimer = null;

function stopWatch() {
  if (folderWatcher) {
    try { folderWatcher.close(); } catch { /* ignore */ }
    folderWatcher = null;
  }
  if (watchTimer) { clearTimeout(watchTimer); watchTimer = null; }
}

function startWatch(root) {
  stopWatch();
  try {
    folderWatcher = fs.watch(root, { recursive: true }, () => {
      // Debounce bursts of events into a single refresh.
      if (watchTimer) clearTimeout(watchTimer);
      watchTimer = setTimeout(() => sendToRenderer('folder:changed'), 250);
    });
  } catch { /* watching is best-effort */ }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 640,
    minHeight: 400,
    title: 'Markdown Viewer',
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  loadRecent();
  loadWorkspace();
  buildMenu();

  // Open external http(s) links in the OS browser, never inside the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { stopWatch(); mainWindow = null; });

  // On ready: open the file passed on the command line ("open with"), otherwise
  // restore the previous workspace (open folder + tabs).
  const fileArg = process.argv.slice(1).find((a) => /\.(md|markdown)$/i.test(a));
  mainWindow.webContents.once('did-finish-load', () => {
    if (fileArg) {
      mainWindow.webContents.send('menu:open-path', path.resolve(fileArg));
    } else if (workspace && ((workspace.tabs && workspace.tabs.length) || workspace.folderRoot)) {
      mainWindow.webContents.send('session:restore', workspace);
    }
  });
}

function buildRecentSubmenu() {
  const send = sendToRenderer;
  const items = [];

  if (recent.files.length) {
    items.push({ label: 'Recent Files', enabled: false });
    for (const f of recent.files) {
      items.push({ label: path.basename(f), sublabel: f, toolTip: f, click: () => send('menu:open-path', f) });
    }
  }
  if (recent.folders.length) {
    if (items.length) items.push({ type: 'separator' });
    items.push({ label: 'Recent Folders', enabled: false });
    for (const d of recent.folders) {
      items.push({ label: path.basename(d) || d, sublabel: d, toolTip: d, click: () => send('menu:open-folder-path', d) });
    }
  }
  if (!items.length) {
    items.push({ label: '(No recent items)', enabled: false });
  } else {
    items.push({ type: 'separator' });
    items.push({
      label: 'Clear Recent',
      click: () => { recent = { files: [], folders: [] }; saveRecent(); buildMenu(); },
    });
  }
  return items;
}

function showAbout() {
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'About Markdown Viewer',
    message: 'Markdown Viewer',
    detail: `Version ${app.getVersion()}\n\nA desktop markdown viewer with tabs, line-anchor links,\nMermaid diagrams, outline, and workspace restore.\n\nMade by LifeCraft Lab\nhttps://lifecraftlab.cc/`,
    buttons: ['Visit lifecraftlab.cc', 'Close'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  }).then((r) => {
    if (r.response === 0) shell.openExternal('https://lifecraftlab.cc/');
  });
}

function buildMenu() {
  const send = sendToRenderer;

  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'Open File…', accelerator: 'CmdOrCtrl+O', click: () => send('menu:open-file') },
        { label: 'Open Folder…', accelerator: 'CmdOrCtrl+Shift+O', click: () => send('menu:open-folder') },
        { type: 'separator' },
        { label: 'Open Recent', submenu: buildRecentSubmenu() },
        { type: 'separator' },
        { label: 'Refresh Folder', accelerator: 'F5', click: () => send('menu:refresh-folder') },
        { label: 'Reload Current', accelerator: 'CmdOrCtrl+R', click: () => send('menu:reload-doc') },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Navigate',
      submenu: [
        { label: 'Back', accelerator: 'Alt+Left', click: () => send('menu:back') },
        { label: 'Forward', accelerator: 'Alt+Right', click: () => send('menu:forward') },
      ],
    },
    {
      label: 'Tabs',
      submenu: [
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => send('menu:close-tab') },
        // Tab-key combos are handled in the renderer (Chromium reserves Ctrl+Tab
        // as a menu accelerator); labels carry the hint for discoverability.
        { label: 'Next Tab\tCtrl+Tab', click: () => send('menu:next-tab') },
        { label: 'Previous Tab\tCtrl+Shift+Tab', click: () => send('menu:prev-tab') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+B', click: () => send('menu:toggle-sidebar') },
        { label: 'Toggle Outline', accelerator: 'CmdOrCtrl+Shift+B', click: () => send('menu:toggle-outline') },
        { type: 'separator' },
        { role: 'zoomIn', accelerator: 'CmdOrCtrl+=' },
        { role: 'zoomOut' },
        { role: 'resetZoom' },
        { type: 'separator' },
        { role: 'toggleDevTools' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'About Markdown Viewer', click: showAbout },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- IPC: file system access (kept in main process for security) ----

ipcMain.handle('dialog:openFile', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Markdown File',
    properties: ['openFile'],
    filters: [
      { name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('dialog:openFolder', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Folder',
    properties: ['openDirectory'],
  });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('fs:readFile', async (_e, filePath) => {
  return fs.promises.readFile(filePath, 'utf8');
});

ipcMain.handle('recent:addFile', (_e, p) => {
  addRecent(recent.files, p);
  saveRecent();
  buildMenu();
});

ipcMain.handle('recent:addFolder', (_e, p) => {
  addRecent(recent.folders, p);
  saveRecent();
  buildMenu();
});

ipcMain.handle('fs:watchFolder', (_e, root) => {
  startWatch(root);
});

ipcMain.handle('workspace:load', () => workspace);
ipcMain.handle('workspace:save', (_e, data) => saveWorkspaceData(data));

ipcMain.handle('app:getVersion', () => app.getVersion());
ipcMain.handle('app:showAbout', () => showAbout());

ipcMain.handle('fs:exists', async (_e, filePath) => {
  try {
    const st = await fs.promises.stat(filePath);
    return st.isFile();
  } catch {
    return false;
  }
});

// Recursively list markdown files in a folder, returning a nested tree.
ipcMain.handle('fs:listTree', async (_e, root) => {
  const IGNORE = new Set(['node_modules', '.git', '.svn', '.hg', 'dist', 'build', '.next']);
  const MD = /\.(md|markdown|mdown|mkd)$/i;

  async function walk(dir) {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const dirs = [];
    const files = [];
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (IGNORE.has(ent.name) || ent.name.startsWith('.')) continue;
        const children = await walk(full);
        if (children.length) dirs.push({ type: 'dir', name: ent.name, path: full, children });
      } else if (ent.isFile() && MD.test(ent.name)) {
        files.push({ type: 'file', name: ent.name, path: full });
      }
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => a.name.localeCompare(b.name));
    return [...dirs, ...files];
  }

  return { root, name: path.basename(root), children: await walk(root) };
});

ipcMain.handle('shell:openExternal', async (_e, url) => {
  await shell.openExternal(url);
});

// Path helpers (renderer has no direct node access under contextIsolation).
ipcMain.handle('path:resolveLink', async (_e, currentFile, href) => {
  const dir = path.dirname(currentFile);
  // Strip the fragment before resolving the filesystem path.
  const hashIdx = href.indexOf('#');
  const rawPath = hashIdx >= 0 ? href.slice(0, hashIdx) : href;
  const fragment = hashIdx >= 0 ? href.slice(hashIdx + 1) : '';
  let resolved;
  if (!rawPath) {
    resolved = currentFile; // pure "#fragment" link -> same file
  } else if (path.isAbsolute(rawPath)) {
    resolved = path.normalize(rawPath);
  } else {
    resolved = path.resolve(dir, decodeURIComponent(rawPath));
  }
  return { path: resolved, fragment };
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
