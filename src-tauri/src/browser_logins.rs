//! Saved dev-login profiles for the embedded browser.
//!
//! Credentials live in `browser-logins.json` under the app data dir with
//! the same host-local secret-file protection the provider connectors use
//! (0600 on unix). Passwords never cross into the WebView frontend: list
//! and update return metadata only, and the fill/capture eval payloads are
//! handled inside the commands in `browser.rs`.

use std::collections::HashSet;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, Url};

const STORE_FILE: &str = "browser-logins.json";
const MAX_PROFILES: usize = 100;
const MAX_FIELD_LEN: usize = 1024;
const MAX_USERNAME_LEN: usize = 320;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginProfile {
    pub id: String,
    /// `scheme://host[:port]` — fill is refused on any other origin.
    pub origin: String,
    pub username: String,
    pub password: String,
    /// Click the form's submit/next control after filling.
    #[serde(default)]
    pub submit: bool,
    /// Tick a "remember me / stay signed in" checkbox when one is present.
    #[serde(default)]
    pub remember_me: bool,
}

/// What the frontend may see — never the password.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginMeta {
    pub id: String,
    pub origin: String,
    pub username: String,
    pub submit: bool,
    pub remember_me: bool,
}

impl LoginProfile {
    pub fn meta(&self) -> LoginMeta {
        LoginMeta {
            id: self.id.clone(),
            origin: self.origin.clone(),
            username: self.username.clone(),
            submit: self.submit,
            remember_me: self.remember_me,
        }
    }
}

/// Normalize user input to an http(s) origin string, or reject it.
/// Anything below the origin (path/query) is dropped on purpose.
pub fn normalize_origin(input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    let url = Url::parse(trimmed).map_err(|_| "Enter a valid URL".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Logins can only be saved for http(s) pages".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("URLs with embedded credentials aren't allowed".into());
    }
    let origin = url.origin().ascii_serialization();
    if origin == "null" {
        return Err("Enter a valid URL".into());
    }
    Ok(origin)
}

fn store_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join(STORE_FILE))
}

fn sanitize(profile: &LoginProfile) -> Option<LoginProfile> {
    if profile.id.is_empty() || profile.id.len() > 64 {
        return None;
    }
    if profile.username.is_empty()
        || profile.username.len() > MAX_USERNAME_LEN
        || profile.password.is_empty()
        || profile.password.len() > MAX_FIELD_LEN
    {
        return None;
    }
    let origin = normalize_origin(&profile.origin).ok()?;
    Some(LoginProfile {
        id: profile.id.clone(),
        origin,
        username: profile.username.clone(),
        password: profile.password.clone(),
        submit: profile.submit,
        remember_me: profile.remember_me,
    })
}

pub fn load<R: Runtime>(app: &AppHandle<R>) -> Vec<LoginProfile> {
    let path = match store_path(app) {
        Ok(path) => path,
        Err(_) => return Vec::new(),
    };
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(_) => return Vec::new(),
    };
    let parsed: Vec<LoginProfile> = serde_json::from_str(&raw).unwrap_or_default();
    let mut seen = HashSet::new();
    parsed
        .into_iter()
        .filter_map(|profile| sanitize(&profile))
        .filter(|profile| seen.insert(profile.id.clone()))
        .take(MAX_PROFILES)
        .collect()
}

fn save<R: Runtime>(app: &AppHandle<R>, profiles: &[LoginProfile]) -> Result<(), String> {
    let path = store_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let value = serde_json::to_string(profiles).map_err(|error| error.to_string())?;
    crate::gitlab::write_secret_file(&path, &value)
}

pub fn list<R: Runtime>(app: &AppHandle<R>, origin: Option<&str>) -> Vec<LoginMeta> {
    let origin = origin.and_then(|value| normalize_origin(value).ok());
    load(app)
        .into_iter()
        .filter(|profile| origin.as_ref().is_none_or(|o| profile.origin == *o))
        .map(|profile| profile.meta())
        .collect()
}

pub fn get<R: Runtime>(app: &AppHandle<R>, id: &str) -> Option<LoginProfile> {
    load(app).into_iter().find(|profile| profile.id == id)
}

pub fn for_origin<R: Runtime>(app: &AppHandle<R>, origin: &str) -> Vec<LoginProfile> {
    load(app)
        .into_iter()
        .filter(|profile| profile.origin == origin)
        .collect()
}

/// Insert or update a profile in a loaded list: the same
/// (origin, username) pair refreshes the password and keeps the flags.
fn insert_profile(
    profiles: &mut Vec<LoginProfile>,
    origin: String,
    username: String,
    password: String,
) -> Result<LoginMeta, String> {
    if let Some(existing) = profiles
        .iter_mut()
        .find(|profile| profile.origin == origin && profile.username == username)
    {
        existing.password = password;
        return Ok(existing.meta());
    }
    if profiles.len() >= MAX_PROFILES {
        return Err(format!("You already have {MAX_PROFILES} saved logins."));
    }
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    (
        &origin,
        &username,
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
    )
        .hash(&mut hash);
    let profile = LoginProfile {
        id: format!("login-{:016x}", hash.finish()),
        origin,
        username,
        password,
        submit: false,
        remember_me: false,
    };
    let meta = profile.meta();
    profiles.push(profile);
    Ok(meta)
}

