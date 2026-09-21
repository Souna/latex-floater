# LaTeX Floater

A small always-on-top desktop window for writing LaTeX fast. Type directly into the math field and copy the result out as LaTeX source or a PNG image. Runs on Windows and macOS.

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
- Global hotkey `Ctrl+Alt+L` (`Cmd+Alt+L` on macOS) summons and focuses the window from any application
- Keyboard shortcuts: `Ctrl+Enter` copy LaTeX, `Esc` copy and clear, `Alt+Up`/`Alt+Down` browse history

## Installing a release

Grab the installer for your platform from the `src-tauri/target/release/bundle/` output of a build (or from whoever built it for you) and run it. Windows gets an NSIS `.exe` installer (and an `.msi`), macOS gets a `.dmg`. The app is a few megabytes because it uses the web view your operating system already has (WebView2 on Windows, WebKit on macOS) instead of shipping a browser of its own.

On Windows 10, if the installer says WebView2 is missing, it will fetch it; Windows 11 has it built in.

## Building from source

You need [Node.js](https://nodejs.org/) 18 or newer and the [Rust toolchain](https://rustup.rs/). On Windows, Rust also needs the "Desktop development with C++" workload from the Visual Studio Build Tools; on macOS, run `xcode-select --install` once.

```sh
cd latex-floater
npm install
npm run dev      # run it, with hot reload of the frontend
npm run build    # produce installers in src-tauri/target/release/bundle/
```

The first `npm run dev` or `npm run build` compiles the Rust side, which takes a few minutes; after that it's seconds. `npm install` pulls MathQuill, jQuery, MathJax and the Tauri CLI, and a small script copies the four runtime files the app actually loads into `src/vendor/` before every run and build.

## Usage notes

- **Pin button** (top-right, amber when active) toggles always-on-top.
- **The whole top bar is draggable** — grab it to reposition the window.
- **Window resizes normally** from any edge. Minimum size is 480×280.
- **Drag-resize remembers** the new size between sessions.
- **Typing LaTeX directly**: start a command with `\` and MathQuill converts as you type. Try `\frac`, `\sqrt`, `\alpha`, etc.
- **Sub/super**: `_` and `^` work like in a LaTeX source file, and the caret stays inside the structure until you explicitly move out of it (press Tab or the arrow keys), matching Symbolab's feel.
- **Shorthand words**: type a bare word from the shorthand list (see `SHORTHANDS` in `src/app.js`) and press Space to substitute it for the matching LaTeX command.
- **History**: `Alt+Up` steps to older expressions, `Alt+Down` steps back toward your current draft.
- **PNG export** renders the expression with real TeX glyphs (via MathJax) on a white background at twice the editor's font size, so it stays crisp when pasted somewhere that scales it up. The first export in a session takes a moment longer while MathJax loads.

## File layout

```
latex-floater/
  package.json
  scripts/vendor.js       ← copies the third-party runtime files into src/vendor/
  src/                    ← the frontend, bundled as-is into the app
    index.html            ← UI markup
    styles.css            ← Dark/light theme, IBM Plex typography
    bridge.js             ← window.floater: clipboard, window chrome, PNG rendering
    app.js                ← MathQuill wiring, history, shorthand substitution, copy handlers, shortcuts
    fonts/                ← IBM Plex, self-hosted
  src-tauri/              ← the native shell (Rust)
    src/lib.rs            ← clipboard and opacity commands, global hotkey, plugins
    tauri.conf.json       ← window definition, bundle settings
    capabilities/         ← what the frontend is allowed to ask the native side for
```

## Notes

There is no symbol palette in the current build — the editor is a single math field driven by typing and shorthand substitution. A MathML export was once planned but hasn't been built.

Earlier versions were built on Electron; the switch to Tauri (September 2026) kept the frontend and cut the installer from about 80 MB to a few.
