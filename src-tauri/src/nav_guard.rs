//! Plugin that confines webview navigation to the app's own origins.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Runtime, Url};

/// Dev server origin allowed only in debug builds.
const DEV_HOST: &str = "localhost";
/// Dev server port allowed only in debug builds.
const DEV_PORT: u16 = 1420;

/// Reports whether `url` belongs to the bundled frontend (or the dev server in debug builds).
pub fn is_app_url(url: &Url) -> bool {
    match url.scheme() {
        "tauri" => true,
        "http" | "https" if url.host_str() == Some("tauri.localhost") => true,
        "http" => cfg!(debug_assertions) && url.host_str() == Some(DEV_HOST) && url.port() == Some(DEV_PORT),
        _ => false,
    }
}

/// Builds the `nav-guard` plugin, which cancels every navigation outside the app's origins without opening it elsewhere.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("nav-guard").on_navigation(|_, url| is_app_url(url)).build()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allowed(s: &str) -> bool {
        is_app_url(&Url::parse(s).unwrap())
    }

    #[test]
    fn allows_only_app_origins() {
        assert!(allowed("tauri://localhost/index.html"));
        assert!(allowed("http://tauri.localhost/"));
        assert!(allowed("https://tauri.localhost/assets/x.js"));
        assert_eq!(allowed("http://localhost:1420/"), cfg!(debug_assertions));
        for denied in [
            "https://example.com/",
            "http://localhost:1421/",
            "https://localhost:1420/",
            "http://tauri.localhost.evil.com/",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,hi",
            "mailto:a@b.c",
        ] {
            assert!(!allowed(denied), "{denied}");
        }
    }
}
