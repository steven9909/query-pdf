//! Query PDF application entry: plugin registration, command wiring and file-open handling.

pub mod builtin;
pub mod commands;
pub mod llm;
pub mod models;
pub mod nav_guard;
pub mod secrets;

use std::path::{Path, PathBuf};

use tauri::{AppHandle, DragDropEvent, Emitter, Manager, RunEvent, WindowEvent};

use builtin::BuiltinServer;
use commands::AppState;

/// Reports whether a path has a `.pdf` extension, ignoring case.
fn has_pdf_ext(path: &Path) -> bool {
    path.extension().is_some_and(|e| e.eq_ignore_ascii_case("pdf"))
}

/// Returns the first command-line argument that names an existing PDF file.
fn pdf_from_args(args: impl IntoIterator<Item = String>) -> Option<PathBuf> {
    args.into_iter()
        .skip(1)
        .map(PathBuf::from)
        .find(|p| has_pdf_ext(p) && p.is_file())
}

/// Authorizes a user-supplied path, queues it for the frontend and notifies it in case it is already listening.
fn open_path(app: &AppHandle, path: &Path) {
    if let Ok(path) = app.state::<AppState>().authorize(path) {
        app.state::<AppState>().set_pending_open(path.clone());
        let _ = app.emit("open-file", path);
    }
}

/// Authorizes the first dropped PDF and asks the frontend to open it.
fn open_dropped(app: &AppHandle, paths: &[PathBuf]) {
    if let Some(path) = paths.iter().find(|p| has_pdf_ext(p))
        && let Ok(path) = app.state::<AppState>().authorize(path)
    {
        let _ = app.emit("open-file", path);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(nav_guard::init())
        .manage(AppState::default())
        .manage(BuiltinServer::default())
        .setup(|app| {
            if let Some(path) = pdf_from_args(std::env::args()) {
                let state = app.state::<AppState>();
                if let Ok(path) = state.authorize(&path) {
                    state.set_pending_open(path);
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) = event {
                open_dropped(window.app_handle(), paths);
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::explain,
            commands::cancel_explain,
            commands::test_provider,
            commands::list_ollama_models,
            commands::set_api_key,
            commands::has_api_key,
            commands::delete_api_key,
            commands::builtin_status,
            commands::download_model,
            commands::cancel_download,
            commands::delete_model,
            commands::read_pdf,
            commands::pick_pdf,
            commands::take_pending_open,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|handle, event| match event {
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        RunEvent::Opened { urls } => {
            if let Some(path) = urls.iter().find_map(|u| u.to_file_path().ok()) {
                open_path(handle, &path);
            }
        }
        RunEvent::Exit => handle.state::<BuiltinServer>().shutdown(),
        _ => {}
    });
}