/// Save credentials captured from a page. Re-saving the same
/// (origin, username) pair updates the password and keeps the flags.
pub fn upsert_credentials<R: Runtime>(
    app: &AppHandle<R>,
    origin: &str,
    username: &str,
    password: &str,
) -> Result<LoginMeta, String> {
    let origin = normalize_origin(origin)?;
    let username = username.trim();
    if username.is_empty() || username.len() > MAX_USERNAME_LEN {
        return Err("Couldn't read the username on this page".into());
    }
    if password.is_empty() || password.len() > MAX_FIELD_LEN {
        return Err("Couldn't read the password on this page".into());
    }
    let mut profiles = load(app);
    let meta = insert_profile(
        &mut profiles,
        origin,
        username.to_string(),
        password.to_string(),
    )?;
    save(app, &profiles)?;
    Ok(meta)
}

pub fn update<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    username: Option<String>,
    submit: Option<bool>,
    remember_me: Option<bool>,
) -> Result<LoginMeta, String> {
    let mut profiles = load(app);
    let profile = profiles
        .iter_mut()
        .find(|profile| profile.id == id)
        .ok_or_else(|| "That login no longer exists".to_string())?;
    if let Some(username) = username {
        let username = username.trim().to_string();
        if username.is_empty() || username.len() > MAX_USERNAME_LEN {
            return Err("Enter a username".into());
        }
        profile.username = username;
    }
    if let Some(submit) = submit {
        profile.submit = submit;
    }
    if let Some(remember_me) = remember_me {
        profile.remember_me = remember_me;
    }
    let meta = profile.meta();
    save(app, &profiles)?;
    Ok(meta)
}

pub fn delete<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<(), String> {
    let profiles = load(app);
    let next: Vec<_> = profiles
        .into_iter()
        .filter(|profile| profile.id != id)
        .collect();
    save(app, &next)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_origins() {
        assert_eq!(
            normalize_origin("http://localhost:3000/login?next=/x").unwrap(),
            "http://localhost:3000"
        );
        assert_eq!(
            normalize_origin("https://DEV.Azure.com/team").unwrap(),
            "https://dev.azure.com"
        );
    }

    #[test]
    fn rejects_bad_origins() {
        assert!(normalize_origin("").is_err());
        assert!(normalize_origin("file:///etc/passwd").is_err());
        assert!(normalize_origin("javascript:alert(1)").is_err());
        assert!(normalize_origin("https://user:pass@host/x").is_err());
        // location.href on an unloaded or srcdoc page — capture must not
        // mint a profile for it.
        assert!(normalize_origin("about:blank").is_err());
        assert!(normalize_origin("data:text/html,<p>x</p>").is_err());
    }

    #[test]
    fn sanitize_drops_broken_entries() {
        let good = LoginProfile {
            id: "login-1".into(),
            origin: "http://localhost:3000".into(),
            username: "dev".into(),
            password: "pw".into(),
            submit: false,
            remember_me: false,
        };
        assert!(sanitize(&good).is_some());
        for broken in [
            LoginProfile {
                id: "".into(),
                ..good.clone()
            },
            LoginProfile {
                password: "".into(),
                ..good.clone()
            },
            LoginProfile {
                origin: "ftp://x".into(),
                ..good.clone()
            },
            LoginProfile {
                username: " ".repeat(0),
                ..good.clone()
            },
        ] {
            assert!(sanitize(&broken).is_none());
        }
    }

    #[test]
    fn insert_dedupes_by_origin_and_username() {
        let mut profiles = Vec::new();
        let first = insert_profile(
            &mut profiles,
            "http://localhost:3000".into(),
            "dev".into(),
            "pw1".into(),
        )
        .unwrap();
        // Same origin + username → update, not a second profile.
        let second = insert_profile(
            &mut profiles,
            "http://localhost:3000".into(),
            "dev".into(),
            "pw2".into(),
        )
        .unwrap();
        assert_eq!(profiles.len(), 1);
        assert_eq!(first.id, second.id);
        assert_eq!(profiles[0].password, "pw2");

        // A different port is a different origin — credentials must not
        // bleed between dev servers.
        insert_profile(
            &mut profiles,
            "http://localhost:8080".into(),
            "dev".into(),
            "pw3".into(),
        )
        .unwrap();
        assert_eq!(profiles.len(), 2);

        // A different user on the same origin is its own profile.
        insert_profile(
            &mut profiles,
            "http://localhost:3000".into(),
            "admin".into(),
            "pw4".into(),
        )
        .unwrap();
        assert_eq!(profiles.len(), 3);
    }

    #[test]
    fn meta_never_carries_the_password() {
        let profile = LoginProfile {
            id: "login-1".into(),
            origin: "http://localhost:3000".into(),
            username: "dev".into(),
            password: "s3cret".into(),
            submit: true,
            remember_me: true,
        };
        let meta = profile.meta();
        let json = serde_json::to_string(&meta).unwrap();
        assert!(!json.contains("s3cret"));
        assert_eq!(meta.username, "dev");
        assert!(meta.submit);
    }
}
