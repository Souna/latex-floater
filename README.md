# LaTeX Floater

A small always-on-top desktop window for writing LaTeX fast. Type directly into the math field and copy the result out as LaTeX source or a PNG image.

## What's in the box

- Always-on-top frameless window (remembers its position and size between sessions)
- MathQuill-powered editor with direct typing — `\frac`, `\sqrt`, `^`, `_`, and typed Greek-letter/function names all work as you'd expect
- Typed shorthand substitution: lowercase Greek names like `alpha` and `theta` become `\alpha` and `\theta` as soon as you finish typing them; `inf` and uppercase Greek names like `Gamma` substitute when you press Space
- Live LaTeX source readout under the editor, click it to copy instantly
- Expression history — step back through your last 20 expressions with `Alt+Up` / `Alt+Down`
- Two output formats:
  - **Copy LaTeX** — for Overleaf, Obsidian, Notion (`$$...$$`), Jupyter, GitHub, Markdown, Discord
  - **PNG** — for Google Docs, email, Slack, PowerPoint, or anywhere else without math rendering
- Light/dark theme toggle, an opacity slider, and font-size controls in the titlebar
- Global hotkey `Ctrl+Alt+L` summons and focuses the window from any application
- Keyboard shortcuts: `Ctrl+Enter` copy LaTeX, `Esc` copy and clear, `Alt+Up`/`Alt+Down` browse history

## Setup

You need [Node.js](https://nodejs.org/) 18 or newer installed.

```powershell
cd latex-floater
npm install
npm start
```

First `npm install` pulls Electron (~150 MB) plus MathQuill and jQuery. Subsequent starts are fast.

## Packaging into a standalone `.exe`

To build an installer you can run without Node installed:

```powershell
npm run dist
```

Output lands in `dist/`. The unpacked app directory is also available via `npm run pack` if you just want to zip it up.

## Usage notes

- **Pin button** (top-right, amber when active) toggles always-on-top.
- **The whole top bar is draggable** — grab it to reposition the window.
- **Window resizes normally** from any edge. Minimum size is 480×280.
- **Drag-resize remembers** the new size between sessions.
- **Typing LaTeX directly**: start a command with `\` and MathQuill converts as you type. Try `\frac`, `\sqrt`, `\alpha`, etc.
- **Sub/super**: `_` and `^` work like in a LaTeX source file, and the caret stays inside the structure until you explicitly move out of it (press Tab or the arrow keys), matching Symbolab's feel.
- **Shorthand words**: type a bare word from the shorthand list (see `SHORTHANDS` in `src/app.js`) and press Space to substitute it for the matching LaTeX command.
- **History**: `Alt+Up` steps to older expressions, `Alt+Down` steps back toward your current draft.

## File layout

```
latex-floater/
  package.json
  src/
    main.js       ← Electron main process (window, IPC, clipboard, global hotkey)
    preload.js    ← Bridge between main and renderer
    index.html    ← UI markup
    styles.css    ← Dark/light theme, IBM Plex typography
    app.js        ← MathQuill wiring, history, shorthand substitution, copy handlers, shortcuts
```

## Notes

There is no symbol palette in the current build — the editor is a single math field driven by typing and shorthand substitution. `temml` appears in `package.json` but isn't used anywhere yet; it was pulled in for a planned MathML export that hasn't been built.
