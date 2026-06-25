'use strict';

// ---------------------------------------------------------------------------
// Markdown renderer setup
// ---------------------------------------------------------------------------

// GitHub-style heading slug (matches github-slugger: keeps unicode letters and
// underscores; removes other punctuation; replaces EACH whitespace char with a
// hyphen WITHOUT collapsing, so "A & B" -> "a--b").
function githubSlug(text) {
  return String(text)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}_\s-]/gu, '')
    .replace(/\s/g, '-');
}

const md = window.markdownit({
  html: true,
  linkify: true,
  typographer: false,
  breaks: false,
});

// Plugin: stamp every block token with its 1-based source line (data-line),
// and give headings GitHub-style ids so "file.md#heading" links work.
md.core.ruler.push('inject_anchors', (state) => {
  const seen = {};
  state.tokens.forEach((token, i) => {
    if (token.map && token.nesting !== -1) {
      token.attrSet('data-line', String(token.map[0] + 1));
    }
    if (token.type === 'heading_open') {
      const inline = state.tokens[i + 1];
      let slug = githubSlug(inline && inline.type === 'inline' ? inline.content : '');
      if (slug) {
        if (seen[slug] != null) {
          seen[slug] += 1;
          slug = `${slug}-${seen[slug]}`;
        } else {
          seen[slug] = 0;
        }
        token.attrSet('id', slug);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Mermaid (flowcharts / diagrams) setup
// ---------------------------------------------------------------------------

let mermaidReady = false;
let mermaidSeq = 0;

if (window.mermaid) {
  try {
    window.mermaid.initialize({
      startOnLoad: false,
      theme: 'dark',
      securityLevel: 'strict',
      flowchart: {
        useMaxWidth: true,
        htmlLabels: true,
        nodeSpacing: 70,      // gap between nodes on the same rank
        rankSpacing: 90,      // gap between ranks (and subgraphs)
        padding: 20,          // padding inside subgraph clusters
        diagramPadding: 16,
        subGraphTitleMargin: { top: 8, bottom: 8 },
      },
    });
    mermaidReady = true;
  } catch (err) {
    console.error('Mermaid init failed', err);
  }
}

// Replace ```mermaid fenced code blocks in a tab with rendered SVG diagrams.
async function renderMermaid(tab) {
  if (!mermaidReady) return;
  const blocks = Array.from(tab.article.querySelectorAll('code.language-mermaid'));
  for (const code of blocks) {
    const pre = code.closest('pre') || code;
    const def = code.textContent;
    const dataLine = (pre.getAttribute && pre.getAttribute('data-line')) || code.getAttribute('data-line');
    const id = `mmd-${++mermaidSeq}`;
    try {
      const { svg, bindFunctions } = await window.mermaid.render(id, def);
      const container = document.createElement('div');
      container.className = 'mermaid-diagram';
      if (dataLine) container.setAttribute('data-line', dataLine);
      container.innerHTML = svg;
      pre.replaceWith(container);
      if (typeof bindFunctions === 'function') bindFunctions(container);
    } catch (err) {
      const note = document.createElement('div');
      note.className = 'mermaid-error';
      if (dataLine) note.setAttribute('data-line', dataLine);
      const msg = err && err.message ? err.message : String(err);
      note.innerHTML = `<b>⚠ Diagram error:</b> ${escapeHtml(msg)}<pre>${escapeHtml(def)}</pre>`;
      pre.replaceWith(note);
    }
  }
}

// ---------------------------------------------------------------------------
// State — tab model
// ---------------------------------------------------------------------------
//
// Each tab is an independent browsing context:
//   { id, wrap, article, renderedPath, history:[{path,fragment,scrollTop}], index }
// The active tab's scroll position lives in its current history entry, so
// switching away and back restores the exact spot the user was viewing.

let tabs = [];
let activeTabId = null;
let tabSeq = 0;
let folderRoot = null;
const collapsedDirs = new Set(); // dir paths the user has collapsed (preserved across refresh)

const contentHost = document.getElementById('content-host');
const emptyState = document.getElementById('empty-state');
const tabbar = document.getElementById('tabbar');
const sidebar = document.getElementById('sidebar');
const fileTree = document.getElementById('file-tree');
const folderName = document.getElementById('folder-name');
const currentPathEl = document.getElementById('current-path');
const btnBack = document.getElementById('btn-back');
const btnForward = document.getElementById('btn-forward');
const outline = document.getElementById('outline');
const outlineList = document.getElementById('outline-list');

let outlineItems = []; // [{ el: headingEl, item: outlineRow }] for the active tab
let spyRaf = 0;

function activeTab() {
  return tabs.find((t) => t.id === activeTabId) || null;
}

function currentPathOf(tab) {
  if (tab.index >= 0 && tab.history[tab.index]) return tab.history[tab.index].path;
  return tab.renderedPath || null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fileUrl(absPath) {
  return encodeURI('file:///' + absPath.replace(/\\/g, '/'));
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function baseName(p) {
  return p.split(/[\\/]/).pop();
}

function nextFrame() {
  // Resolve on the next animation frame, but fall back to a timer so navigation
  // never stalls when the window is occluded (Chromium pauses rAF when hidden).
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    requestAnimationFrame(finish);
    setTimeout(finish, 60);
  });
}

// Scope id lookups to a tab's article — heading ids can repeat across tabs.
function findById(article, id) {
  let el = article.querySelector(`[id="${id.replace(/"/g, '\\"')}"]`);
  if (!el) {
    try {
      const dec = decodeURIComponent(id);
      el = article.querySelector(`[id="${dec.replace(/"/g, '\\"')}"]`);
    } catch { /* malformed escape */ }
  }
  if (!el) {
    const slug = githubSlug(id);
    el = article.querySelector(`[id="${slug.replace(/"/g, '\\"')}"]`);
  }
  return el;
}

// ---------------------------------------------------------------------------
// Tab lifecycle
// ---------------------------------------------------------------------------

function createTab() {
  const id = `tab-${++tabSeq}`;
  const wrap = document.createElement('div');
  wrap.className = 'content-wrap';
  wrap.style.display = 'none';
  const article = document.createElement('article');
  article.className = 'content';
  wrap.appendChild(article);
  contentHost.appendChild(wrap);

  // Scroll-spy for the outline (throttled to one update per frame).
  wrap.addEventListener('scroll', () => {
    if (tab.id !== activeTabId) return;
    saveWorkspace();
    if (spyRaf) return;
    spyRaf = requestAnimationFrame(() => { spyRaf = 0; updateOutlineActive(tab); });
  });

  const tab = { id, wrap, article, renderedPath: null, history: [], index: -1, preview: false };
  tabs.push(tab);
  return tab;
}

function activateTab(id) {
  const cur = activeTab();
  if (cur && cur.id !== id) saveScroll(cur);

  activeTabId = id;
  for (const t of tabs) t.wrap.style.display = t.id === id ? '' : 'none';

  const tab = activeTab();
  if (tab) {
    const entry = tab.history[tab.index];
    if (entry) tab.wrap.scrollTop = entry.scrollTop || 0;
  }
  emptyState.style.display = tabs.length ? 'none' : '';
  renderTabBar();
  updateNavButtons();
  updatePathDisplay();
  highlightActiveInTree();
  buildOutline();
  saveWorkspace();
}

function closeTab(id) {
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx < 0) return;
  const [tab] = tabs.splice(idx, 1);
  tab.wrap.remove();

  if (activeTabId === id) {
    const next = tabs[idx] || tabs[idx - 1] || null;
    if (next) {
      activateTab(next.id);
    } else {
      activeTabId = null;
      emptyState.style.display = '';
      renderTabBar();
      updateNavButtons();
      updatePathDisplay();
      highlightActiveInTree();
      buildOutline();
    }
  } else {
    renderTabBar();
  }
  saveWorkspace();
}

function renderTabBar() {
  tabbar.innerHTML = '';
  tabbar.style.display = tabs.length ? '' : 'none';
  for (const tab of tabs) {
    const path = currentPathOf(tab);
    const el = document.createElement('div');
    el.className = 'tab' + (tab.id === activeTabId ? ' active' : '') + (tab.preview ? ' preview' : '');
    el.title = (path || 'Untitled') + (tab.preview ? '  (preview — double-click to keep)' : '');
    const label = document.createElement('span');
    label.className = 'tab-label';
    label.textContent = path ? baseName(path) : 'Untitled';
    const close = document.createElement('span');
    close.className = 'tab-close';
    close.textContent = '×';
    close.title = 'Close tab';
    close.addEventListener('click', (e) => { e.stopPropagation(); closeTab(tab.id); });
    el.appendChild(label);
    el.appendChild(close);
    el.addEventListener('click', () => activateTab(tab.id));
    // Double-clicking a preview tab keeps it (pins it), like VS Code.
    el.addEventListener('dblclick', () => pinTab(tab));
    el.addEventListener('mouseup', (e) => { if (e.button === 1) { e.preventDefault(); closeTab(tab.id); } });

    // Drag & drop to reorder tabs.
    el.draggable = true;
    el.addEventListener('dragstart', (e) => {
      dragSrcId = tab.id;
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', tab.id); } catch { /* ignore */ }
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => {
      dragSrcId = null;
      clearDropIndicators();
      el.classList.remove('dragging');
    });
    el.addEventListener('dragover', (e) => {
      if (!dragSrcId || dragSrcId === tab.id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const r = el.getBoundingClientRect();
      const after = e.clientX - r.left > r.width / 2;
      clearDropIndicators();
      el.classList.add(after ? 'drop-after' : 'drop-before');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-before', 'drop-after'));
    el.addEventListener('drop', (e) => {
      if (!dragSrcId || dragSrcId === tab.id) return;
      e.preventDefault();
      e.stopPropagation();
      const r = el.getBoundingClientRect();
      const after = e.clientX - r.left > r.width / 2;
      clearDropIndicators();
      moveTab(dragSrcId, tab.id, after);
    });

    tabbar.appendChild(el);
  }
}

let dragSrcId = null;

function clearDropIndicators() {
  tabbar.querySelectorAll('.drop-before, .drop-after').forEach((el) => {
    el.classList.remove('drop-before', 'drop-after');
  });
}

function moveTab(srcId, targetId, after) {
  if (srcId === targetId) return;
  const from = tabs.findIndex((t) => t.id === srcId);
  if (from < 0) return;
  const [moved] = tabs.splice(from, 1);
  let to = tabs.findIndex((t) => t.id === targetId);
  if (to < 0) { tabs.splice(from, 0, moved); return; }
  if (after) to += 1;
  tabs.splice(to, 0, moved);
  renderTabBar();
  saveWorkspace();
}

function moveTabToEnd(srcId) {
  const from = tabs.findIndex((t) => t.id === srcId);
  if (from < 0) return;
  const [moved] = tabs.splice(from, 1);
  tabs.push(moved);
  renderTabBar();
  saveWorkspace();
}

// Dropping in the empty area of the tab bar moves the tab to the end.
tabbar.addEventListener('dragover', (e) => {
  if (dragSrcId) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }
});
tabbar.addEventListener('drop', (e) => {
  if (dragSrcId && e.target === tabbar) { e.preventDefault(); moveTabToEnd(dragSrcId); }
});

// ---------------------------------------------------------------------------
// Rendering into a tab
// ---------------------------------------------------------------------------

async function renderInto(tab, filePath) {
  let text;
  try {
    text = await api.readFile(filePath);
  } catch (err) {
    tab.article.innerHTML = `<div class="error">Could not open file:<br><code>${escapeHtml(filePath)}</code><br><br>${escapeHtml(String(err.message || err))}</div>`;
    tab.renderedPath = filePath;
    return;
  }

  tab.article.innerHTML = md.render(text);
  tab.renderedPath = filePath;

  const imgs = Array.from(tab.article.querySelectorAll('img'));
  await Promise.all(
    imgs.map(async (img) => {
      const src = img.getAttribute('src');
      if (src && !/^(https?:|data:|file:)/i.test(src)) {
        const { path } = await api.resolveLink(filePath, src);
        img.src = fileUrl(path);
      }
    })
  );

  await renderMermaid(tab);
}

// ---------------------------------------------------------------------------
// Fragment navigation (#L42 line jumps and #heading anchors)
// ---------------------------------------------------------------------------

function applyFragment(tab, fragment) {
  if (!fragment) {
    tab.wrap.scrollTop = 0;
    return;
  }
  const lineMatch = /^L(\d+)/i.exec(fragment);
  if (lineMatch) {
    jumpToLine(tab, parseInt(lineMatch[1], 10));
    return;
  }
  const el = findById(tab.article, fragment);
  if (el) scrollElementToTop(tab, el, true);
  else tab.wrap.scrollTop = 0;
}

function jumpToLine(tab, line) {
  const els = Array.from(tab.article.querySelectorAll('[data-line]'));
  if (!els.length) return;
  let best = els[0];
  for (const el of els) {
    const l = parseInt(el.getAttribute('data-line'), 10);
    if (l <= line) best = el;
    else break;
  }
  scrollElementToTop(tab, best, true);
}

function scrollElementToTop(tab, el, flash) {
  const rect = el.getBoundingClientRect();
  const wrapRect = tab.wrap.getBoundingClientRect();
  tab.wrap.scrollTop += rect.top - wrapRect.top - 14;
  if (flash) {
    el.classList.remove('line-flash');
    void el.offsetWidth;
    el.classList.add('line-flash');
    setTimeout(() => el.classList.remove('line-flash'), 1600);
  }
}

// ---------------------------------------------------------------------------
// Navigation within a tab (history)
// ---------------------------------------------------------------------------

function saveScroll(tab) {
  if (tab && tab.index >= 0 && tab.history[tab.index]) {
    tab.history[tab.index].scrollTop = tab.wrap.scrollTop;
  }
}

// Navigate the given tab to a destination, pushing a new history entry.
async function navigateInTab(tab, filePath, fragment) {
  saveScroll(tab);

  if (tab.renderedPath !== filePath) {
    await renderInto(tab, filePath);
  }
  await nextFrame();
  applyFragment(tab, fragment);
  await nextFrame();

  tab.history = tab.history.slice(0, tab.index + 1);
  tab.history.push({ path: filePath, fragment: fragment || null, scrollTop: tab.wrap.scrollTop });
  tab.index = tab.history.length - 1;

  renderTabBar();
  updateNavButtons();
  updatePathDisplay();
  highlightActiveInTree();
  buildOutline();
  saveWorkspace();
}

async function goToInTab(tab, targetIndex) {
  if (targetIndex < 0 || targetIndex >= tab.history.length) return;
  saveScroll(tab);
  tab.index = targetIndex;
  const entry = tab.history[tab.index];
  if (tab.renderedPath !== entry.path) {
    await renderInto(tab, entry.path);
    await nextFrame();
  }
  tab.wrap.scrollTop = entry.scrollTop || 0;
  renderTabBar();
  updateNavButtons();
  updatePathDisplay();
  highlightActiveInTree();
  buildOutline();
  saveWorkspace();
}

function closeActiveTab() {
  if (activeTabId) closeTab(activeTabId);
}

// Cycle to the next (+1) or previous (-1) tab, wrapping around.
function switchTab(dir) {
  if (tabs.length < 2) return;
  const i = tabs.findIndex((t) => t.id === activeTabId);
  if (i < 0) return;
  const next = (i + dir + tabs.length) % tabs.length;
  activateTab(tabs[next].id);
}

function goBack() {
  const tab = activeTab();
  if (tab) goToInTab(tab, tab.index - 1);
}
function goForward() {
  const tab = activeTab();
  if (tab) goToInTab(tab, tab.index + 1);
}

function updateNavButtons() {
  const tab = activeTab();
  btnBack.disabled = !tab || tab.index <= 0;
  btnForward.disabled = !tab || tab.index >= tab.history.length - 1;
}

// ---------------------------------------------------------------------------
// Opening files (focus existing tab or create a new one)
// ---------------------------------------------------------------------------

function pinTab(tab) {
  if (tab && tab.preview) {
    tab.preview = false;
    renderTabBar();
  }
}

// Navigate a tab to a brand-new file, resetting its history (used when a
// preview tab is reused for a different file).
async function navigateNewFileInTab(tab, filePath, fragment) {
  if (tab.renderedPath !== filePath) await renderInto(tab, filePath);
  await nextFrame();
  applyFragment(tab, fragment);
  await nextFrame();
  tab.history = [{ path: filePath, fragment: fragment || null, scrollTop: tab.wrap.scrollTop }];
  tab.index = 0;
  renderTabBar();
  updateNavButtons();
  updatePathDisplay();
  highlightActiveInTree();
  buildOutline();
  saveWorkspace();
}

// Open a file.
//   opts.preview : open as a temporary tab (single preview tab, replaced on reuse)
//   opts.newTab  : always open a fresh tab (Ctrl+Click)
function openFile(filePath, fragment, opts = {}) {
  const preview = !!opts.preview;
  const newTab = !!opts.newTab;
  api.addRecentFile(filePath);

  // Already open somewhere? Focus it (and pin it if this is a permanent open).
  if (!newTab) {
    const existing = tabs.find((t) => currentPathOf(t) === filePath);
    if (existing) {
      if (!preview) existing.preview = false;
      activateTab(existing.id);
      if (fragment) navigateInTab(existing, filePath, fragment);
      renderTabBar();
      return;
    }
  }

  // Preview open: reuse the one existing preview tab if there is one.
  if (preview && !newTab) {
    const prev = tabs.find((t) => t.preview);
    if (prev) {
      activateTab(prev.id);
      navigateNewFileInTab(prev, filePath, fragment);
      return;
    }
  }

  const tab = createTab();
  tab.preview = preview;
  activateTab(tab.id);
  navigateInTab(tab, filePath, fragment);
}

// ---------------------------------------------------------------------------
// Workspace persistence (restore open folder + tabs on next launch)
// ---------------------------------------------------------------------------

let restoring = false;
let saveWsTimer = null;

function gatherWorkspace() {
  const at = activeTab();
  if (at) saveScroll(at);
  return {
    folderRoot,
    activeIndex: tabs.findIndex((t) => t.id === activeTabId),
    tabs: tabs
      .map((t) => {
        const e = t.history[t.index];
        return { path: e ? e.path : t.renderedPath, preview: !!t.preview, scrollTop: e ? (e.scrollTop || 0) : 0 };
      })
      .filter((t) => t.path),
  };
}

function saveWorkspace() {
  if (restoring) return;
  if (saveWsTimer) clearTimeout(saveWsTimer);
  saveWsTimer = setTimeout(() => api.saveWorkspace(gatherWorkspace()), 400);
}

async function restoreSession(ws) {
  if (!ws) return;
  restoring = true;
  try {
    if (ws.folderRoot) {
      await openFolder(ws.folderRoot).catch(() => {});
    }
    for (const t of ws.tabs || []) {
      if (!t.path || !(await api.fileExists(t.path))) continue;
      const tab = createTab();
      tab.preview = !!t.preview;
      activateTab(tab.id);
      await navigateInTab(tab, t.path, null);
      if (t.scrollTop) {
        tab.wrap.scrollTop = t.scrollTop;
        if (tab.history[tab.index]) tab.history[tab.index].scrollTop = t.scrollTop;
      }
    }
    if (tabs.length) {
      const idx = Math.min(Math.max(ws.activeIndex | 0, 0), tabs.length - 1);
      activateTab(tabs[idx].id);
    }
  } finally {
    restoring = false;
    saveWorkspace();
  }
}

// ---------------------------------------------------------------------------
// Link interception (delegated on the content host)
// ---------------------------------------------------------------------------

contentHost.addEventListener('click', async (e) => {
  const a = e.target.closest('a');
  if (!a) return;
  e.preventDefault();
  const href = a.getAttribute('href');
  if (!href) return;

  if (/^(https?:|mailto:)/i.test(href)) {
    api.openExternal(href);
    return;
  }

  const tab = activeTab();
  if (!tab) return;
  const newTab = e.ctrlKey || e.metaKey;

  if (href.startsWith('#')) {
    // same-file fragment
    const path = currentPathOf(tab);
    if (path) {
      if (newTab) openFile(path, href.slice(1), { newTab: true });
      else navigateInTab(tab, path, href.slice(1));
    }
    return;
  }

  const path = currentPathOf(tab);
  if (!path) return;
  const resolved = await api.resolveLink(path, href);
  const exists = await api.fileExists(resolved.path);
  if (!exists) {
    showToast(`File not found: ${resolved.path}`);
    return;
  }
  if (newTab) {
    openFile(resolved.path, resolved.fragment, { newTab: true });
  } else {
    navigateInTab(tab, resolved.path, resolved.fragment);
  }
});

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

function updatePathDisplay() {
  const tab = activeTab();
  const path = tab ? currentPathOf(tab) : null;
  if (!path) {
    currentPathEl.textContent = '';
    document.title = 'Markdown Viewer';
    return;
  }
  let label = path;
  if (folderRoot && path.toLowerCase().startsWith(folderRoot.toLowerCase())) {
    label = path.slice(folderRoot.length).replace(/^[\\/]/, '');
  }
  currentPathEl.textContent = label;
  document.title = `${baseName(path)} — Markdown Viewer`;
}

// ---------------------------------------------------------------------------
// Sidebar file tree
// ---------------------------------------------------------------------------

async function openFolder(root) {
  if (root !== folderRoot) collapsedDirs.clear();
  folderRoot = root;
  api.addRecentFolder(root);
  api.watchFolder(root);
  folderName.textContent = baseName(root) || root;
  folderName.title = root;
  document.getElementById('main').classList.remove('sidebar-hidden');
  await refreshTree();
  updatePathDisplay();
  saveWorkspace();
}

// Re-read the folder from disk and rebuild the tree, preserving the user's
// collapsed/expanded state, the active-file highlight, and the scroll position.
async function refreshTree() {
  if (!folderRoot) return;
  const btn = document.getElementById('btn-refresh-tree');
  if (btn) { btn.classList.remove('spinning'); void btn.offsetWidth; btn.classList.add('spinning'); }
  const scroll = sidebar.scrollTop;
  const tree = await api.listTree(folderRoot);
  fileTree.innerHTML = '';
  fileTree.appendChild(buildTree(tree.children, 0));
  highlightActiveInTree();
  sidebar.scrollTop = scroll;
}

function buildTree(nodes, depth) {
  const ul = document.createElement('ul');
  ul.className = 'tree-list';
  for (const node of nodes) {
    const li = document.createElement('li');
    if (node.type === 'dir') {
      const startCollapsed = collapsedDirs.has(node.path);
      const row = document.createElement('div');
      row.className = 'tree-row tree-dir ' + (startCollapsed ? 'collapsed' : 'expanded');
      row.style.paddingLeft = `${8 + depth * 14}px`;
      row.innerHTML = `<span class="caret">${startCollapsed ? '▸' : '▾'}</span><span class="tree-label">${escapeHtml(node.name)}</span>`;
      const childWrap = buildTree(node.children, depth + 1);
      if (startCollapsed) childWrap.style.display = 'none';
      row.addEventListener('click', () => {
        const collapsed = row.classList.toggle('collapsed');
        row.classList.toggle('expanded', !collapsed);
        row.querySelector('.caret').textContent = collapsed ? '▸' : '▾';
        childWrap.style.display = collapsed ? 'none' : '';
        if (collapsed) collapsedDirs.add(node.path);
        else collapsedDirs.delete(node.path);
      });
      li.appendChild(row);
      li.appendChild(childWrap);
    } else {
      const row = document.createElement('div');
      row.className = 'tree-row tree-file';
      row.dataset.path = node.path;
      row.style.paddingLeft = `${8 + depth * 14 + 14}px`;
      row.innerHTML = `<span class="tree-label">${escapeHtml(node.name)}</span>`;
      row.addEventListener('click', (e) => {
        if (e.ctrlKey || e.metaKey) openFile(node.path, null, { newTab: true });
        else openFile(node.path, null, { preview: true });
      });
      // Double-click opens it as a permanent (kept) tab.
      row.addEventListener('dblclick', () => openFile(node.path, null, { preview: false }));
      li.appendChild(row);
    }
    ul.appendChild(li);
  }
  return ul;
}

function highlightActiveInTree() {
  const tab = activeTab();
  const path = tab ? currentPathOf(tab) : null;
  fileTree.querySelectorAll('.tree-file').forEach((r) => {
    r.classList.toggle('active', r.dataset.path === path);
  });
}

// ---------------------------------------------------------------------------
// Outline (table of contents of the active document)
// ---------------------------------------------------------------------------

function buildOutline() {
  outlineItems = [];
  outlineList.innerHTML = '';
  const tab = activeTab();
  if (!tab) {
    outlineList.innerHTML = '<div class="outline-empty">No document open.</div>';
    return;
  }
  const heads = Array.from(tab.article.querySelectorAll('h1,h2,h3,h4,h5,h6'));
  if (!heads.length) {
    outlineList.innerHTML = '<div class="outline-empty">No headings in this document.</div>';
    return;
  }
  for (const h of heads) {
    const level = parseInt(h.tagName[1], 10);
    const item = document.createElement('div');
    item.className = `outline-item lvl-${level}`;
    item.textContent = h.textContent;
    item.title = h.textContent;
    item.addEventListener('click', () => scrollElementToTop(tab, h, true));
    outlineList.appendChild(item);
    outlineItems.push({ el: h, item });
  }
  updateOutlineActive(tab);
}

// Scroll-spy: highlight the heading currently at the top of the viewport.
function updateOutlineActive(tab) {
  if (!outlineItems.length || !tab || tab.id !== activeTabId) return;
  const wrapTop = tab.wrap.getBoundingClientRect().top;
  let idx = 0;
  for (let i = 0; i < outlineItems.length; i++) {
    if (outlineItems[i].el.getBoundingClientRect().top - wrapTop <= 28) idx = i;
    else break;
  }
  outlineItems.forEach((o, i) => o.item.classList.toggle('active', i === idx));
  const activeEl = outlineItems[idx].item;
  const lr = activeEl.getBoundingClientRect();
  const or = outline.getBoundingClientRect();
  if (lr.top < or.top + 28 || lr.bottom > or.bottom) activeEl.scrollIntoView({ block: 'nearest' });
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

let toastTimer = null;
function showToast(msg) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

// ---------------------------------------------------------------------------
// Toolbar / menu wiring
// ---------------------------------------------------------------------------

async function pickFile() {
  const p = await api.openFileDialog();
  if (p) {
    if (!folderRoot) {
      const dir = p.replace(/[\\/][^\\/]*$/, '');
      openFolder(dir).catch(() => {});
    }
    openFile(p, null, { preview: false });
  }
}

async function pickFolder() {
  const p = await api.openFolderDialog();
  if (p) openFolder(p);
}

function toggleSidebar() {
  document.getElementById('main').classList.toggle('sidebar-hidden');
}

function toggleOutline() {
  const hidden = document.getElementById('main').classList.toggle('outline-hidden');
  // Re-evaluate the active heading when the panel is shown again.
  if (!hidden) { const t = activeTab(); if (t) updateOutlineActive(t); }
}

document.getElementById('btn-open-file').addEventListener('click', pickFile);
document.getElementById('btn-open-folder').addEventListener('click', pickFolder);
document.getElementById('btn-refresh-tree').addEventListener('click', () => refreshTree());
document.getElementById('btn-back').addEventListener('click', goBack);
document.getElementById('btn-forward').addEventListener('click', goForward);
document.getElementById('btn-toggle-sidebar').addEventListener('click', toggleSidebar);
document.getElementById('btn-toggle-outline').addEventListener('click', toggleOutline);
document.getElementById('app-version').addEventListener('click', () => api.showAbout());

api.getVersion().then((v) => {
  const tag = v ? `v${v}` : '';
  document.getElementById('app-version').textContent = tag;
  const wv = document.getElementById('welcome-version');
  if (wv) wv.textContent = `Markdown Viewer ${tag}`;
});

// Mouse-button back/forward support.
window.addEventListener('mouseup', (e) => {
  if (e.button === 3) { e.preventDefault(); goBack(); }
  if (e.button === 4) { e.preventDefault(); goForward(); }
});

api.onMenu({
  openFile: pickFile,
  openFolder: pickFolder,
  openPath: (p) => {
    if (!folderRoot) {
      const dir = p.replace(/[\\/][^\\/]*$/, '');
      openFolder(dir).catch(() => {});
    }
    openFile(p, null, { preview: false });
  },
  openFolderPath: (p) => openFolder(p),
  restoreSession,
  reloadDoc: async () => {
    const tab = activeTab();
    if (!tab) return;
    const path = currentPathOf(tab);
    if (!path) return;
    const keep = tab.wrap.scrollTop;
    await renderInto(tab, path);
    await nextFrame();
    tab.wrap.scrollTop = keep;
    buildOutline();
  },
  back: goBack,
  forward: goForward,
  toggleSidebar,
  toggleOutline,
  closeTab: closeActiveTab,
  nextTab: () => switchTab(1),
  prevTab: () => switchTab(-1),
  refreshFolder: () => refreshTree(),
});

// Auto-refresh the tree when the watched folder changes on disk.
api.onFolderChanged(() => refreshTree());

// Ctrl+Tab / Ctrl+Shift+Tab switch tabs (handled here, not via menu accelerator).
// Ctrl+W close is owned by the menu accelerator to avoid double-firing.
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Tab') {
    e.preventDefault();
    switchTab(e.shiftKey ? -1 : 1);
  }
});

// ---------------------------------------------------------------------------
// Sidebar resizer
// ---------------------------------------------------------------------------

(function setupResizer() {
  const resizer = document.getElementById('sidebar-resizer');
  let dragging = false;
  resizer.addEventListener('mousedown', () => {
    dragging = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const w = Math.min(560, Math.max(140, e.clientX));
    sidebar.style.width = `${w}px`;
  });
  window.addEventListener('mouseup', () => {
    dragging = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
})();

(function setupOutlineResizer() {
  const resizer = document.getElementById('outline-resizer');
  let dragging = false;
  resizer.addEventListener('mousedown', () => {
    dragging = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const w = Math.min(560, Math.max(160, window.innerWidth - e.clientX));
    outline.style.width = `${w}px`;
  });
  window.addEventListener('mouseup', () => {
    dragging = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
})();

// ---------------------------------------------------------------------------
// Diagram zoom modal (click a Mermaid diagram to open a pan/zoom popup)
// ---------------------------------------------------------------------------

(function setupDiagramModal() {
  const modal = document.getElementById('diagram-modal');
  const canvas = document.getElementById('modal-canvas');
  const stage = document.getElementById('modal-stage');
  const zoomLevel = document.getElementById('modal-zoom-level');

  let scale = 1, tx = 0, ty = 0;
  let natW = 0, natH = 0;
  const MIN = 0.1, MAX = 12;

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function apply() {
    stage.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    zoomLevel.textContent = `${Math.round(scale * 100)}%`;
  }

  function fitToView() {
    const c = canvas.getBoundingClientRect();
    if (natW && natH) {
      scale = clamp(Math.min((c.width - 48) / natW, (c.height - 48) / natH), MIN, MAX);
    } else {
      scale = 1;
    }
    tx = (c.width - natW * scale) / 2;
    ty = (c.height - natH * scale) / 2;
    apply();
  }

  function zoomAround(cx, cy, factor) {
    const ns = clamp(scale * factor, MIN, MAX);
    tx = cx - (cx - tx) * (ns / scale);
    ty = cy - (cy - ty) * (ns / scale);
    scale = ns;
    apply();
  }

  // Build a sized, standalone copy of a diagram's <svg> for free zooming.
  function prepSvg(svgEl) {
    const clone = svgEl.cloneNode(true);
    let w = 0, h = 0;
    const vb = clone.getAttribute('viewBox');
    if (vb) {
      const p = vb.split(/[\s,]+/).map(Number);
      w = p[2]; h = p[3];
    }
    if (!w) w = parseFloat(clone.getAttribute('width')) || 800;
    if (!h) h = parseFloat(clone.getAttribute('height')) || 600;
    clone.removeAttribute('width');
    clone.removeAttribute('height');
    clone.style.maxWidth = 'none';
    clone.style.width = `${w}px`;
    clone.style.height = `${h}px`;
    return { clone, w, h };
  }

  function open(svgEl) {
    const { clone, w, h } = prepSvg(svgEl);
    natW = w; natH = h;
    stage.innerHTML = '';
    stage.appendChild(clone);
    modal.classList.remove('hidden');
    // Wait a frame so the canvas has real dimensions before fitting.
    requestAnimationFrame(fitToView);
  }

  function close() {
    modal.classList.add('hidden');
    stage.innerHTML = '';
  }

  // Open when a diagram is clicked.
  contentHost.addEventListener('click', (e) => {
    const diag = e.target.closest('.mermaid-diagram');
    if (!diag) return;
    const svg = diag.querySelector('svg');
    if (svg) open(svg);
  });

  // Toolbar
  document.getElementById('modal-zoom-in').addEventListener('click', () => {
    const c = canvas.getBoundingClientRect();
    zoomAround(c.width / 2, c.height / 2, 1.25);
  });
  document.getElementById('modal-zoom-out').addEventListener('click', () => {
    const c = canvas.getBoundingClientRect();
    zoomAround(c.width / 2, c.height / 2, 0.8);
  });
  document.getElementById('modal-zoom-reset').addEventListener('click', fitToView);
  document.getElementById('modal-close').addEventListener('click', close);

  // Wheel = zoom around cursor.
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const c = canvas.getBoundingClientRect();
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    zoomAround(e.clientX - c.left, e.clientY - c.top, factor);
  }, { passive: false });

  // Drag = pan.
  let dragging = false, moved = false, sx = 0, sy = 0;
  canvas.addEventListener('mousedown', (e) => {
    dragging = true;
    moved = false;
    sx = e.clientX - tx;
    sy = e.clientY - ty;
    canvas.classList.add('grabbing');
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    tx = e.clientX - sx;
    ty = e.clientY - sy;
    moved = true;
    apply();
  });
  window.addEventListener('mouseup', () => {
    dragging = false;
    canvas.classList.remove('grabbing');
  });

  // Click the dark backdrop (not after a drag) to close.
  canvas.addEventListener('click', (e) => {
    if (e.target === canvas && !moved) close();
  });

  // Esc closes.
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
      e.preventDefault();
      close();
    }
  });

  // Double-click on canvas resets the view.
  canvas.addEventListener('dblclick', fitToView);
})();

renderTabBar();
updateNavButtons();
buildOutline();
