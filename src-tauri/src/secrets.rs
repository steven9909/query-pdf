//! API key storage in the OS keychain (macOS Keychain, Windows Credential Manager, Secret Service).

use keyring::{Entry, Error as KeyringError};

use crate::llm::Vendor;

/// Keychain service name under which every vendor key is stored.
const SERVICE: &str = "com.querypdf.app";

/// Returns the keychain account name used for `vendor`.
fn account(vendor: Vendor) -> &'static str {
    match vendor {
        Vendor::OpenAI => "openai",
        Vendor::Anthropic => "anthropic",
        Vendor::Gemini => "gemini",
        Vendor::Custom => "custom",
    }
}

/// Opens the keychain entry for `vendor`.
fn entry(vendor: Vendor) -> Result<Entry, String> {
    Entry::new(SERVICE, account(vendor)).map_err(|e| format!("keychain unavailable: {e}"))
}

/// Stores `key` for `vendor`, trimming whitespace and rejecting empty keys.
pub fn set_api_key(vendor: Vendor, key: &str) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("API key must not be empty".into());
    }
    entry(vendor)?.set_password(key).map_err(|e| format!("failed to save API key: {e}"))
}

/// Reads the stored key for `vendor`, returning `None` when none is saved.
pub fn get_api_key(vendor: Vendor) -> Result<Option<String>, String> {
    match entry(vendor)?.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(e) => Err(format!("failed to read API key: {e}")),
    }
}

/// Removes the stored key for `vendor`; succeeds if none was saved.
pub fn delete_api_key(vendor: Vendor) -> Result<(), String> {
    match entry(vendor)?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(e) => Err(format!("failed to delete API key: {e}")),
    }
}

/// Reports whether a non-empty key is stored for `vendor`.
pub fn has_api_key(vendor: Vendor) -> bool {
    matches!(get_api_key(vendor), Ok(Some(key)) if !key.is_empty())
}

#[cfg(test)]
mod tests {
    use std::sync::Once;

    use super::*;

    fn use_mock_store() {
        static INIT: Once = Once::new();
        INIT.call_once(|| keyring::set_default_credential_builder(keyring::mock::default_credential_builder()));
    }

    #[test]
    fn account_names_are_distinct() {
        let names = [Vendor::OpenAI, Vendor::Anthropic, Vendor::Gemini, Vendor::Custom].map(account);
        for (i, a) in names.iter().enumerate() {
            for b in &names[i + 1..] {
                assert_ne!(a, b);
            }
        }
    }

    #[test]
    fn rejects_empty_keys() {
        use_mock_store();
        assert!(set_api_key(Vendor::OpenAI, "").is_err());
        assert!(set_api_key(Vendor::OpenAI, "   \n").is_err());
    }

    #[test]
    fn missing_entry_is_none_and_delete_is_ok() {
        use_mock_store();
        assert_eq!(get_api_key(Vendor::Gemini).unwrap(), None);
        assert!(!has_api_key(Vendor::Gemini));
        delete_api_key(Vendor::Gemini).unwrap();
    }

    #[test]
    fn set_accepts_trimmed_key() {
        use_mock_store();
        set_api_key(Vendor::Anthropic, "  sk-test-placeholder  ").unwrap();
    }
}
