# CLAUDE.md — project briefing for Claude Code

This file is auto-read at the start of every Claude Code session in this directory. It describes the codebase **as it currently exists** (last verified 2026-09-20 by reading every file in `src/`). If you're about to say something here doesn't match what you see in `src/`, trust the code — update this file, don't argue with it.

## What this project is

**LaTeX Floater** is a small Windows desktop utility: a floating, always-on-top window for writing LaTeX fast and copying it out to LaTeX source or PNG. It's a single math field — type LaTeX directly (`\frac`, `\sqrt`, `^`, `_`, typed function/Greek-letter names) — in a compact frameless window that stays on top of whatever the user is writing into (Word, Overleaf, email, Slack, etc.).

There is **no symbol palette** in the UI. Earlier design notes for this project described a Symbolab-style tabbed palette; that was never built (or was removed) in the current implementation. The whole interaction model is: type, watch it render, copy.

## Stack (decided — don't re-evaluate without a reason)

- **Electron** for the shell.
- **MathQuill** (`node_modules/mathquill`, loaded via a `<script>` tag plus jQuery as its required dependency) is the math editor engine. It's initialized as `MQ.MathField(...)` in [app.js](src/app.js). MathQuill was chosen specifically because `spaceBehavesLikeTab` keeps the caret inside a superscript/subscript/fraction until the user explicitly tabs or arrows out — matching Symbolab's cursor feel more closely than the alternatives.
- **jQuery** is present solely because MathQuill 0.10's build requires it as a global. Nothing else in the app uses it.
- **`temml`** is listed in `package.json` dependencies and in `electron-builder`'s `build.files` glob, but it is **not imported or referenced anywhere in the source**. It's a dead dependency left over from an abandoned MathML-export feature — see "Things that are intentionally NOT in v1" below.
- **No framework** in the renderer — plain HTML/CSS/JS.
- **IBM Plex** (Sans + Mono) for typography, loaded from Google Fonts. Accent color is amber `#d4a45c`.
- **No extra clipboard/image libraries.** Electron's built-in `clipboard` + `nativeImage` cover text and PNG.

## File layout

```
latex-floater/
├── package.json     Electron + MathQuill/jQuery/temml deps, npm scripts, electron-builder config
├── README.md         User-facing setup and usage
├── CLAUDE.md         ← this file
└── src/
    ├── main.js             Electron main process: window creation, IPC, clipboard, position persistence, global hotkey, off-screen PNG rendering
    ├── preload.js          contextBridge exposing window.floater.{copyText, copyImage, togglePin, minimize, close, setOpacity, onFocus, getPinState, renderPng}
    ├── index.html          UI markup (titlebar, editor field, source readout, actions)
    ├── styles.css          Dark/light theme via CSS variables, dense layout
    ├── app.js              MathQuill wiring, history, shorthand substitution, copy handlers, keyboard shortcuts, theme/opacity/font-size controls
    ├── capture.html        Markup for the hidden PNG-export window — just a bare math field, no app chrome
    ├── capture.js          Renders one LaTeX string into capture.html and reports its true size back to main.js
    └── capture-preload.js  contextBridge exposing window.captureBridge.{onRender, reportSize} — separate, smaller bridge just for the capture window
```

There is no separate palette data file — there is no palette.

## Key architectural decisions and why

**Two output formats, not three.** Copy LaTeX is primary (Overleaf, Obsidian, Notion, Markdown, Jupyter, Discord). PNG is the fallback for anywhere without math rendering (Google Docs, email, Slack, PowerPoint). A MathML export was planned (the `temml` dependency is a remnant of that) but was never wired up — no button, no shortcut, no handler exists.

**PNG is produced by screenshotting a hidden, off-screen second window**, not by any markup-to-image library and not by capturing the visible app window. `copyPng()` in [app.js](src/app.js) calls `window.floater.renderPng(latex, fontSize)`, which invokes the `png:render` handler in [main.js](src/main.js) — that handler lazily creates (and thereafter reuses) an invisible `BrowserWindow` (`show: false`, `skipTaskbar: true`) loading `capture.html`, sends it the LaTeX via `capture:render`, waits for `capture.js` to render it and report back its true rendered size over `capture:size-reported`, calls `setContentSize()` on the hidden window to exactly fit that, then `capturePage()`s it and returns a PNG data URL.

This replaced an earlier version that resized the *visible* app window to fit oversized expressions before capturing — which worked, but visibly ballooned the real window on every export of anything too big for it. It also replaced an even earlier version that used `mqEl.scrollWidth`/`scrollHeight` to detect when a resize was needed, which never actually worked: MathQuill's own CSS forces `.mq-root-block` to `width:100%` of its container, and with `overflow: visible` everywhere in this component's CSS (nothing sets `hidden`/`scroll`/`auto`), `scrollWidth`/`scrollHeight` just return `clientWidth`/`clientHeight` in Chromium — i.e. always "no overflow," even when there obviously is. `capture.html` avoids the whole problem by deliberately *not* setting `width:100%` anywhere in its own CSS, so its `#mf` field naturally shrink-to-fits its content and `getBoundingClientRect()` on it reports the true size regardless of the hidden window's current (much smaller) dimensions — verified directly in a browser: a wide expression reported a 1401px-wide bounding rect inside a 600px viewport.

