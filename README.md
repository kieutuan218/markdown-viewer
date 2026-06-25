# Markdown Viewer

A desktop markdown viewer for Windows (Electron).

## Features
- **Open File / Open Folder** — toolbar buttons, or `Ctrl+O` / `Ctrl+Shift+O`. Opening a folder shows a file tree of all markdown files in the sidebar.
- **Clickable links** between markdown files. Relative and absolute paths both work.
- **Line jumps** — links like `DEAPnetwork_PoH_仕様書_v2.1_VN.md#L42` open that file and scroll to line 42 (the target flashes briefly). Heading anchors like `file.md#section-two` also work.
- **Back / Forward** — toolbar arrows, `Alt+←` / `Alt+→`, or the mouse side buttons. Returns to the **exact scroll position** you were at.
- **Tabs** — each open file gets its own tab, with its own scroll position and back/forward history. Switching back to a tab restores the exact spot you were viewing. `Ctrl+Click` a link to open it in a new tab; close with the × or middle-click.
- **Flowcharts / diagrams** — fenced ```` ```mermaid ```` blocks render as diagrams (flowchart, sequence, class, state, gantt, etc.) via [Mermaid](https://mermaid.js.org/).
- **Workspace restore** — the open folder and tabs (with scroll positions) are saved automatically and reopened next launch. Launching with a file argument opens that file instead.
- **Outline panel** — a table of contents of the current file's headings (toggle with `Ctrl+Shift+B`); click to jump, with scroll-spy highlighting.
- **Refresh** — sidebar ↻ button / `F5`, plus automatic refresh when the folder changes on disk.
- **About** — Help → About, with a credit link to [LifeCraft Lab](https://lifecraftlab.cc/).
- External `http(s)` links open in your default browser.

## Run
```powershell
npm install      # first time only
npm start
```

## Try it
Open the folder `samples/` and click around `index.md` to test links, line jumps, and back/forward.

## Project layout
- `main.js` — Electron main process (window, menus, file-system IPC).
- `preload.js` — secure bridge exposing a small `window.api`.
- `renderer/` — UI: `index.html`, `styles.css`, `renderer.js` (markdown rendering, link handling, history).
