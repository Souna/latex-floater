// src-tauri/src/lib.rs — the whole native side of LaTeX Floater.
//
// This replaces what used to be Electron's main process (main.js). It is
// deliberately tiny: the window itself is declared in tauri.conf.json, its
// size and position are remembered by the window-state plugin, and the
// renderer talks to this file through three commands (copy_text, copy_image,
// set_opacity) plus one global hotkey. Everything else — history, theme,
// font size, the pin state — lives in the renderer's localStorage, because
// nothing native needs to know about it.

use base64::Engine;
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

const SUMMON_HOTKEY: &str = "CmdOrCtrl+Alt+L";

// Plain text to the system clipboard — the LaTeX source.
#[tauri::command]
fn copy_text(app: AppHandle, text: String) -> Result<(), String> {
    app.clipboard().write_text(text).map_err(|e| e.to_string())
}

// A PNG to the system clipboard. The renderer rasterises the expression
// itself (see renderLatexToPng in src/bridge.js) and hands over the PNG
// bytes as base64; Tauri's clipboard plugin wants a decoded Image, which is
// what the "image-png" feature in Cargo.toml is for.
#[tauri::command]
fn copy_image(app: AppHandle, png_base64: String) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(png_base64)
        .map_err(|e| e.to_string())?;
    let image = tauri::image::Image::from_bytes(&bytes).map_err(|e| e.to_string())?;
    app.clipboard().write_image(&image).map_err(|e| e.to_string())
}

// Whole-window opacity. Neither tauri nor tao exposes this, and doing it in
// CSS would need a transparent window (which costs the native shadow and
// resize borders on Windows), so it goes straight to the OS. Both platforms
// insist that window attributes are touched from the main thread, and Tauri
// runs commands on a worker thread, hence run_on_main_thread.
#[tauri::command]
fn set_opacity(window: WebviewWindow, value: f64) -> Result<(), String> {
    let value = value.clamp(0.2, 1.0);
    let target = window.clone();
    window
        .run_on_main_thread(move || apply_opacity(&target, value))
        .map_err(|e| e.to_string())
}

#[cfg(windows)]
fn apply_opacity(window: &WebviewWindow, value: f64) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetLayeredWindowAttributes, SetWindowLongPtrW, GWL_EXSTYLE, LWA_ALPHA,
        WS_EX_LAYERED,
    };
    let Ok(hwnd) = window.hwnd() else { return };
    let hwnd = hwnd.0 as _;
    // A layered window is composited differently, so only be one while
    // actually translucent; at full opacity go back to a normal window.
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        if value >= 1.0 {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex & !(WS_EX_LAYERED as isize));
        } else {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex | WS_EX_LAYERED as isize);
            SetLayeredWindowAttributes(hwnd, 0, (value * 255.0).round() as u8, LWA_ALPHA);
        }
    }
}

#[cfg(target_os = "macos")]
fn apply_opacity(window: &WebviewWindow, value: f64) {
    use objc2_app_kit::NSWindow;
    let Ok(ns_window) = window.ns_window() else { return };
    // ns_window() hands back the NSWindow* tao owns; we only borrow it for
    // one property write on the main thread, which is exactly what AppKit
    // permits.
    unsafe {
        let ns_window: &NSWindow = &*(ns_window as *const NSWindow);
        ns_window.setAlphaValue(value);
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
fn apply_opacity(_window: &WebviewWindow, _value: f64) {}

// Ctrl+Alt+L (Cmd+Alt+L on macOS) from anywhere: bring the floater back.
fn summon(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Remembers the main window's size and position across launches in
        // the app's data directory, and clamps them to a visible monitor on
        // restore — the same job main.js used to do by hand with a JSON
        // file, minus the DPI rounding bug that made the window grow every
        // launch under Electron.
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            // Registered here rather than via with_shortcuts() so that a
            // hotkey another app already owns degrades to "no hotkey"
            // instead of refusing to start at all.
            let result = app.global_shortcut().on_shortcut(SUMMON_HOTKEY, |app, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    summon(app);
                }
            });
            if let Err(e) = result {
                eprintln!("Could not register {SUMMON_HOTKEY}: {e}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![copy_text, copy_image, set_opacity])
        .run(tauri::generate_context!())
        .expect("error while running LaTeX Floater");
}