The capture window is intentionally never shown and is reused across exports rather than recreated each time (avoids ~200ms of window/page startup cost per export). It always renders white-background/dark-text regardless of the app's current light/dark theme, since the exported image isn't meant to carry the app's UI theme.

**No palette — direct typing plus shorthand substitution instead.** Rather than clickable buttons, the app supports typing a bare word and having it become the LaTeX command. Two mechanisms do this and they must not overlap. Lowercase Greek letters, `infty` and `sqrt` are MathQuill `autoCommands` (configured in the `MQ.MathField` options in [app.js](src/app.js)) and convert the instant the last letter is typed, no Space needed. Words MathQuill won't handle itself — `inf` and the uppercase Greek letters — live in the `SHORTHANDS` map and convert when the user presses Space, via a capture-phase `keydown` listener that intercepts Space before MathQuill consumes it. On Space, the word to replace is read back from MathQuill's node list by walking left from the caret over plain-letter nodes (`wordLeftOfCaret()`), not from a tally of keystrokes: a tally can't tell when the caret moved or when an autoCommand already collapsed the letters, and the earlier tally-based version deleted one character too many for every lowercase Greek word (`x+pi` then Space gave `x\pi`). If you add a word to `SHORTHANDS`, make sure it is not also an autoCommand.

**Expression history.** The last 20 copied/cleared expressions are kept in `localStorage` (key `history`) and navigated with `Alt+Up` / `Alt+Down`. Navigating swaps the field's LaTeX via `mf.latex(...)`; a `navigating` flag suppresses the edit handler so browsing history doesn't itself get treated as a new edit that resets the history cursor.

**Always-on-top default is ON, at level `'floating'`.** Toggleable via the pin button (amber when active). State persists across sessions. The pinned/unpinned state is tracked in its own `pinned` variable in [main.js](src/main.js:32), not by querying `mainWindow.isAlwaysOnTop()` — that query didn't reliably reflect what was last set on Windows, which fed a wrong value into the toggle handler, the pin button's displayed state, and the save-on-close all at once (three symptoms, one bad source). Toggle, boot-sync (`window:get-pin-state`), and save-on-close all read/write that same variable now; nothing asks Electron for the current state.

**Global hotkey `Ctrl+Alt+L`** summons/focuses the window from any app, registered in `app.whenReady()` in [main.js](src/main.js) via `globalShortcut`, unregistered on `will-quit`.

**Window is frameless with a custom titlebar.** Drag region is the whole top bar (`-webkit-app-region: drag`), with `no-drag` overrides on the buttons and the opacity slider. Geometry and pin state persist to `%APPDATA%/latex-floater/floater-settings.json` on close, clamped to on-screen displays on next launch in case monitors changed. The saved geometry is `getPosition()`/`getSize()` minus a `geometrySlop` measured right after the window is created: on Windows at a fractional display scale Chromium creates the HWND a few physical pixels larger than requested and Electron rounds the readback up, so `getSize()` reports 3 to 5 DIP more than was asked for (verified at 175%: 620×380 requested, 623×383 reported, 1089×669 physical), and position rounds the other way by 1 DIP. Saving the readbacks verbatim made the window grow 3px and creep 1px up-left on every launch.

**Light/dark theme toggle.** `[data-theme="light"]` on `<html>` swaps every CSS variable defined in the `:root` block in `styles.css`; the choice persists in `localStorage`. Dark is the default.

**Opacity and font-size controls live in the titlebar.** Opacity is applied via IPC (`window:set-opacity` → `mainWindow.setOpacity`, clamped to [0.2, 1] in main.js) rather than CSS, since it needs to affect the whole native window, not just page content. Font size is applied directly to the MathQuill field element's `style.fontSize` and persisted in `localStorage`.

**IPC surface stays minimal.** If a renderer action can be done in the renderer, do it there. The preload bridge (`window.floater`) covers: `copyText`, `copyImage`, `togglePin`, `minimize`, `close`, `setOpacity`, `getPinState`, `renderPng`, and the `onFocus` event listener (used to refocus the math field when the window regains focus). The hidden capture window has its own separate, smaller bridge (`window.captureBridge`, from `capture-preload.js`): `onRender`, `reportSize` — kept apart from `window.floater` because it's a fundamentally different page with no UI of its own.

## Conventions

- **Comments explain the *why*, not the *what***. The existing source files are heavily commented specifically because the user wanted readable code; preserve this style. Prefer a paragraph at the top of each logical section over sprinkled inline comments.
- **No bullet-point overuse in user-facing copy** (README, errors, status messages). Write in sentences.
- **CSS variables over hardcoded colors.** All theming goes through the `:root` (dark) and `[data-theme="light"]` blocks at the top of `styles.css`.
- **MathQuill CSS overrides are compound selectors, and mathquill.css loads first.** MathQuill adds `mq-editable-field mq-math-mode` to the `#mf` element itself, so overrides of the field's own styling must be written `.editor__field.mq-editable-field` (no space). `index.html` links `mathquill.css` before `styles.css` so that on a specificity tie (including `!important` vs `!important`) the app's rules win. Descendant rules for things inside the field (`.mq-cursor`, `.mq-selection`, `.mq-root-block`) keep the space.
- **IPC surface stays minimal.** See above.
- **Status messages use `flashStatus(msg, type)`** — don't invent new notification patterns.

## Keyboard shortcuts (in `app.js`)

- `Ctrl+Enter` → copy LaTeX (primary action)
- `Ctrl+C` → copy LaTeX, but only when MathQuill has no active selection; if there's a selection, native copy behavior is left alone so only the highlighted portion is copied
- `Esc` → copy current expression to history, then clear the field
- `Alt+Up` / `Alt+Down` → step backward/forward through expression history
- Clicking the TeX source readout bar also copies LaTeX instantly

MathQuill's own shortcuts (`/` for fraction, autocommands for `pi`, `theta`, `sqrt`, etc. per the `autoCommands`/`autoOperatorNames` config in `app.js`) are active inside the math field, alongside the app's own typed-word `SHORTHANDS` substitution.

## Things that are intentionally NOT in v1 (or were removed/abandoned)

- **No symbol palette.** Earlier design intent called for one; it isn't in the current UI. If it's wanted, it would need to be built from scratch — there's no dormant palette code to resurrect.
- **No MathML export.** The `temml` dependency exists but is unused dead weight — either wire it up or remove it from `package.json`/`build.files`.
- **No LaTeX preamble management.** Users paste the output into their own document where preamble lives.
- **No equation numbering, alignment environments.** MathQuill's default command set doesn't include a matrix/cases UI, and none has been added here.
- **No cloud sync of settings.** The settings file is local. That's fine for a single-user utility.

## Open threads / likely next asks

1. **Decide the fate of `temml` and MathML export** — either implement Copy MathML (temml can render LaTeX → MathML string) or drop the dependency.
2. **Decide the fate of the symbol palette** — earlier project intent wanted one; current UI doesn't have it. Worth confirming whether it's still wanted before building it.
3. **Packaged `.exe` distribution.** `dist/win-unpacked` already exists from a prior `npm run dist` / `npm run pack` run, but the installer path (code signing, icon) is likely still untested end-to-end.
4. **Matrix/cases/align environments** — no UI support currently; would need either palette-style buttons or more MathQuill commands wired into `autoCommands`.

## Running locally

```powershell
npm install
npm start
```

First install pulls Electron (~150MB) plus MathQuill and jQuery. Subsequent starts are fast.

## If something breaks

- **MathQuill not loading**: check the script src paths in `index.html` — they point to `../node_modules/jquery/dist/jquery.min.js` and `../node_modules/mathquill/build/mathquill.min.js`, which only resolve during `npm start` from the project root. A packaged build relies on `electron-builder` copying `node_modules/mathquill/build/**/*` and the jQuery file per the `build.files` glob in `package.json`.
- **Math field styling looks broken** (a gray border or blue glow around the field, system-blue selection, cursor color or font color not following theme): the `.editor__field.mq-editable-field` / `.mq-cursor` / `.mq-selection` / `.mq-root-block` overrides in `styles.css` are the first suspect — a MathQuill version bump could rename these classes, and the stylesheet order in `index.html` (mathquill.css first) must hold. The same applies to the `#mf` rule in `capture.html`, which is what keeps the border out of exported PNGs.
- **Window appearing off-screen**: delete `%APPDATA%/latex-floater/floater-settings.json`. The main process clamps saved coords to current displays but this is a safety valve.
- **PNG export producing empty/broken/cropped images**: the flow spans three files now — `copyPng()` in `app.js` (calls `renderPng`), the `png:render` handler in `main.js` (owns the hidden capture window, the `setContentSize` call, and the `capture:size-reported` wait), and `capture.js` (measures `#mf`'s `getBoundingClientRect()` and reports it back). If the image is cropped, suspect the measurement in `capture.js` first — it depends on `capture.html` never constraining `#mf` to a percentage width; if that page's CSS changes, re-verify the shrink-to-fit behavior still holds.
- **Global hotkey not firing**: `Ctrl+Alt+L` is registered once in `app.whenReady()` in `main.js`; if another app already holds that combination, `globalShortcut.register` silently fails to bind it.
