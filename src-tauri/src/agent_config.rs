//! Agent environment inventory: MCP servers, plugins, hooks and instruction
//! files across the harnesses MonoCode drives. Read-mostly — toggles write a
//! single boolean only where the provider natively supports an enabled flag,
//! via surgical edits that preserve file formatting and comments.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::dirs_home;
use crate::fs::{expand_home, rename_path_sync};
use crate::wsl;

const MAX_CONFIG_BYTES: u64 = 8 * 1024 * 1024;
const MAX_HOOK_REFS: usize = 8;
const MAX_INSTRUCTION_FILES: usize = 200;

/// Shared-standard AGENTS.md readers among the harnesses we drive.
const AGENTS_MD_READERS: &[&str] = &[
    "codex", "devin", "opencode", "pi", "omp", "copilot", "cursor", "grok", "fx",
];
const CLAUDE_MD_READERS: &[&str] = &["claude", "devin", "copilot"];

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ToggleRef {
    pub file: String,
    pub format: String, // "json" | "toml"
    pub path: Vec<String>,
    pub member: String, // "enabled" | "disabled"
    pub invert: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToggleRequest {
    pub file: String,
    pub format: String,
    pub path: Vec<String>,
    pub member: String,
    #[serde(default)]
    pub invert: bool,
}

/// Where and how an inventory entry can be removed from its config file.
/// `format` "file" means the entry is itself a file, removed by renaming it
/// to `<name>.monocode-bak` so the removal stays recoverable.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RemoveRef {
    pub file: String,
    /// "json" | "toml" | "file"
    pub format: String,
    /// Member path (JSON) or table/member path (TOML). Numeric segments in a
    /// JSON path address array elements by index.
    #[serde(default)]
    pub path: Vec<String>,
    /// Remove one element from the array at `path` instead of a member; for
    /// TOML array-of-tables it disambiguates the block by name/command.
    #[serde(default)]
    pub array_item: Option<String>,
    /// Content the element at `path` must still contain — protects index-based
    /// refs from cutting a different entry after the file changed.
    #[serde(default)]
    pub expect: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct McpServerEntry {
    pub name: String,
    pub scope: String, // "project" | "user" | "local"
    pub file: String,
    /// "stdio" | "http" | "sse" | "unknown"
    pub transport: String,
    /// Command line or URL shown to the user; env values are never emitted.
    pub summary: String,
    pub detail: Option<String>,
    /// None means "the provider does not gate this server" (always loaded) or,
    /// for Claude project servers, "waiting for approval".
    pub enabled: Option<bool>,
    pub toggle: Option<ToggleRef>,
    pub remove: Option<RemoveRef>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PluginEntry {
    pub id: String,
    /// "plugin" | "marketplace" | "extension"
    pub kind: String,
    pub scope: String,
    pub file: String,
    pub detail: Option<String>,
    pub installed: bool,
    /// Forced by a managed (admin) settings file — user toggles are ignored.
    pub managed: bool,
    pub enabled: Option<bool>,
    pub toggle: Option<ToggleRef>,
    pub remove: Option<RemoveRef>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HookRef {
    pub path: String,
    /// None when the path contains an unresolved environment variable.
    pub exists: Option<bool>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HookEntry {
    pub event: String,
    pub matcher: Option<String>,
    /// "command" | "prompt"
    pub kind: String,
    pub command: Option<String>,
    pub file: String,
    pub scope: String,
    pub refs: Vec<HookRef>,
    pub remove: Option<RemoveRef>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InstructionEntry {
    pub path: String,
    pub name: String,
    /// "rules" | "subagent" | "command"
    pub kind: String,
    pub scope: String,
    pub consumers: Vec<String>,
    pub size: u64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ConfigFileEntry {
    pub path: String,
    /// "mcp" | "hooks" | "plugins" | "settings" | "config"
    pub kind: String,
    pub size: u64,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProviderExtensions {
    pub provider: String,
    pub detected: bool,
    pub mcp_servers: Vec<McpServerEntry>,
    pub plugins: Vec<PluginEntry>,
    pub hooks: Vec<HookEntry>,
    /// Config files that exist on disk, for context and reveal actions.
    pub files: Vec<ConfigFileEntry>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfigInventory {
    pub providers: Vec<ProviderExtensions>,
    pub instructions: Vec<InstructionEntry>,
}

// ---------------------------------------------------------------------------
// Host/WSL IO helpers. Paths are JS identities: host paths are plain strings,
// WSL paths are `//wsl.localhost/<distro>/<linux path>`.

fn read_config_text(path: &Path) -> Option<String> {
    match wsl::path_location(path) {
        Ok(Some(location)) => {
            return wsl::request::<String>(&location, "read_text", json!({}))
                .ok()
                .map(|text| strip_bom(&text).to_string());
        }
        Ok(None) => {}
        // A WSL-prefixed path that failed validation must not fall back to
        // host UNC I/O.
        Err(_) => return None,
    }
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_CONFIG_BYTES {
        return None;
    }
    std::fs::read_to_string(path)
        .ok()
        .map(|text| strip_bom(&text).to_string())
}

fn strip_bom(text: &str) -> &str {
    text.strip_prefix('\u{feff}').unwrap_or(text)
}

fn write_config_text(path: &Path, content: &str) -> Result<(), String> {
    // Atomic temp+rename on the host, and the guest-side bridge for WSL;
    // path errors fail closed rather than falling back to UNC I/O.
    crate::fs::write_text_file_sync(&path.to_string_lossy(), content)
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct InspectEntry {
    path: String,
    #[serde(default)]
    size: Option<u64>,
    #[serde(default)]
    is_dir: bool,
}

/// Existence + size + isDir for many paths; WSL paths go in one bridge batch.
fn inspect_all(paths: &[PathBuf]) -> HashMap<String, (u64, bool)> {
    let mut out = HashMap::new();
    let strings: Vec<String> = paths
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    // A single malformed WSL identity must not poison the whole batch.
    let valid: Vec<String> = strings
        .iter()
        .filter(|s| wsl::location(s).is_ok())
        .cloned()
        .collect();
    if let Ok(entries) = wsl::file_batches::<InspectEntry>(&valid, "inspect") {
        for entry in entries {
            out.insert(entry.path, (entry.size.unwrap_or(0), entry.is_dir));
        }
    }
    for (i, path) in paths.iter().enumerate() {
        let key = &strings[i];
        if out.contains_key(key) || !matches!(wsl::location(key), Ok(None)) {
            continue;
        }
        if let Ok(meta) = std::fs::metadata(path) {
            out.insert(key.clone(), (meta.len(), meta.is_dir()));
        }
    }
    out
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct DirListEntry {
    name: String,
    path: String,
    #[serde(default)]
    is_dir: bool,
}

/// List one directory (names only used); missing/empty → empty vec.
fn list_dir(path: &Path) -> Vec<DirListEntry> {
    match wsl::path_location(path) {
        Ok(Some(location)) => {
            return wsl::files_request::<Vec<DirListEntry>>(&location, "list", json!({}))
                .unwrap_or_default();
        }
        Ok(None) => {}
        Err(_) => return Vec::new(),
    }
    let Ok(reader) = std::fs::read_dir(path) else {
        return Vec::new();
    };
    reader
        .flatten()
        .filter_map(|ent| {
            let name = ent.file_name().to_str()?.to_string();
            Some(DirListEntry {
                path: crate::fs::path_to_js(&ent.path()),
                is_dir: ent.file_type().map(|t| t.is_dir()).unwrap_or(false),
                name,
            })
        })
        .collect()
}

fn home_for(project: &Path) -> Option<PathBuf> {
    if let Ok(Some(location)) = wsl::path_location(project) {
        if let Ok(home) = wsl::path_request(&location, "home", json!({})) {
            return Some(PathBuf::from(home));
        }
        return None;
    }
    dirs_home().map(PathBuf::from)
}

fn js(path: &Path) -> String {
    crate::fs::path_to_js(path)
}

// ---------------------------------------------------------------------------
// JSON: comment stripping for reads, surgical member-set for writes.

/// Replaces // and /* */ comments with spaces, preserving string contents and
/// byte offsets so positions stay valid for later edits.
fn strip_json_comments(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    let mut in_string = false;
    while i < bytes.len() {
        let b = bytes[i];
        if in_string {
            out.push(b);
            if b == b'\\' && i + 1 < bytes.len() {
                out.push(bytes[i + 1]);
                i += 2;
                continue;
            }
            if b == b'"' {
                in_string = false;
            }
            i += 1;
            continue;
        }
        if b == b'"' {
            in_string = true;
            out.push(b);
            i += 1;
            continue;
        }
        if b == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'/' {
            out.push(b' ');
            out.push(b' ');
            i += 2;
            while i < bytes.len() && bytes[i] != b'\n' {
                out.push(b' ');
                i += 1;
            }
            continue;
        }
        if b == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'*' {
            out.push(b' ');
            out.push(b' ');
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                out.push(if bytes[i] == b'\n' { b'\n' } else { b' ' });
                i += 1;
            }
            if i + 1 < bytes.len() {
                out.push(b' ');
                out.push(b' ');
                i += 2;
            }
            continue;
        }
        out.push(b);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn parse_json_file(text: &str) -> Option<Value> {
    serde_json::from_str(text)
        .ok()
        .or_else(|| serde_json::from_str(&strip_json_comments(text)).ok())
        .or_else(|| {
            serde_json::from_str(&strip_json_trailing_commas(&strip_json_comments(text))).ok()
        })
}

/// Remove `,}`/`,]` trailing commas so JSONC files still parse. Only used for
/// reads — positions need not be preserved.
fn strip_json_trailing_commas(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut drop_positions: HashSet<usize> = HashSet::new();
    let mut i = 0;
    let mut in_string = false;
    let mut last_comma: Option<usize> = None;
    while i < bytes.len() {
        let b = bytes[i];
        if in_string {
            if b == b'\\' {
                i += 2;
                continue;
            }
            if b == b'"' {
                in_string = false;
            }
            i += 1;
            continue;
        }
        match b {
            b'"' => in_string = true,
            b',' => last_comma = Some(i),
            b'}' | b']' => {
                if let Some(pos) = last_comma.take() {
                    drop_positions.insert(pos);
                }
            }
            b' ' | b'\t' | b'\n' | b'\r' => {}
            _ => last_comma = None,
        }
        i += 1;
    }
    if drop_positions.is_empty() {
        return text.to_string();
    }
    let mut out = Vec::with_capacity(text.len());
    for (i, b) in bytes.iter().enumerate() {
        if !drop_positions.contains(&i) {
            out.push(*b);
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum JTok {
    Open,
    Close,
    ArrOpen,
    ArrClose,
    Colon,
    Comma,
    Str,
    Scalar,
}

#[derive(Clone, Copy, Debug)]
struct JSpan {
    tok: JTok,
    start: usize,
    end: usize,
}

/// Tokenize JSON(C): strings, scalars and structural chars, skipping
/// whitespace and comments. Positions are byte offsets into `text`.
fn json_spans(text: &str) -> Result<Vec<JSpan>, String> {
    let bytes = text.as_bytes();
    let mut spans = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        match b {
            b' ' | b'\t' | b'\n' | b'\r' => i += 1,
            b'/' if i + 1 < bytes.len() && bytes[i + 1] == b'/' => {
                while i < bytes.len() && bytes[i] != b'\n' {
                    i += 1;
                }
            }
            b'/' if i + 1 < bytes.len() && bytes[i + 1] == b'*' => {
                i += 2;
                while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                    i += 1;
                }
                i = (i + 2).min(bytes.len());
            }
            b'"' => {
                let start = i;
                i += 1;
                while i < bytes.len() {
                    if bytes[i] == b'\\' {
                        i += 2;
                        continue;
                    }
                    if bytes[i] == b'"' {
                        i += 1;
                        break;
                    }
                    i += 1;
                }
                spans.push(JSpan {
                    tok: JTok::Str,
                    start,
                    end: i,
                });
            }
            b'{' => {
                spans.push(JSpan {
                    tok: JTok::Open,
                    start: i,
                    end: i + 1,
                });
                i += 1;
            }
            b'}' => {
                spans.push(JSpan {
                    tok: JTok::Close,
                    start: i,
                    end: i + 1,
                });
                i += 1;
            }
            b'[' => {
                spans.push(JSpan {
                    tok: JTok::ArrOpen,
                    start: i,
                    end: i + 1,
                });
                i += 1;
            }
            b']' => {
                spans.push(JSpan {
                    tok: JTok::ArrClose,
                    start: i,
                    end: i + 1,
                });
                i += 1;
            }
            b':' => {
                spans.push(JSpan {
                    tok: JTok::Colon,
                    start: i,
                    end: i + 1,
                });
                i += 1;
            }
            b',' => {
                spans.push(JSpan {
                    tok: JTok::Comma,
                    start: i,
                    end: i + 1,
                });
                i += 1;
            }
            _ => {
                let start = i;
                while i < bytes.len()
                    && !matches!(
                        bytes[i],
                        b',' | b'}' | b']' | b' ' | b'\t' | b'\n' | b'\r' | b'/'
                    )
                {
                    i += 1;
                }
                if i == start {
                    i += 1; // a lone `/` — still consume one byte
                }
                spans.push(JSpan {
                    tok: JTok::Scalar,
                    start,
                    end: i,
                });
            }
        }
    }
    Ok(spans)
}

fn span_string<'a>(text: &'a str, span: &JSpan) -> &'a str {
    &text[span.start..span.end]
}

fn unquote_json(text: &str, span: &JSpan) -> Option<String> {
    serde_json::from_str::<String>(span_string(text, span)).ok()
}

/// Token index of the `{` that opens the object addressed by `path` (empty
/// path = the root object).
fn json_object_open(text: &str, spans: &[JSpan], path: &[String]) -> Option<usize> {
    let mut i = spans.iter().position(|s| s.tok == JTok::Open)?;
    for segment in path {
        // Members of the object whose `{` is at token index i.
        let mut depth = 0usize;
        let mut j = i + 1;
        let mut found = None;
        while j < spans.len() {
            match spans[j].tok {
                JTok::Open | JTok::ArrOpen => depth += 1,
                JTok::Close | JTok::ArrClose => {
                    if depth == 0 {
                        break;
                    }
                    depth -= 1;
                }
                JTok::Str
                    if depth == 0
                        && j + 1 < spans.len()
                        && spans[j + 1].tok == JTok::Colon
                        && unquote_json(text, &spans[j]).as_deref() == Some(segment.as_str()) =>
                {
                    found = Some(j + 2);
                    break;
                }
                _ => {}
            }
            j += 1;
        }
        let value_idx = found?;
        if spans.get(value_idx).map(|s| s.tok) != Some(JTok::Open) {
            return None;
        }
        i = value_idx;
    }
    Some(i)
}

/// Insert `"member": <literal>` just after the `{` at token `open_idx`,
/// reusing the existing member indentation when the object spans lines.
fn insert_json_member(
    text: &str,
    spans: &[JSpan],
    open_idx: usize,
    member: &str,
    literal: &str,
) -> String {
    let insert_at = spans[open_idx].end;
    let next = spans.get(open_idx + 1);
    let needs_comma = next.map(|s| s.tok != JTok::Close).unwrap_or(false);
    let key = serde_json::to_string(member).unwrap_or_else(|_| "\"?\"".into());
    let entry = format!("{key}: {literal}");
    let after = &text[insert_at..];
    let ws_run: String = after.chars().take_while(|c| c.is_whitespace()).collect();
    let inserted = if let Some(pos) = ws_run.rfind('\n') {
        let indent = &ws_run[pos + 1..];
        format!("\n{indent}{entry}{}", if needs_comma { "," } else { "" })
    } else if needs_comma {
        format!("{entry}, ")
    } else {
        format!(" {entry} ")
    };
    format!("{}{}{}", &text[..insert_at], inserted, after)
}

/// Set `member` inside the object at `path` to a boolean, in place. Missing
/// intermediate objects are created one segment at a time.
fn set_json_bool(text: &str, path: &[String], member: &str, value: bool) -> Result<String, String> {
    let mut text = if text.trim().is_empty() {
        "{}".to_string()
    } else {
        text.to_string()
    };
    for depth in 1..=path.len() {
        let spans = json_spans(&text).map_err(|e| format!("Cannot parse {e}"))?;
        if json_object_open(&text, &spans, &path[..depth]).is_some() {
            continue;
        }
        let parent = json_object_open(&text, &spans, &path[..depth - 1])
            .ok_or("Config file root is not an object")?;
        text = insert_json_member(&text, &spans, parent, &path[depth - 1], "{}");
    }
    let spans = json_spans(&text).map_err(|e| format!("Cannot parse {e}"))?;
    let open_idx =
        json_object_open(&text, &spans, path).ok_or("Config section not found in file")?;

    // Look for the member at this object's top level.
    let mut depth = 0usize;
    let mut j = open_idx + 1;
    while j < spans.len() {
        match spans[j].tok {
            JTok::Open | JTok::ArrOpen => depth += 1,
            JTok::Close | JTok::ArrClose => {
                if depth == 0 {
                    break;
                }
                depth -= 1;
            }
            JTok::Str
                if depth == 0
                    && j + 2 < spans.len()
                    && spans[j + 1].tok == JTok::Colon
                    && unquote_json(&text, &spans[j]).as_deref() == Some(member) =>
            {
                let value_span = spans[j + 2];
                if !matches!(value_span.tok, JTok::Scalar | JTok::Str) {
                    return Err("The existing value is not a simple flag".into());
                }
                let literal = if value { "true" } else { "false" };
                return Ok(format!(
                    "{}{}{}",
                    &text[..value_span.start],
                    literal,
                    &text[value_span.end..]
                ));
            }
            _ => {}
        }
        j += 1;
    }

    let literal = if value { "true" } else { "false" };
    Ok(insert_json_member(&text, &spans, open_idx, member, literal))
}

/// Token index of the value addressed by `path`, descending objects by member
/// name and arrays by numeric index. Empty path = the root value.
fn json_value_idx(text: &str, spans: &[JSpan], path: &[String]) -> Option<usize> {
    let mut idx = spans
        .iter()
        .position(|s| matches!(s.tok, JTok::Open | JTok::ArrOpen))?;
    for segment in path {
        let Some(&span) = spans.get(idx) else {
            // Truncated input like `{"a":` — the member exists but has no
            // value token, so there is nothing to descend into.
            return None;
        };
        match span.tok {
            JTok::Open => {
                let mut depth = 0usize;
                let mut j = idx + 1;
                let mut found = None;
                while j < spans.len() {
                    match spans[j].tok {
                        JTok::Open | JTok::ArrOpen => depth += 1,
                        JTok::Close | JTok::ArrClose => {
                            if depth == 0 {
                                break;
                            }
                            depth -= 1;
                        }
                        JTok::Str
                            if depth == 0
                                && spans.get(j + 1).map(|s| s.tok) == Some(JTok::Colon)
                                && unquote_json(text, &spans[j]).as_deref()
                                    == Some(segment.as_str()) =>
                        {
                            found = Some(j + 2);
                            break;
                        }
                        _ => {}
                    }
                    j += 1;
                }
                idx = found?;
            }
            JTok::ArrOpen => {
                let target: usize = segment.parse().ok()?;
                let mut depth = 0usize;
                let mut j = idx + 1;
                let mut seen = 0usize;
                let mut found = None;
                while j < spans.len() {
                    match spans[j].tok {
                        JTok::Open | JTok::ArrOpen => {
                            if depth == 0 {
                                if seen == target {
                                    found = Some(j);
                                    break;
                                }
                                seen += 1;
                            }
                            depth += 1;
                        }
                        JTok::Close | JTok::ArrClose => {
                            if depth == 0 {
                                break;
                            }
                            depth -= 1;
                        }
                        JTok::Comma if depth == 0 => {}
                        _ if depth == 0 => {
                            if seen == target {
                                found = Some(j);
                                break;
                            }
                            seen += 1;
                        }
                        _ => {}
                    }
                    j += 1;
                }
                idx = found?;
            }
            _ => return None,
        }
    }
    // A truncated `"key":` yields idx == spans.len() — never hand that back
    // to callers that index spans directly.
    if idx >= spans.len() {
        return None;
    }
    Some(idx)
}

/// Token index just past the value starting at token `idx`.
fn json_value_end(spans: &[JSpan], idx: usize) -> Option<usize> {
    match spans.get(idx)?.tok {
        JTok::Open | JTok::ArrOpen => {
            let mut depth = 0usize;
            for (j, s) in spans.iter().enumerate().skip(idx) {
                match s.tok {
                    JTok::Open | JTok::ArrOpen => depth += 1,
                    JTok::Close | JTok::ArrClose => {
                        depth -= 1;
                        if depth == 0 {
                            return Some(j + 1);
                        }
                    }
                    _ => {}
                }
            }
            None
        }
        _ => Some(idx + 1),
    }
}

/// Token range (lo..hi) of the element addressed by the last path segment:
/// `"key": value` for objects, the element for arrays.
fn json_element_tokens(text: &str, spans: &[JSpan], path: &[String]) -> Option<(usize, usize)> {
    let (last, parent_path) = path.split_last()?;
    let parent = json_value_idx(text, spans, parent_path)?;
    match spans[parent].tok {
        JTok::Open => {
            let mut depth = 0usize;
            let mut j = parent + 1;
            while j < spans.len() {
                match spans[j].tok {
                    JTok::Open | JTok::ArrOpen => depth += 1,
                    JTok::Close | JTok::ArrClose => {
                        if depth == 0 {
                            break;
                        }
                        depth -= 1;
                    }
                    JTok::Str
                        if depth == 0
                            && spans.get(j + 1).map(|s| s.tok) == Some(JTok::Colon)
                            && unquote_json(text, &spans[j]).as_deref() == Some(last.as_str()) =>
                    {
                        return Some((j, json_value_end(spans, j + 2)?));
                    }
                    _ => {}
                }
                j += 1;
            }
            None
        }
        JTok::ArrOpen => {
            let target: usize = last.parse().ok()?;
            let mut depth = 0usize;
            let mut j = parent + 1;
            let mut seen = 0usize;
            while j < spans.len() {
                match spans[j].tok {
                    JTok::Open | JTok::ArrOpen => {
                        if depth == 0 && seen == target {
                            return Some((j, json_value_end(spans, j)?));
                        }
                        depth += 1;
                        if depth == 1 {
                            seen += 1;
                        }
                    }
                    JTok::Close | JTok::ArrClose => {
                        if depth == 0 {
                            break;
                        }
                        depth -= 1;
                    }
                    JTok::Comma if depth == 0 => {}
                    _ if depth == 0 => {
                        if seen == target {
                            return Some((j, j + 1));
                        }
                        seen += 1;
                    }
                    _ => {}
                }
                j += 1;
            }
            None
        }
        _ => None,
    }
}

/// Cut the byte range covering the element, plus one comma and the newline a
/// full-line element leaves behind.
fn json_cut(text: &str, spans: &[JSpan], lo: usize, hi: usize) -> String {
    let start = spans[lo].start;
    let mut end = spans[hi - 1].end;
    if spans.get(hi).map(|s| s.tok) == Some(JTok::Comma) {
        end = spans[hi].end;
        // Swallow the line ending a full-line element leaves behind.
        if text.as_bytes().get(end) == Some(&b'\r') && text.as_bytes().get(end + 1) == Some(&b'\n')
        {
            end += 2;
        } else if text.as_bytes().get(end) == Some(&b'\n') {
            end += 1;
        }
    } else if lo > 0 && spans[lo - 1].tok == JTok::Comma {
        // Cut the preceding comma as a separate range so a `//` comment
        // between it and this element survives.
        let comma = spans[lo - 1];
        return format!(
            "{}{}{}",
            &text[..comma.start],
            &text[comma.end..start],
            &text[end..]
        );
    }
    format!("{}{}", &text[..start], &text[end..])
}

/// Remove the member or array element at `path` (numeric segments index into
/// arrays), preserving JSONC comments and formatting. When `expect` is set the
/// element must still match it — a `command`/`prompt` member for objects, or
/// the scalar itself — so a ref captured by an older scan cannot cut the wrong
/// entry after the file changed underneath.
fn remove_json_at(text: &str, path: &[String], expect: Option<&str>) -> Result<String, String> {
    let spans = json_spans(text).map_err(|e| format!("Cannot parse {e}"))?;
    let (lo, hi) =
        json_element_tokens(text, &spans, path).ok_or("Entry not found in config file")?;
    if let Some(expect) = expect {
        let mut matches = false;
        for s in &spans[lo..hi] {
            if s.tok != JTok::Str {
                continue;
            }
            let value = unquote_json(text, s).unwrap_or_default();
            if value == expect {
                matches = true;
                break;
            }
        }
        if !matches {
            return Err("Config changed since the last scan — refresh and retry".into());
        }
    }
    Ok(json_cut(text, &spans, lo, hi))
}

/// Remove the element of the array at `path` matching `item` — a string
/// (ignoring a leading `-` disable marker), or `{package|name: item}`.
fn remove_json_array_item(text: &str, path: &[String], item: &str) -> Result<String, String> {
    let spans = json_spans(text).map_err(|e| format!("Cannot parse {e}"))?;
    let arr = json_value_idx(text, &spans, path).ok_or("Config section not found")?;
    if spans[arr].tok != JTok::ArrOpen {
        return Err("Config section is not a list".into());
    }
    let mut j = arr + 1;
    while j < spans.len() {
        let s = spans[j];
        match s.tok {
            // Composite elements are matched wholesale then skipped.
            JTok::Open | JTok::ArrOpen => {
                let end = json_value_end(&spans, j).ok_or("Unbalanced array")?;
                if s.tok == JTok::Open {
                    // Object element: match its package/name member.
                    let mut d = 0usize;
                    let mut k = j + 1;
                    while k < end {
                        match spans[k].tok {
                            JTok::Open | JTok::ArrOpen => d += 1,
                            JTok::Close | JTok::ArrClose => {
                                if d == 0 {
                                    break;
                                }
                                d -= 1;
                            }
                            JTok::Str
                                if d == 0
                                    && spans.get(k + 1).map(|t| t.tok) == Some(JTok::Colon)
                                    && matches!(
                                        unquote_json(text, &spans[k]).as_deref(),
                                        Some("package") | Some("name")
                                    )
                                    && unquote_json(text, &spans[k + 2]).as_deref()
                                        == Some(item) =>
                            {
                                return Ok(json_cut(text, &spans, j, end));
                            }
                            _ => {}
                        }
                        k += 1;
                    }
                }
                j = end;
                continue;
            }
            JTok::Close | JTok::ArrClose => break,
            JTok::Comma => {}
            _ => {
                let matches_item = if s.tok == JTok::Str {
                    unquote_json(text, &s)
                        .map(|v| v.trim_start_matches('-') == item)
                        .unwrap_or(false)
                } else {
                    span_string(text, &s).trim_start_matches('-') == item
                };
                if matches_item {
                    return Ok(json_cut(text, &spans, j, j + 1));
                }
            }
        }
        j += 1;
    }
    Err("Entry not found in config list".into())
}

// ---------------------------------------------------------------------------
// TOML: line-oriented table scan + in-place boolean set. Enough for
// `[mcp_servers.*]`, `[plugins.*]`, `[marketplaces.*]` — not a general parser.

#[derive(Debug)]
struct TomlTable {
    path: Vec<String>,
    /// Byte offset where the header line starts.
    start: usize,
    /// Byte offset just past the header line's newline.
    body_start: usize,
    /// Byte offset of the next header (or EOF).
    end: usize,
}

fn parse_toml_header(line: &str) -> Option<Vec<String>> {
    let rest = line.trim_start().strip_prefix('[')?;
    // Array-of-tables [[x]] share the same path parse; the leading bracket is
    // consumed by the closing-bracket scan below.
    let rest = rest.strip_prefix('[').unwrap_or(rest);
    // Find the `]` that closes the header, ignoring quoted segments.
    let bytes = rest.as_bytes();
    let mut i = 0;
    let mut quote = 0u8;
    let mut close = None;
    while i < bytes.len() {
        let b = bytes[i];
        if quote != 0 {
            if quote == b'"' && b == b'\\' {
                i += 2;
                continue;
            }
            if b == quote {
                quote = 0;
            }
        } else if b == b'"' || b == b'\'' {
            quote = b;
        } else if b == b']' {
            close = Some(i);
            break;
        } else if b == b'#' {
            return None; // `#` before `]` — not a header
        }
        i += 1;
    }
    let close = close?;
    let inner = &rest[..close];
    // After the header's `]` (or `]]`) only whitespace or a comment may follow.
    let tail = &rest[close + 1..];
    let tail = tail.strip_prefix(']').unwrap_or(tail).trim();
    if !tail.is_empty() && !tail.starts_with('#') {
        return None;
    }
    let mut parts = Vec::new();
    let bytes = inner.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        while i < bytes.len() && (bytes[i] == b'.' || bytes[i] == b' ') {
            i += 1;
        }
        if i >= bytes.len() {
            break;
        }
        if bytes[i] == b'"' || bytes[i] == b'\'' {
            let quote = bytes[i];
            i += 1;
            let start = i;
            while i < bytes.len() && bytes[i] != quote {
                i += 1;
            }
            parts.push(inner[start..i].to_string());
            i += 1; // closing quote (or end)
        } else {
            let start = i;
            while i < bytes.len() && bytes[i] != b'.' {
                i += 1;
            }
            parts.push(inner[start..i].trim().to_string());
        }
    }
    if parts.iter().any(|p| p.is_empty()) {
        return None;
    }
    Some(parts)
}

/// Advance multiline-string (`"""`/`'''`) state across one TOML line so
/// key/header-looking text inside a multiline literal is not misread.
fn toml_multiline_next(line: &str, mut open: Option<u8>) -> Option<u8> {
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        match open {
            Some(q) => {
                if b == q && bytes.get(i + 1) == Some(&q) && bytes.get(i + 2) == Some(&q) {
                    open = None;
                    i += 3;
                } else {
                    i += 1;
                }
            }
            None => {
                if b == b'#' {
                    break;
                }
                if b == b'"' || b == b'\'' {
                    if bytes.get(i + 1) == Some(&b) && bytes.get(i + 2) == Some(&b) {
                        open = Some(b);
                        i += 3;
                    } else {
                        i += 1;
                        while i < bytes.len() && bytes[i] != b {
                            if b == b'"' && bytes[i] == b'\\' {
                                i += 1;
                            }
                            i += 1;
                        }
                        i += 1;
                    }
                } else {
                    i += 1;
                }
            }
        }
    }
    open
}

/// Net `[`/`]` balance of a line, skipping quoted strings and `#` comments.
/// Used to keep table-header detection out of multiline array values.
fn toml_bracket_delta(line: &str) -> i32 {
    let mut depth = 0i32;
    let mut quote = 0u8;
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if quote != 0 {
            if quote == b'"' && b == b'\\' {
                i += 2;
                continue;
            }
            if b == quote {
                quote = 0;
            }
            i += 1;
            continue;
        }
        match b {
            b'#' => break,
            b'"' | b'\'' => quote = b,
            b'[' => depth += 1,
            b']' => depth -= 1,
            _ => {}
        }
        i += 1;
    }
    depth
}

fn toml_tables(text: &str) -> Vec<TomlTable> {
    let mut tables = Vec::new();
    let mut offset = 0usize;
    let mut in_multiline: Option<u8> = None;
    // >0 while a member value is an unterminated multiline array — a line
    // like `["y"]` inside one must never parse as a table header.
    let mut array_depth = 0i32;
    for line in text.split_inclusive('\n') {
        let line_start = offset;
        offset += line.len();
        let inside = in_multiline.is_some() || array_depth > 0;
        let string_before = in_multiline;
        in_multiline = toml_multiline_next(line, in_multiline);
        if string_before.is_none() && in_multiline.is_none() {
            array_depth = (array_depth + toml_bracket_delta(line)).max(0);
        }
        if inside {
            continue;
        }
        if let Some(path) = parse_toml_header(line.trim_end_matches(['\n', '\r'])) {
            if let Some(last) = tables.last_mut() {
                let last: &mut TomlTable = last;
                last.end = line_start;
            }
            tables.push(TomlTable {
                path,
                start: line_start,
                body_start: offset,
                end: text.len(),
            });
        }
    }
    tables
}

fn toml_table<'a>(tables: &'a [TomlTable], path: &[String]) -> Option<&'a TomlTable> {
    tables.iter().find(|t| t.path == path)
}

/// Raw (trimmed) value text for `key` inside a table body. Multi-line arrays
/// are joined with spaces.
fn toml_get(body: &str, key: &str) -> Option<String> {
    let mut offset = 0usize;
    let mut in_multiline: Option<u8> = None;
    for line in body.split_inclusive('\n') {
        let line_start = offset;
        offset += line.len();
        let inside = in_multiline.is_some();
        in_multiline = toml_multiline_next(line, in_multiline);
        if inside {
            continue;
        }
        let trimmed = line.trim_start();
        if trimmed.starts_with('#') {
            continue;
        }
        if let Some(eq) = find_toml_eq(trimmed) {
            let name = trimmed[..eq].trim().trim_matches('"').trim_matches('\'');
            if name == key {
                let eq_abs = line_start + (line.len() - trimmed.len()) + eq;
                let value_part = body[eq_abs + 1..].trim_start();
                let first_nl = value_part.find('\n').unwrap_or(value_part.len());
                let multiline = !toml_brackets_balanced(&value_part[..first_nl]);
                if value_part.starts_with('[') && multiline {
                    // Multi-line array: accumulate until brackets balance.
                    let mut collected = String::new();
                    for extra in body[eq_abs + 1..].split_inclusive('\n') {
                        collected.push_str(extra);
                        if toml_brackets_balanced(&collected) {
                            break;
                        }
                    }
                    return Some(
                        collected
                            .split('\n')
                            .map(str::trim)
                            .collect::<Vec<_>>()
                            .join(" "),
                    );
                }
                let newline = value_part.find('\n').unwrap_or(value_part.len());
                let end = toml_comment_pos(&value_part[..newline]).unwrap_or(newline);
                return Some(
                    value_part[..end]
                        .trim_end_matches(['\r', ' ', '\t'])
                        .to_string(),
                );
            }
        }
    }
    None
}

fn find_toml_eq(line: &str) -> Option<usize> {
    let bytes = line.as_bytes();
    let mut i = 0;
    let mut quote = 0u8;
    while i < bytes.len() {
        let b = bytes[i];
        if quote != 0 {
            if b == quote {
                quote = 0;
            }
        } else if b == b'"' || b == b'\'' {
            quote = b;
        } else if b == b'=' {
            return Some(i);
        }
        i += 1;
    }
    None
}

fn toml_brackets_balanced(value: &str) -> bool {
    let mut depth = 0i32;
    let mut quote = 0u8;
    let mut i = 0;
    let bytes = value.as_bytes();
    while i < bytes.len() {
        let b = bytes[i];
        if quote != 0 {
            if quote == b'"' && b == b'\\' {
                i += 2;
                continue;
            }
            if b == quote {
                quote = 0;
            }
            i += 1;
            continue;
        }
        match b {
            b'"' | b'\'' => quote = b,
            b'[' => depth += 1,
            b']' => depth -= 1,
            _ => {}
        }
        i += 1;
    }
    depth <= 0
}

fn toml_bool_value(body: &str, key: &str) -> Option<bool> {
    toml_get(body, key).map(|v| v.trim_start() == "true")
}

/// Byte offset of a `#` comment outside quoted strings, if any.
fn toml_comment_pos(value: &str) -> Option<usize> {
    let bytes = value.as_bytes();
    let mut i = 0;
    let mut quote = 0u8;
    while i < bytes.len() {
        let b = bytes[i];
        if quote != 0 {
            if quote == b'"' && b == b'\\' {
                i += 2;
                continue;
            }
            if b == quote {
                quote = 0;
            }
        } else if b == b'"' || b == b'\'' {
            quote = b;
        } else if b == b'#' {
            return Some(i);
        }
        i += 1;
    }
    None
}

fn set_toml_bool(text: &str, path: &[String], member: &str, value: bool) -> Result<String, String> {
    let tables = toml_tables(text);
    let table = toml_table(&tables, path).ok_or("Config table not found in file")?;
    let body = &text[table.body_start..table.end];
    let literal = if value { "true" } else { "false" };
    let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };

    let mut offset = table.body_start;
    let mut in_multiline: Option<u8> = None;
    for line in body.split_inclusive('\n') {
        let line_start = offset;
        offset += line.len();
        let inside = in_multiline.is_some();
        in_multiline = toml_multiline_next(line, in_multiline);
        if inside {
            continue;
        }
        let trimmed = line.trim_start();
        if trimmed.starts_with('#') {
            continue;
        }
        if let Some(eq) = find_toml_eq(trimmed) {
            let name = trimmed[..eq].trim().trim_matches('"').trim_matches('\'');
            if name == member {
                let eq_abs = line_start + (line.len() - trimmed.len()) + eq;
                let after_eq = &text[eq_abs + 1..line_start + line.len()];
                // Keep the original line ending — `line` already consumed it.
                let newline = after_eq.find('\n').unwrap_or(after_eq.len());
                let eol_start = if newline > 0 && after_eq.as_bytes()[newline - 1] == b'\r' {
                    newline - 1
                } else {
                    newline
                };
                let mut replacement = format!(" {literal}");
                if let Some(c) = toml_comment_pos(&after_eq[..eol_start]) {
                    let trailing = after_eq[c..eol_start].trim_end();
                    if !trailing.is_empty() {
                        replacement.push(' ');
                        replacement.push_str(trailing);
                    }
                }
                replacement.push_str(&after_eq[eol_start..]);
                return Ok(format!(
                    "{}{}{}",
                    &text[..eq_abs + 1],
                    replacement,
                    &text[line_start + line.len()..]
                ));
            }
        }
    }

    // Member absent: insert right after the header line, matching the file's
    // line-ending style and terminating the header first when it lacks one.
    let mut prefix = text[..table.body_start].to_string();
    if !prefix.ends_with('\n') {
        prefix.push_str(eol);
    }
    Ok(format!(
        "{prefix}{member} = {literal}{eol}{}",
        &text[table.body_start..]
    ))
}

/// Length of the TOML value starting at `value`'s first byte — through the
/// balancing `]` for arrays, else the first `#` comment or newline.
fn toml_value_len(value: &str) -> usize {
    if value.starts_with('[') {
        let mut depth = 0i32;
        let mut quote = 0u8;
        let bytes = value.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            let b = bytes[i];
            if quote != 0 {
                if quote == b'"' && b == b'\\' {
                    i += 2;
                    continue;
                }
                if b == quote {
                    quote = 0;
                }
                i += 1;
                continue;
            }
            match b {
                b'"' | b'\'' => quote = b,
                b'[' => depth += 1,
                b']' => {
                    depth -= 1;
                    if depth == 0 {
                        return i + 1;
                    }
                }
                _ => {}
            }
            i += 1;
        }
        return value.len();
    }
    let nl = value.find('\n').unwrap_or(value.len());
    toml_comment_pos(&value[..nl]).unwrap_or(nl)
}

/// Byte ranges of member `key` inside `body`: (member line start, member end
/// past the trailing newline, value start, value end).
fn toml_member_span(body: &str, key: &str) -> Option<(usize, usize, usize, usize)> {
    let mut offset = 0usize;
    let mut in_multiline: Option<u8> = None;
    for line in body.split_inclusive('\n') {
        let line_start = offset;
        offset += line.len();
        let inside = in_multiline.is_some();
        in_multiline = toml_multiline_next(line, in_multiline);
        if inside {
            continue;
        }
        let trimmed = line.trim_start();
        if trimmed.starts_with('#') {
            continue;
        }
        if let Some(eq) = find_toml_eq(trimmed) {
            let name = trimmed[..eq].trim().trim_matches('"').trim_matches('\'');
            if name == key {
                let eq_abs = line_start + (line.len() - trimmed.len()) + eq;
                let after_eq = &body[eq_abs + 1..];
                let value_start = eq_abs + 1 + (after_eq.len() - after_eq.trim_start().len());
                let value_end = value_start + toml_value_len(after_eq.trim_start());
                let member_end = body[value_end..]
                    .find('\n')
                    .map(|n| value_end + n + 1)
                    .unwrap_or(body.len());
                return Some((line_start, member_end, value_start, value_end));
            }
        }
    }
    None
}

/// Drop one element from a TOML array's text, keeping brackets and commas
/// balanced. `value` is the raw value (may span lines); anything that is not
/// an array is refused — cutting a string out of `key = "x"` would leave an
/// invalid bare `key =`.
fn toml_list_remove(value: &str, item: &str) -> Option<String> {
    if !value.trim_start().starts_with('[') {
        return None;
    }
    let bytes = value.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'"' && bytes[i] != b'\'' {
            i += 1;
            continue;
        }
        let quote = bytes[i];
        let start = i;
        i += 1;
        while i < bytes.len() {
            if quote == b'"' && bytes[i] == b'\\' {
                i += 2;
                continue;
            }
            if bytes[i] == quote {
                break;
            }
            i += 1;
        }
        let end = (i + 1).min(bytes.len());
        if unquote_toml_string(&value[start..end]) == item {
            // Cut the element plus one adjacent comma.
            let mut cut_start = start;
            let mut cut_end = end;
            let mut j = end;
            while j < bytes.len() && matches!(bytes[j], b' ' | b'\t' | b'\r') {
                j += 1;
            }
            if j < bytes.len() && bytes[j] == b',' {
                cut_end = j + 1;
                // Swallow the newline a full-line element leaves behind.
                if bytes.get(cut_end) == Some(&b'\n') {
                    cut_end += 1;
                }
            } else {
                let mut k = start;
                while k > 0 && matches!(bytes[k - 1], b' ' | b'\t' | b'\r' | b'\n') {
                    k -= 1;
                }
                if k > 0 && bytes[k - 1] == b',' {
                    cut_start = k - 1;
                }
            }
            return Some(format!("{}{}", &value[..cut_start], &value[cut_end..]));
        }
        i = end;
    }
    None
}

/// Remove a TOML table block or member. With `array_item`, either selects the
/// `[[table]]` whose `name`/`command` matches, or removes one element of a
/// `key = [...]` member.
fn remove_toml(text: &str, path: &[String], array_item: Option<&str>) -> Result<String, String> {
    let tables = toml_tables(text);
    let matching: Vec<&TomlTable> = tables.iter().filter(|t| t.path == path).collect();
    if !matching.is_empty() {
        // A single match is still verified against `array_item` when given —
        // a ref captured by an older scan must not cut a different block.
        let matches_needle = |t: &TomlTable, needle: &str| {
            let body = &text[t.body_start..t.end];
            ["name", "command", "prompt"].iter().any(|k| {
                toml_get(body, k)
                    .map(|v| unquote_toml_string(&v) == needle)
                    .unwrap_or(false)
            })
        };
        let target = if matching.len() == 1 {
            let only = matching[0];
            if let Some(needle) = array_item {
                if !matches_needle(only, needle) {
                    return Err("Config changed since the last scan — refresh and retry".into());
                }
            }
            only
        } else {
            let needle = array_item.ok_or("Entry is ambiguous")?;
            matching
                .iter()
                .copied()
                .find(|t| matches_needle(t, needle))
                .ok_or("Entry not found in config file")?
        };
        // Extend the cut over contiguous sub-tables — removing
        // `[mcp_servers.x]` must also drop `[mcp_servers.x.env]`, otherwise
        // the env block silently keeps the server (and its secrets) alive.
        // Same-path `[[siblings]]` are untouched: descendants are strictly
        // longer paths.
        let mut end = target.end;
        while let Some(next) = tables
            .iter()
            .find(|t| t.start == end && t.path.len() > path.len() && t.path.starts_with(path))
        {
            end = next.end;
        }
        return Ok(format!("{}{}", &text[..target.start], &text[end..]));
    }
    let key = path.last().ok_or("Invalid config path")?;
    let parent = &path[..path.len() - 1];
    let (body_start, body_end) = if parent.is_empty() {
        (0, tables.first().map(|t| t.start).unwrap_or(text.len()))
    } else {
        let table = toml_table(&tables, parent).ok_or("Config section not found")?;
        (table.body_start, table.end)
    };
    let body = &text[body_start..body_end];
    let (ms, me, vs, ve) = toml_member_span(body, key).ok_or("Entry not found in config file")?;
    if let Some(item) = array_item {
        let new_value = toml_list_remove(&body[vs..ve], item).ok_or("Entry not found in list")?;
        return Ok(format!(
            "{}{}{}",
            &text[..body_start + vs],
            new_value,
            &text[body_start + ve..]
        ));
    }
    Ok(format!(
        "{}{}",
        &text[..body_start + ms],
        &text[body_start + me..]
    ))
}

fn unquote_toml_string(value: &str) -> String {
    let v = value.trim();
    if v.len() >= 2
        && ((v.starts_with('"') && v.ends_with('"')) || (v.starts_with('\'') && v.ends_with('\'')))
    {
        return v[1..v.len() - 1].to_string();
    }
    v.to_string()
}

fn toml_string_list(value: &str) -> Vec<String> {
    let mut out = Vec::new();
    let bytes = value.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'"' || bytes[i] == b'\'' {
            let quote = bytes[i];
            i += 1;
            let start = i;
            while i < bytes.len() && bytes[i] != quote {
                i += 1;
            }
            out.push(value[start..i].to_string());
            i += 1;
        } else {
            i += 1;
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Inventory

#[tauri::command(async)]
pub fn agent_config_inventory(cwd: String) -> Result<AgentConfigInventory, String> {
    let project = expand_home(&cwd);
    let home = home_for(&project);

    let project_native = match wsl::path_location(&project) {
        Ok(Some(location)) => location.path,
        _ => crate::fs::path_to_js(&project),
    };
    let mut inventory = AgentConfigInventory::default();
    let ctx = Ctx {
        project: project.clone(),
        home: home.clone(),
        project_native,
        wsl_project: matches!(wsl::path_location(&project), Ok(Some(_))),
    };

    inventory.providers.push(claude_extensions(&ctx));
    inventory.providers.push(codex_family_extensions(
        &ctx,
        "codex",
        "CODEX_HOME",
        ".codex",
        &["config.toml", "hooks.json"],
    ));
    inventory.providers.push(cursor_extensions(&ctx));
    inventory.providers.push(codex_family_extensions(
        &ctx,
        "grok",
        "GROK_HOME",
        ".grok",
        &["config.toml"],
    ));
    inventory.providers.push(opencode_extensions(&ctx));
    inventory
        .providers
        .push(pi_family_extensions(&ctx, "pi", ".pi"));
    inventory
        .providers
        .push(pi_family_extensions(&ctx, "omp", ".omp"));
    inventory.providers.push(fx_extensions(&ctx));
    inventory.providers.push(devin_extensions(&ctx));
    inventory.providers.push(copilot_extensions(&ctx));
    inventory.providers.push(muse_extensions(&ctx));

    // A provider with config files on disk counts as detected even when no
    // dedicated marker dir was found.
    for provider in &mut inventory.providers {
        provider.detected |= !provider.files.is_empty();
    }

    inventory.instructions = discover_instructions(&ctx);
    resolve_hook_refs(&mut inventory, &project, home.as_deref());
    Ok(inventory)
}

struct Ctx {
    project: PathBuf,
    home: Option<PathBuf>,
    /// Native path the agent CLIs see (Linux path for WSL projects).
    project_native: String,
    /// Host env vars (e.g. $CODEX_HOME) don't apply inside a WSL guest.
    wsl_project: bool,
}

impl Ctx {
    fn home_join(&self, rel: &str) -> Option<PathBuf> {
        self.home.as_ref().map(|h| h.join(rel))
    }
    fn project_join(&self, rel: &str) -> PathBuf {
        self.project.join(rel)
    }
}

fn file_kind(path: &Path) -> &'static str {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if name.contains("mcp") {
        "mcp"
    } else if name.contains("hook") {
        "hooks"
    } else if name.contains("plugin") {
        "plugins"
    } else if name.contains("settings") {
        "settings"
    } else {
        "config"
    }
}

fn existing_file(
    ctx_files: &mut Vec<ConfigFileEntry>,
    seen: &HashMap<String, (u64, bool)>,
    path: &Path,
) -> Option<(String, u64)> {
    let key = path.to_string_lossy().into_owned();
    let (size, is_dir) = *seen.get(&key)?;
    if is_dir {
        return None;
    }
    ctx_files.push(ConfigFileEntry {
        path: js(path),
        kind: file_kind(path).into(),
        size,
    });
    Some((key, size))
}

/// Batch-inspect all probe paths once, then hand out a lookup map.
fn probe(paths: &[PathBuf]) -> HashMap<String, (u64, bool)> {
    let mut dedup = Vec::new();
    let mut seen = HashSet::new();
    for p in paths {
        if seen.insert(p.to_string_lossy().into_owned()) {
            dedup.push(p.clone());
        }
    }
    inspect_all(&dedup)
}

fn mcp_summary(command: Option<&str>, args: &[String], url: Option<&str>) -> String {
    if let Some(url) = url {
        return url.to_string();
    }
    let mut s = command.unwrap_or("").to_string();
    for arg in args {
        if !s.is_empty() {
            s.push(' ');
        }
        s.push_str(arg);
    }
    s
}

fn env_count(value: Option<&Value>) -> Option<String> {
    let env = value?.as_object()?;
    if env.is_empty() {
        None
    } else {
        Some(format!(
            "{} env var{}",
            env.len(),
            if env.len() == 1 { "" } else { "s" }
        ))
    }
}

// ---- claude ---------------------------------------------------------------

fn claude_extensions(ctx: &Ctx) -> ProviderExtensions {
    let mut out = ProviderExtensions {
        provider: "claude".into(),
        ..Default::default()
    };
    let Some(home) = ctx.home.clone() else {
        return out;
    };

    let claude_json = home.join(".claude.json");
    let settings = home.join(".claude/settings.json");
    let settings_local = home.join(".claude/settings.local.json");
    let plugins_json = home.join(".claude/plugins/installed_plugins.json");
    let proj_settings = ctx.project_join(".claude/settings.json");
    let proj_settings_local = ctx.project_join(".claude/settings.local.json");
    let proj_mcp = ctx.project_join(".mcp.json");

    let probe_paths = vec![
        claude_json.clone(),
        settings.clone(),
        settings_local.clone(),
        plugins_json.clone(),
        proj_settings.clone(),
        proj_settings_local.clone(),
        proj_mcp.clone(),
        home.join(".claude"),
        home.join(".claude/agents"),
        home.join(".claude/commands"),
        ctx.project_join(".claude/agents"),
        ctx.project_join(".claude/commands"),
    ];
    let seen = probe(&probe_paths);
    out.detected = seen
        .get(&home.join(".claude").to_string_lossy().into_owned())
        .is_some_and(|(_, is_dir)| *is_dir)
        || seen.contains_key(&claude_json.to_string_lossy().into_owned());
    for path in &probe_paths {
        existing_file(&mut out.files, &seen, path);
    }

    // MCP: user scope (~/.claude.json top-level mcpServers), local scope
    // (~/.claude.json projects[cwd].mcpServers), project scope (.mcp.json).
    let mut approved: HashSet<String> = HashSet::new();
    let mut rejected: HashSet<String> = HashSet::new();
    let mut approve_all = false;
    if let Some(text) = read_config_text(&claude_json) {
        if let Some(value) = parse_json_file(&text) {
            let file = js(&claude_json);
            mcp_map_entries(
                &value["mcpServers"],
                "user",
                &file,
                &mut out.mcp_servers,
                None,
                &jp(&["mcpServers"]),
            );
            let local = value["projects"][ctx.project_native.as_str()].clone();
            mcp_map_entries(
                &local["mcpServers"],
                "local",
                &file,
                &mut out.mcp_servers,
                None,
                &jp(&["projects", ctx.project_native.as_str(), "mcpServers"]),
            );
            // Devin also reads hooks out of ~/.claude.json.
            collect_hooks_map(
                &value["hooks"],
                &file,
                "user",
                &mut out.hooks,
                &jp(&["hooks"]),
            );
            let p = &value["projects"][ctx.project_native.as_str()];
            approve_all = p["enableAllProjectMcpServers"].as_bool().unwrap_or(false);
            for name in p["enabledMcpjsonServers"].as_array().into_iter().flatten() {
                if let Some(s) = name.as_str() {
                    approved.insert(s.to_string());
                }
            }
            for name in p["disabledMcpjsonServers"].as_array().into_iter().flatten() {
                if let Some(s) = name.as_str() {
                    rejected.insert(s.to_string());
                }
            }
        }
    }
    // The same approval keys are valid in project/local settings files.
    for file in [&proj_settings, &proj_settings_local] {
        let Some(text) = read_config_text(file) else {
            continue;
        };
        let Some(value) = parse_json_file(&text) else {
            continue;
        };
        approve_all |= value["enableAllProjectMcpServers"]
            .as_bool()
            .unwrap_or(false);
        for name in value["enabledMcpjsonServers"]
            .as_array()
            .into_iter()
            .flatten()
        {
            if let Some(s) = name.as_str() {
                approved.insert(s.to_string());
            }
        }
        for name in value["disabledMcpjsonServers"]
            .as_array()
            .into_iter()
            .flatten()
        {
            if let Some(s) = name.as_str() {
                rejected.insert(s.to_string());
            }
        }
    }
    if let Some(text) = read_config_text(&proj_mcp) {
        if let Some(value) = parse_json_file(&text) {
            let file = js(&proj_mcp);
            let start = out.mcp_servers.len();
            mcp_map_entries(
                &value["mcpServers"],
                "project",
                &file,
                &mut out.mcp_servers,
                None,
                &jp(&["mcpServers"]),
            );
            for entry in &mut out.mcp_servers[start..] {
                entry.enabled = if approve_all || approved.contains(&entry.name) {
                    Some(true)
                } else if rejected.contains(&entry.name) {
                    Some(false)
                } else {
                    None
                };
                if entry.detail.is_none() {
                    entry.detail = Some("Also read by Copilot and fx".into());
                }
            }
        }
    }

    // Plugins: installed registry + enabledPlugins across settings files.
    // Read precedence runs user < project < project-local < managed so the
    // last matching write below is the effective setting.
    let managed = managed_settings_root()
        .map(|root| managed_plugin_settings(&root))
        .unwrap_or_default();
    let mut plugin_enabled_files: Vec<(PathBuf, HashMap<String, bool>)> = Vec::new();
    for file in [
        settings.clone(),
        settings_local.clone(),
        proj_settings.clone(),
        proj_settings_local.clone(),
    ] {
        let mut map = HashMap::new();
        if let Some(text) = read_config_text(&file) {
            if let Some(value) = parse_json_file(&text) {
                if let Some(obj) = value["enabledPlugins"].as_object() {
                    for (k, v) in obj {
                        if let Some(b) = v.as_bool() {
                            map.insert(k.clone(), b);
                        }
                    }
                }
            }
        }
        plugin_enabled_files.push((file, map));
    }

    let mut installed: Vec<(String, String, String)> = Vec::new(); // id, scope, installPath
    if let Some(text) = read_config_text(&plugins_json) {
        if let Some(value) = parse_json_file(&text) {
            if let Some(plugins) = value["plugins"].as_object() {
                for (id, installs) in plugins {
                    let entries: Vec<&Value> = match installs {
                        Value::Array(a) => a.iter().collect(),
                        other => vec![other],
                    };
                    for entry in entries {
                        let install_path = entry["installPath"].as_str().unwrap_or("").to_string();
                        let scope = entry["scope"].as_str().unwrap_or("user").to_string();
                        installed.push((id.clone(), scope, install_path));
                    }
                }
            }
        }
    }

    let mut ids: Vec<String> = installed.iter().map(|(id, _, _)| id.clone()).collect();
    let mut add_id = |id: &String| {
        if !ids.contains(id) {
            ids.push(id.clone());
        }
    };
    for (_, map) in &plugin_enabled_files {
        for id in map.keys() {
            add_id(id);
        }
    }
    for id in managed.keys() {
        add_id(id);
    }
    ids.sort();
    for id in ids {
        // Lowest precedence first so the last match wins.
        let mut enabled: Option<bool> = None;
        let mut source_file: Option<PathBuf> = None;
        for (file, map) in &plugin_enabled_files {
            if let Some(v) = map.get(&id) {
                enabled = Some(*v);
                source_file = Some(file.clone());
            }
        }
        let managed_forced = managed.get(&id).copied().flatten();
        if let Some(v) = managed_forced {
            enabled = Some(v);
        }
        let install = installed.iter().find(|(i, _, _)| *i == id);
        let scope = install
            .map(|(_, s, _)| s.clone())
            .unwrap_or_else(|| "user".into());
        let toggle = if managed_forced.is_some() {
            None
        } else {
            let target = source_file.unwrap_or_else(|| settings.clone());
            Some(ToggleRef {
                file: js(&target),
                format: "json".into(),
                path: vec!["enabledPlugins".into()],
                member: id.clone(),
                invert: false,
            })
        };
        out.plugins.push(PluginEntry {
            id: id.clone(),
            kind: "plugin".into(),
            scope,
            file: js(&plugins_json),
            detail: match install {
                Some((_, _, p)) if !p.is_empty() => Some(p.clone()),
                Some(_) => None,
                None => Some("Not installed".into()),
            },
            installed: install.is_some(),
            managed: managed_forced.is_some(),
            // Claude treats installed plugins as on unless a settings file
            // explicitly disables them.
            enabled: match enabled {
                Some(v) => Some(v),
                None if install.is_some() => Some(true),
                None => None,
            },
            toggle,
            // The entry lives in a CLI-owned registry, not an editable config
            // section — no removal.
            remove: None,
        });
    }

    // Hooks from user + project + local settings files.
    for (file, scope) in [
        (settings, "user"),
        (settings_local, "user"),
        (proj_settings, "project"),
        (proj_settings_local, "project"),
    ] {
        if let Some(text) = read_config_text(&file) {
            if let Some(value) = parse_json_file(&text) {
                collect_hooks_map(
                    &value["hooks"],
                    &js(&file),
                    scope,
                    &mut out.hooks,
                    &jp(&["hooks"]),
                );
            }
        }
    }
    out
}

fn managed_plugin_settings(root: &Path) -> HashMap<String, Option<bool>> {
    let mut out: HashMap<String, Option<bool>> = HashMap::new();
    let mut apply = |path: &Path| {
        if let Some(text) = read_config_text(path) {
            if let Some(value) = parse_json_file(&text) {
                if let Some(obj) = value["enabledPlugins"].as_object() {
                    for (k, v) in obj {
                        out.insert(k.clone(), v.as_bool());
                    }
                }
            }
        }
    };
    apply(&root.join("managed-settings.json"));
    let dir = root.join("managed-settings.d");
    let mut files: Vec<PathBuf> = list_dir(&dir)
        .into_iter()
        .map(|e| PathBuf::from(e.path))
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("json"))
        .collect();
    files.sort();
    for file in files {
        apply(&file);
    }
    out
}

fn managed_settings_root() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        return Some(PathBuf::from("/Library/Application Support/ClaudeCode"));
    }
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        return Some(PathBuf::from("/etc/claude-code"));
    }
    #[cfg(target_os = "windows")]
    {
        return Some(PathBuf::from(r"C:\Program Files\ClaudeCode"));
    }
    #[allow(unreachable_code)]
    None
}

// ---- codex-family (codex, grok): config.toml with [mcp_servers.*] -----------

/// `env_home` overrides the user config dir ($CODEX_HOME / $GROK_HOME);
/// `dir` is the default config dir relative to home (".codex" / ".grok").
fn codex_family_extensions(
    ctx: &Ctx,
    provider: &str,
    env_home: &str,
    dir: &str,
    files: &[&str],
) -> ProviderExtensions {
    let mut out = ProviderExtensions {
        provider: provider.into(),
        ..Default::default()
    };
    // $CODEX_HOME/$GROK_HOME override ~/.codex/~/.grok — only meaningful for a
    // host project; the host env doesn't leak into a WSL guest.
    let user_root: Option<PathBuf> = if !ctx.wsl_project {
        std::env::var_os(env_home)
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .or_else(|| ctx.home_join(dir))
    } else {
        ctx.home_join(dir)
    };
    let mut candidates: Vec<(PathBuf, &str)> = Vec::new(); // file, scope
    for file in files {
        if let Some(h) = &user_root {
            candidates.push((h.join(file), "user"));
        }
    }
    // Grok walks ancestors to the repo root; harmless extra probes for codex.
    for ancestor in ctx.project.ancestors().take(8) {
        if let Some(home) = &ctx.home {
            if ancestor == home.as_path() {
                break;
            }
        }
        for file in files {
            candidates.push((ancestor.join(format!("{dir}/{file}")), "project"));
        }
    }
    let mut probe_paths: Vec<PathBuf> = candidates.iter().map(|(p, _)| p.clone()).collect();
    if let Some(h) = &user_root {
        probe_paths.push(h.clone());
        probe_paths.push(h.join("hooks"));
    }
    probe_paths.push(ctx.project_join(&format!("{dir}/hooks")));
    // System/user managed layers outrank normal config — listed, not parsed.
    let mut managed_files: Vec<PathBuf> = Vec::new();
    if provider == "grok" {
        if let Some(h) = ctx.home_join(".grok") {
            managed_files.push(h.join("managed_config.toml"));
            managed_files.push(h.join("requirements.toml"));
        }
        if !ctx.wsl_project {
            managed_files.push(PathBuf::from("/etc/grok/managed_config.toml"));
            managed_files.push(PathBuf::from("/etc/grok/requirements.toml"));
        }
        probe_paths.extend(managed_files.iter().cloned());
    }
    let seen = probe(&probe_paths);
    out.detected = user_root
        .as_ref()
        .and_then(|p| seen.get(&p.to_string_lossy().into_owned()).copied())
        .is_some_and(|(_, is_dir)| is_dir);
    for (path, _scope) in &candidates {
        existing_file(&mut out.files, &seen, path);
    }
    for path in &managed_files {
        existing_file(&mut out.files, &seen, path);
    }

    for (path, scope) in &candidates {
        let Some(text) = read_config_text(path) else {
            continue;
        };
        let file = js(path);
        if path.extension().and_then(|e| e.to_str()) == Some("toml") {
            parse_codex_toml(&text, &file, scope, &mut out);
        } else if path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n == "hooks.json")
        {
            if let Some(value) = parse_json_file(&text) {
                // Codex wraps the map in "hooks"; a bare map also parses.
                let (hooks, root) = if value["hooks"].is_object() {
                    (&value["hooks"], jp(&["hooks"]))
                } else {
                    (&value, Vec::new())
                };
                collect_hooks_map(hooks, &file, scope, &mut out.hooks, &root);
            }
        }
    }

    // Grok hook files: hooks/*.json (claude-format maps) under the user root
    // and the project .grok dir.
    if provider == "grok" {
        let mut hook_dirs: Vec<(PathBuf, &str)> =
            vec![(ctx.project_join(".grok/hooks"), "project")];
        if let Some(root) = &user_root {
            hook_dirs.push((root.join("hooks"), "user"));
        }
        for (dir, scope) in hook_dirs {
            for entry in list_dir(&dir) {
                if !entry.name.ends_with(".json") || entry.is_dir {
                    continue;
                }
                let path = PathBuf::from(&entry.path);
                if let Some(text) = read_config_text(&path) {
                    if let Some(value) = parse_json_file(&text) {
                        let (hooks, root) = if value["hooks"].is_object() {
                            (&value["hooks"], jp(&["hooks"]))
                        } else {
                            (&value, Vec::new())
                        };
                        collect_hooks_map(hooks, &entry.path, scope, &mut out.hooks, &root);
                    }
                }
            }
        }
    }
    out
}

/// `[mcp_servers.*]`, `[plugins.*]`, `[marketplaces.*]`, top-level `notify`.
fn parse_codex_toml(text: &str, file: &str, scope: &str, out: &mut ProviderExtensions) {
    let tables = toml_tables(text);
    for table in &tables {
        if table.path.len() == 2 && table.path[0] == "mcp_servers" {
            let body = &text[table.body_start..table.end];
            let command = toml_get(body, "command").map(|v| unquote_toml_string(&v));
            let args = toml_get(body, "args")
                .map(|v| toml_string_list(&v))
                .unwrap_or_default();
            let url = toml_get(body, "url").map(|v| unquote_toml_string(&v));
            let enabled = toml_bool_value(body, "enabled");
            let disabled_tools = toml_get(body, "disabled_tools")
                .map(|v| toml_string_list(&v).len())
                .unwrap_or(0);
            let mut detail = None;
            if let Some(env_table) = toml_table(&tables, {
                &[table.path[0].clone(), table.path[1].clone(), "env".into()] as &[String]
            }) {
                let env_body = &text[env_table.body_start..env_table.end];
                let count = env_body
                    .lines()
                    .filter(|l| {
                        find_toml_eq(l.trim_start()).is_some() && !l.trim_start().starts_with('#')
                    })
                    .count();
                if count > 0 {
                    detail = Some(format!("{count} env vars"));
                }
            }
            if disabled_tools > 0 {
                let extra = format!("{disabled_tools} disabled tools");
                detail = Some(match detail {
                    Some(d) => format!("{d} · {extra}"),
                    None => extra,
                });
            }
            out.mcp_servers.push(McpServerEntry {
                name: table.path[1].clone(),
                scope: scope.into(),
                file: file.into(),
                transport: if url.is_some() { "http" } else { "stdio" }.into(),
                summary: mcp_summary(command.as_deref(), &args, url.as_deref()),
                detail,
                enabled: Some(enabled.unwrap_or(true)),
                toggle: Some(ToggleRef {
                    file: file.into(),
                    format: "toml".into(),
                    path: table.path.clone(),
                    member: "enabled".into(),
                    invert: false,
                }),
                remove: Some(RemoveRef {
                    file: file.into(),
                    format: "toml".into(),
                    path: table.path.clone(),
                    array_item: None,
                    expect: None,
                }),
            });
        } else if table.path.len() == 1 && table.path[0] == "plugins" {
            // Grok's list form: [plugins] with name lists in enabled/disabled
            // plus install paths.
            let body = &text[table.body_start..table.end];
            let enabled_list = toml_get(body, "enabled")
                .map(|v| toml_string_list(&v))
                .unwrap_or_default();
            let disabled_list = toml_get(body, "disabled")
                .map(|v| toml_string_list(&v))
                .unwrap_or_default();
            let paths = toml_get(body, "paths")
                .map(|v| toml_string_list(&v))
                .unwrap_or_default();
            for name in &enabled_list {
                out.plugins.push(PluginEntry {
                    id: name.clone(),
                    kind: "plugin".into(),
                    scope: scope.into(),
                    file: file.into(),
                    detail: None,
                    installed: true,
                    managed: false,
                    enabled: Some(true),
                    toggle: None,
                    remove: Some(RemoveRef {
                        file: file.into(),
                        format: "toml".into(),
                        path: jp(&["plugins", "enabled"]),
                        array_item: Some(name.clone()),
                        expect: None,
                    }),
                });
            }
            for name in &disabled_list {
                if enabled_list.contains(name) {
                    continue;
                }
                out.plugins.push(PluginEntry {
                    id: name.clone(),
                    kind: "plugin".into(),
                    scope: scope.into(),
                    file: file.into(),
                    detail: None,
                    installed: true,
                    managed: false,
                    enabled: Some(false),
                    toggle: None,
                    remove: Some(RemoveRef {
                        file: file.into(),
                        format: "toml".into(),
                        path: jp(&["plugins", "disabled"]),
                        array_item: Some(name.clone()),
                        expect: None,
                    }),
                });
            }
            for p in &paths {
                out.plugins.push(PluginEntry {
                    id: p.clone(),
                    kind: "plugin path".into(),
                    scope: scope.into(),
                    file: file.into(),
                    detail: None,
                    installed: true,
                    managed: false,
                    enabled: None,
                    toggle: None,
                    remove: Some(RemoveRef {
                        file: file.into(),
                        format: "toml".into(),
                        path: jp(&["plugins", "paths"]),
                        array_item: Some(p.clone()),
                        expect: None,
                    }),
                });
            }
        } else if table.path.len() == 2 && table.path[0] == "plugins" {
            let body = &text[table.body_start..table.end];
            let enabled = toml_bool_value(body, "enabled");
            out.plugins.push(PluginEntry {
                id: table.path[1].clone(),
                kind: "plugin".into(),
                scope: scope.into(),
                file: file.into(),
                detail: toml_get(body, "source").map(|v| unquote_toml_string(&v)),
                installed: true,
                managed: false,
                enabled: Some(enabled.unwrap_or(true)),
                toggle: Some(ToggleRef {
                    file: file.into(),
                    format: "toml".into(),
                    path: table.path.clone(),
                    member: "enabled".into(),
                    invert: false,
                }),
                remove: Some(RemoveRef {
                    file: file.into(),
                    format: "toml".into(),
                    path: table.path.clone(),
                    array_item: None,
                    expect: None,
                }),
            });
        } else if table.path.len() == 2 && table.path[0] == "marketplaces" {
            let body = &text[table.body_start..table.end];
            out.plugins.push(PluginEntry {
                id: table.path[1].clone(),
                kind: "marketplace".into(),
                scope: scope.into(),
                file: file.into(),
                detail: toml_get(body, "source").map(|v| unquote_toml_string(&v)),
                installed: true,
                managed: false,
                enabled: None,
                toggle: None,
                remove: Some(RemoveRef {
                    file: file.into(),
                    format: "toml".into(),
                    path: table.path.clone(),
                    array_item: None,
                    expect: None,
                }),
            });
        }
    }
    // `[hooks.<Event>]` / `[[hooks.<Event>]]` tables hold command hooks.
    for table in &tables {
        if table.path.len() >= 2 && table.path[0] == "hooks" {
            let body = &text[table.body_start..table.end];
            let command = toml_get(body, "command")
                .or_else(|| toml_get(body, "prompt"))
                .map(|v| unquote_toml_string(&v));
            if let Some(command) = command.filter(|c| !c.is_empty()) {
                out.hooks.push(HookEntry {
                    event: table.path[1].clone(),
                    matcher: toml_get(body, "matcher").map(|v| unquote_toml_string(&v)),
                    kind: "command".into(),
                    command: Some(command.clone()),
                    file: file.into(),
                    scope: scope.into(),
                    refs: Vec::new(),
                    remove: Some(RemoveRef {
                        file: file.into(),
                        format: "toml".into(),
                        path: table.path.clone(),
                        array_item: Some(command),
                        expect: None,
                    }),
                });
            }
        }
    }
    // Top-level `notify` — a command run when a turn finishes. Codex ignores
    // it in project-scoped config.toml, so only surface the user file.
    if scope != "user" {
        return;
    }
    let root_end = tables.first().map(|t| t.start).unwrap_or(text.len());
    if let Some(notify) = toml_get(&text[..root_end], "notify") {
        let command = if notify.trim_start().starts_with('[') {
            toml_string_list(&notify).join(" ")
        } else {
            unquote_toml_string(&notify)
        };
        if !command.is_empty() {
            out.hooks.push(HookEntry {
                event: "notify".into(),
                matcher: None,
                kind: "command".into(),
                command: Some(command),
                file: file.into(),
                scope: scope.into(),
                refs: Vec::new(),
                remove: Some(RemoveRef {
                    file: file.into(),
                    format: "toml".into(),
                    path: jp(&["notify"]),
                    array_item: None,
                    expect: None,
                }),
            });
        }
    }
}

// ---- cursor ---------------------------------------------------------------

fn cursor_extensions(ctx: &Ctx) -> ProviderExtensions {
    let mut out = ProviderExtensions {
        provider: "cursor".into(),
        ..Default::default()
    };
    let candidates: Vec<(PathBuf, &str)> = [
        (ctx.home_join(".cursor/mcp.json"), "user"),
        (Some(ctx.project_join(".cursor/mcp.json")), "project"),
        (ctx.home_join(".cursor/hooks.json"), "user"),
        (Some(ctx.project_join(".cursor/hooks.json")), "project"),
    ]
    .into_iter()
    .filter_map(|(p, s)| p.map(|p| (p, s)))
    .collect();
    let mut probe_paths: Vec<PathBuf> = candidates.iter().map(|(p, _)| p.clone()).collect();
    if let Some(h) = ctx.home_join(".cursor") {
        probe_paths.push(h);
    }
    let seen = probe(&probe_paths);
    out.detected = ctx
        .home_join(".cursor")
        .and_then(|p| seen.get(&p.to_string_lossy().into_owned()).copied())
        .is_some_and(|(_, is_dir)| is_dir);
    for (path, _) in &candidates {
        existing_file(&mut out.files, &seen, path);
    }
    for (path, scope) in &candidates {
        let Some(text) = read_config_text(path) else {
            continue;
        };
        let Some(value) = parse_json_file(&text) else {
            continue;
        };
        let file = js(path);
        if path.file_name().and_then(|n| n.to_str()) == Some("mcp.json") {
            mcp_map_entries(
                &value["mcpServers"],
                scope,
                &file,
                &mut out.mcp_servers,
                None,
                &jp(&["mcpServers"]),
            );
        } else {
            collect_flat_hooks(
                &value["hooks"],
                &file,
                scope,
                &mut out.hooks,
                &jp(&["hooks"]),
            );
        }
    }
    out
}

// ---- opencode -------------------------------------------------------------

fn opencode_extensions(ctx: &Ctx) -> ProviderExtensions {
    let mut out = ProviderExtensions {
        provider: "opencode".into(),
        ..Default::default()
    };
    let mut files: Vec<(PathBuf, &str)> = Vec::new();
    for name in ["opencode.json", "opencode.jsonc"] {
        if let Some(p) = ctx.home_join(&format!(".config/opencode/{name}")) {
            files.push((p, "user"));
        }
    }
    // OpenCode walks ancestors to the filesystem root for config files.
    for ancestor in ctx.project.ancestors().take(8) {
        if let Some(home) = &ctx.home {
            if ancestor == home.as_path() {
                break;
            }
        }
        for name in ["opencode.json", "opencode.jsonc"] {
            files.push((ancestor.join(name), "project"));
            files.push((ancestor.join(format!(".opencode/{name}")), "project"));
        }
    }
    let mut probe_paths: Vec<PathBuf> = files.iter().map(|(p, _)| p.clone()).collect();
    if let Some(h) = ctx.home_join(".config/opencode") {
        probe_paths.push(h.clone());
        probe_paths.push(h.join("plugins"));
    }
    probe_paths.push(ctx.project_join(".opencode/plugins"));
    let seen = probe(&probe_paths);
    out.detected = ctx
        .home_join(".config/opencode")
        .and_then(|p| seen.get(&p.to_string_lossy().into_owned()).copied())
        .is_some_and(|(_, is_dir)| is_dir);
    for (path, _) in &files {
        existing_file(&mut out.files, &seen, path);
    }
    for (path, scope) in &files {
        let Some(text) = read_config_text(path) else {
            continue;
        };
        let Some(value) = parse_json_file(&text) else {
            continue;
        };
        let file = js(path);
        // v1: `mcp.{name}`; v2 nests under `mcp.servers.{name}` (the container
        // is skipped by the server-key heuristic inside mcp_map_entries).
        mcp_map_entries(
            &value["mcp"],
            scope,
            &file,
            &mut out.mcp_servers,
            Some(&MCP_TOGGLE_OPENCODE),
            &jp(&["mcp"]),
        );
        mcp_map_entries(
            &value["mcp"]["servers"],
            scope,
            &file,
            &mut out.mcp_servers,
            Some(&MCP_TOGGLE_OPENCODE_NESTED),
            &jp(&["mcp", "servers"]),
        );
        // v1 `plugin` + v2 `plugins` arrays; `-name` disables, objects carry
        // {package, options}.
        for key in ["plugin", "plugins"] {
            if let Some(plugins) = value[key].as_array() {
                for p in plugins {
                    let raw = p
                        .as_str()
                        .map(String::from)
                        .or_else(|| p["package"].as_str().map(String::from))
                        .or_else(|| p["name"].as_str().map(String::from));
                    let Some(raw) = raw else {
                        continue;
                    };
                    let (id, enabled) = raw
                        .strip_prefix('-')
                        .map_or((raw.as_str(), true), |n| (n, false));
                    if id.is_empty() {
                        continue;
                    }
                    out.plugins.push(PluginEntry {
                        id: id.to_string(),
                        kind: "plugin".into(),
                        scope: (*scope).into(),
                        file: file.clone(),
                        detail: None,
                        installed: true,
                        managed: false,
                        enabled: Some(enabled),
                        toggle: None,
                        remove: Some(RemoveRef {
                            file: file.clone(),
                            format: "json".into(),
                            path: jp(&[key]),
                            array_item: Some(id.to_string()),
                            expect: None,
                        }),
                    });
                }
            }
        }
    }
    // File plugins: ~/.config/opencode/plugins/*.{js,ts} + .opencode/plugins.
    let mut plugin_dirs: Vec<(PathBuf, &str)> =
        vec![(ctx.project_join(".opencode/plugins"), "project")];
    if let Some(h) = ctx.home_join(".config/opencode/plugins") {
        plugin_dirs.push((h, "user"));
    }
    for (dir, scope) in plugin_dirs {
        for entry in list_dir(&dir) {
            // Package dirs (containing their own entry file) load too.
            if entry.name.starts_with('.')
                || (!entry.is_dir && !(entry.name.ends_with(".js") || entry.name.ends_with(".ts")))
            {
                continue;
            }
            out.plugins.push(PluginEntry {
                id: entry.name.clone(),
                kind: "plugin file".into(),
                scope: scope.into(),
                file: entry.path.clone(),
                detail: None,
                installed: true,
                managed: false,
                enabled: None,
                toggle: None,
                remove: Some(RemoveRef {
                    file: entry.path.clone(),
                    format: "file".into(),
                    path: Vec::new(),
                    array_item: None,
                    expect: None,
                }),
            });
        }
    }
    out
}

// ---- pi-family (pi, omp): agent dir settings, extensions/, mcp.json ----------

fn pi_family_extensions(ctx: &Ctx, provider: &str, dir: &str) -> ProviderExtensions {
    let mut out = ProviderExtensions {
        provider: provider.into(),
        ..Default::default()
    };
    // User config lives under ~/.{pi,omp}/agent; project config under .{pi,omp}.
    let mut settings_files: Vec<(PathBuf, &str)> = Vec::new();
    for rel in ["settings.json", "agent/settings.json"] {
        if let Some(p) = ctx.home_join(&format!("{dir}/{rel}")) {
            settings_files.push((p, "user"));
        }
    }
    settings_files.push((ctx.project_join(&format!("{dir}/settings.json")), "project"));

    let mut mcp_files: Vec<(PathBuf, &str)> = Vec::new();
    for rel in ["mcp.json", "agent/mcp.json"] {
        if let Some(p) = ctx.home_join(&format!("{dir}/{rel}")) {
            mcp_files.push((p, "user"));
        }
    }
    mcp_files.push((ctx.project_join(&format!("{dir}/mcp.json")), "project"));
    // omp keeps per-profile agent dirs under ~/.omp/profiles/<name>/agent.
    let mut profile_dirs: Vec<PathBuf> = Vec::new();
    if provider == "omp" {
        if let Some(profiles) = ctx.home_join(".omp/profiles") {
            for entry in list_dir(&profiles) {
                if entry.is_dir {
                    profile_dirs.push(PathBuf::from(&entry.path));
                }
            }
        }
    }
    for dir_path in &profile_dirs {
        mcp_files.push((dir_path.join("agent/mcp.json"), "user"));
        settings_files.push((dir_path.join("agent/settings.json"), "user"));
    }

    // package.json can carry a `pi` manifest declaring extensions.
    let mut pkg_files: Vec<(PathBuf, &str)> = Vec::new();
    for rel in ["package.json", "agent/package.json"] {
        if let Some(p) = ctx.home_join(&format!("{dir}/{rel}")) {
            pkg_files.push((p, "user"));
        }
    }

    let mut probe_paths: Vec<PathBuf> = settings_files
        .iter()
        .chain(mcp_files.iter())
        .chain(pkg_files.iter())
        .map(|(p, _)| p.clone())
        .collect();
    for rel in [dir, &format!("{dir}/agent")] {
        if let Some(h) = ctx.home_join(rel) {
            probe_paths.push(h.clone());
            probe_paths.push(h.join("config.yml")); // listed for context only
        }
        probe_paths.push(ctx.project_join(rel));
    }
    let seen = probe(&probe_paths);
    out.detected = [dir.to_string(), format!("{dir}/agent")].iter().any(|rel| {
        ctx.home_join(rel)
            .and_then(|p| seen.get(&p.to_string_lossy().into_owned()).copied())
            .is_some_and(|(_, is_dir)| is_dir)
    });
    for path in &probe_paths {
        existing_file(&mut out.files, &seen, path);
    }

    for (path, scope) in mcp_files
        .iter()
        .chain(settings_files.iter())
        .chain(pkg_files.iter())
    {
        let Some(text) = read_config_text(path) else {
            continue;
        };
        let Some(value) = parse_json_file(&text) else {
            continue;
        };
        let file = js(path);
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        mcp_map_entries(
            &value["mcpServers"],
            scope,
            &file,
            &mut out.mcp_servers,
            None,
            &jp(&["mcpServers"]),
        );
        mcp_map_entries(
            &value["mcp"],
            scope,
            &file,
            &mut out.mcp_servers,
            None,
            &jp(&["mcp"]),
        );
        // settings.json `packages` (npm:/git: specs) + `extensions` (paths);
        // package.json carries the same under a `pi` manifest key.
        let manifest = name == "package.json";
        let root = if manifest {
            value["pi"].clone()
        } else {
            value.clone()
        };
        let root_path: Vec<String> = if manifest { jp(&["pi"]) } else { Vec::new() };
        for section in ["packages", "extensions"] {
            match &root[section] {
                Value::Array(items) => {
                    for item in items {
                        if let Some(name) = item.as_str() {
                            push_extension(
                                &mut out.plugins,
                                name,
                                &file,
                                scope,
                                Some(RemoveRef {
                                    file: file.clone(),
                                    format: "json".into(),
                                    path: root_path
                                        .iter()
                                        .cloned()
                                        .chain([section.to_string()])
                                        .collect(),
                                    array_item: Some(name.to_string()),
                                    expect: None,
                                }),
                            );
                        }
                    }
                }
                Value::Object(map) => {
                    for name in map.keys() {
                        push_extension(
                            &mut out.plugins,
                            name,
                            &file,
                            scope,
                            Some(RemoveRef {
                                file: file.clone(),
                                format: "json".into(),
                                path: root_path
                                    .iter()
                                    .cloned()
                                    .chain([section.to_string(), name.clone()])
                                    .collect(),
                                array_item: None,
                                expect: None,
                            }),
                        );
                    }
                }
                _ => {}
            }
        }
    }

    // Auto-loaded extension files: extensions/*.{ts,js} under agent + project.
    let mut ext_dirs: Vec<(PathBuf, &str)> =
        vec![(ctx.project_join(&format!("{dir}/extensions")), "project")];
    for rel in ["extensions", "agent/extensions"] {
        if let Some(h) = ctx.home_join(&format!("{dir}/{rel}")) {
            ext_dirs.push((h, "user"));
        }
    }
    for dir_path in &profile_dirs {
        ext_dirs.push((dir_path.join("agent/extensions"), "user"));
    }
    for (dir_path, scope) in ext_dirs {
        for entry in list_dir(&dir_path) {
            if entry.name.starts_with('.') {
                continue;
            }
            let is_file =
                !entry.is_dir && (entry.name.ends_with(".ts") || entry.name.ends_with(".js"));
            if !(is_file || entry.is_dir) {
                continue;
            }
            push_extension(
                &mut out.plugins,
                &entry.name,
                &entry.path,
                scope,
                Some(RemoveRef {
                    file: entry.path.clone(),
                    format: "file".into(),
                    path: Vec::new(),
                    array_item: None,
                    expect: None,
                }),
            );
        }
    }
    out
}

fn push_extension(
    plugins: &mut Vec<PluginEntry>,
    name: &str,
    file: &str,
    scope: &str,
    remove: Option<RemoveRef>,
) {
    if plugins.iter().any(|p| p.id == name) {
        return;
    }
    plugins.push(PluginEntry {
        id: name.to_string(),
        kind: "extension".into(),
        scope: scope.into(),
        file: file.into(),
        detail: None,
        installed: true,
        managed: false,
        enabled: None,
        toggle: None,
        remove,
    });
}

// ---- devin ------------------------------------------------------------------

fn devin_extensions(ctx: &Ctx) -> ProviderExtensions {
    let mut out = ProviderExtensions {
        provider: "devin".into(),
        ..Default::default()
    };
    let mcp_files: Vec<(PathBuf, &str)> = [
        ctx.home_join(".config/devin/mcp_config.json")
            .map(|p| (p, "user")),
        // Native Windows config root is %APPDATA%\devin.
        ctx.home_join("AppData/Roaming/devin/mcp_config.json")
            .map(|p| (p, "user")),
        ctx.home_join(".config/devin/config.json")
            .map(|p| (p, "user")),
        ctx.home_join("AppData/Roaming/devin/config.json")
            .map(|p| (p, "user")),
    ]
    .into_iter()
    .flatten()
    .collect();
    // Devin discovers .devin config files in ancestors up to the repo root.
    let mut ancestor_files: Vec<(PathBuf, &str)> = Vec::new();
    let mut ancestor_dirs: Vec<PathBuf> = Vec::new();
    for ancestor in ctx.project.ancestors().take(8) {
        if let Some(home) = &ctx.home {
            if ancestor == home.as_path() {
                break;
            }
        }
        ancestor_dirs.push(ancestor.join(".devin"));
        for name in [
            "mcp_config.json",
            "mcp_config.local.json",
            "config.json",
            "config.local.json",
        ] {
            let scope = if name.ends_with(".local.json") {
                "local"
            } else {
                "project"
            };
            ancestor_files.push((ancestor.join(format!(".devin/{name}")), scope));
        }
    }
    let mcp_files: Vec<(PathBuf, &str)> = mcp_files
        .into_iter()
        .chain(ancestor_files.iter().cloned())
        .collect();
    let hook_files: Vec<(PathBuf, &str)> = ancestor_dirs
        .iter()
        .map(|d| (d.join("hooks.v1.json"), "project"))
        .collect();
    let mut probe_paths: Vec<PathBuf> = mcp_files
        .iter()
        .chain(hook_files.iter())
        .map(|(p, _)| p.clone())
        .collect();
    for dir in [".config/devin", "AppData/Roaming/devin"] {
        if let Some(h) = ctx.home_join(dir) {
            probe_paths.push(h);
        }
    }
    probe_paths.push(ctx.project_join(".devin"));
    let seen = probe(&probe_paths);
    out.detected = [".config/devin", "AppData/Roaming/devin"]
        .iter()
        .any(|dir| {
            ctx.home_join(dir)
                .and_then(|p| seen.get(&p.to_string_lossy().into_owned()).copied())
                .is_some_and(|(_, is_dir)| is_dir)
        })
        || seen
            .get(&ctx.project_join(".devin").to_string_lossy().into_owned())
            .is_some_and(|(_, is_dir)| *is_dir);
    for (path, _) in mcp_files.iter().chain(hook_files.iter()) {
        existing_file(&mut out.files, &seen, path);
    }

    for (path, scope) in &mcp_files {
        let Some(text) = read_config_text(path) else {
            continue;
        };
        let Some(value) = parse_json_file(&text) else {
            continue;
        };
        let file = js(path);
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        mcp_map_entries(
            &value["mcpServers"],
            scope,
            &file,
            &mut out.mcp_servers,
            Some(&MCP_TOGGLE_DISABLED),
            &jp(&["mcpServers"]),
        );
        if name.starts_with("config") {
            collect_hooks_map(
                &value["hooks"],
                &file,
                scope,
                &mut out.hooks,
                &jp(&["hooks"]),
            );
        }
    }
    for (path, scope) in &hook_files {
        let Some(text) = read_config_text(path) else {
            continue;
        };
        if let Some(value) = parse_json_file(&text) {
            // The whole file is the hooks map.
            collect_hooks_map(&value, &js(path), scope, &mut out.hooks, &Vec::new());
        }
    }

    // Installed plugin graph is a CLI-owned cache; surface names if present.
    if let Some(home) = &ctx.home {
        // ~/.local/share/devin/cli/plugins/discovered.json on unix
        for rel in [
            ".local/share/devin/cli/plugins/discovered.json",
            ".local/share/devin/cli/plugins/lock.json",
        ] {
            let path = home.join(rel);
            let Some(text) = read_config_text(&path) else {
                continue;
            };
            let Some(value) = parse_json_file(&text) else {
                continue;
            };
            let file = js(&path);
            if let Some(nodes) = value["nodes"].as_array() {
                for node in nodes {
                    if let Some(name) = node["name"]
                        .as_str()
                        .or_else(|| node["id"].as_str())
                        .or_else(|| node["plugin"]["name"].as_str())
                    {
                        out.plugins.push(PluginEntry {
                            id: name.to_string(),
                            kind: "plugin".into(),
                            scope: "user".into(),
                            file: file.clone(),
                            detail: node["source"].as_str().map(String::from),
                            installed: true,
                            managed: false,
                            enabled: Some(true),
                            toggle: None,
                            remove: None,
                        });
                    }
                }
            }
            if !out.plugins.is_empty() {
                break;
            }
        }
    }
    out
}

// ---- copilot ----------------------------------------------------------------

fn copilot_extensions(ctx: &Ctx) -> ProviderExtensions {
    let mut out = ProviderExtensions {
        provider: "copilot".into(),
        ..Default::default()
    };
    // $COPILOT_HOME overrides ~/.copilot — host env doesn't apply to WSL.
    let home_root: Option<PathBuf> = if !ctx.wsl_project {
        std::env::var_os("COPILOT_HOME")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .or_else(|| ctx.home_join(".copilot"))
    } else {
        ctx.home_join(".copilot")
    };
    let files: Vec<(PathBuf, &str)> = [
        home_root
            .as_ref()
            .map(|h| (h.join("mcp-config.json"), "user")),
        Some((ctx.project_join(".copilot/mcp-config.json"), "project")),
        Some((ctx.project_join(".github/mcp.json"), "project")),
        // VS Code MCP config used by Copilot: {"servers": {name: {...}}}.
        Some((ctx.project_join(".vscode/mcp.json"), "project")),
        home_root.as_ref().map(|h| (h.join("config.json"), "user")),
        home_root
            .as_ref()
            .map(|h| (h.join("settings.json"), "user")),
        Some((ctx.project_join(".github/copilot/settings.json"), "project")),
        Some((
            ctx.project_join(".github/copilot/settings.local.json"),
            "local",
        )),
    ]
    .into_iter()
    .flatten()
    .collect();
    let mut probe_paths: Vec<PathBuf> = files.iter().map(|(p, _)| p.clone()).collect();
    if let Some(h) = &home_root {
        probe_paths.push(h.clone());
        probe_paths.push(h.join("hooks"));
    }
    probe_paths.push(ctx.project_join(".github/hooks"));
    let seen = probe(&probe_paths);
    out.detected = home_root
        .as_ref()
        .and_then(|p| seen.get(&p.to_string_lossy().into_owned()).copied())
        .is_some_and(|(_, is_dir)| is_dir);
    for (path, _) in &files {
        existing_file(&mut out.files, &seen, path);
    }
    for (path, scope) in &files {
        let Some(text) = read_config_text(path) else {
            continue;
        };
        let Some(value) = parse_json_file(&text) else {
            continue;
        };
        let file = js(path);
        mcp_map_entries(
            &value["mcpServers"],
            scope,
            &file,
            &mut out.mcp_servers,
            None,
            &jp(&["mcpServers"]),
        );
        mcp_map_entries(
            &value["servers"],
            scope,
            &file,
            &mut out.mcp_servers,
            None,
            &jp(&["servers"]),
        );
        // Settings files can carry a hooks map too.
        collect_hooks_map(
            &value["hooks"],
            &file,
            scope,
            &mut out.hooks,
            &jp(&["hooks"]),
        );
    }
    // Hook files: ~/.copilot/hooks/*.json (user) + .github/hooks/*.json.
    let mut hook_dirs: Vec<(PathBuf, &str)> = vec![(ctx.project_join(".github/hooks"), "project")];
    if let Some(h) = home_root.as_ref().map(|r| r.join("hooks")) {
        hook_dirs.push((h, "user"));
    }
    for (dir, scope) in hook_dirs {
        for entry in list_dir(&dir) {
            if entry.is_dir || !entry.name.ends_with(".json") {
                continue;
            }
            let path = PathBuf::from(&entry.path);
            let Some(text) = read_config_text(&path) else {
                continue;
            };
            let Some(value) = parse_json_file(&text) else {
                continue;
            };
            let (map, root) = if value["hooks"].is_object() {
                (&value["hooks"], jp(&["hooks"]))
            } else {
                (&value, Vec::new())
            };
            collect_hooks_map(map, &js(&path), scope, &mut out.hooks, &root);
        }
    }
    out
}

// ---- generic fallback (fx, muse) ---------------------------------------------

fn fx_extensions(ctx: &Ctx) -> ProviderExtensions {
    // `<repo>/.fx.json` is the committed project layer.
    generic_extensions(ctx, "fx", &[".fx", ".config/fx"], &[".fx.json"])
}

fn muse_extensions(ctx: &Ctx) -> ProviderExtensions {
    generic_extensions(ctx, "muse", &[".config/muse", ".muse"], &[])
}

const GENERIC_FILES: [&str; 5] = [
    "settings.json",
    "config.json",
    "mcp.json",
    "hooks.json",
    "config.toml",
];

fn generic_extensions(
    ctx: &Ctx,
    provider: &str,
    home_dirs: &[&str],
    project_files: &[&str],
) -> ProviderExtensions {
    let mut out = ProviderExtensions {
        provider: provider.into(),
        ..Default::default()
    };
    let mut probe_paths = Vec::new();
    for dir in home_dirs {
        if let Some(h) = ctx.home_join(dir) {
            probe_paths.push(h.clone());
            for file in GENERIC_FILES {
                probe_paths.push(h.join(file));
            }
        }
    }
    for file in project_files {
        probe_paths.push(ctx.project_join(file));
    }
    let seen = probe(&probe_paths);
    out.detected = home_dirs.iter().any(|dir| {
        ctx.home_join(dir)
            .and_then(|p| seen.get(&p.to_string_lossy().into_owned()).copied())
            .is_some_and(|(_, is_dir)| is_dir)
    });
    for dir in home_dirs {
        for file in GENERIC_FILES {
            if let Some(p) = ctx.home_join(&format!("{dir}/{file}")) {
                existing_file(&mut out.files, &seen, &p);
            }
        }
    }
    for file in project_files {
        existing_file(&mut out.files, &seen, &ctx.project_join(file));
    }
    for dir in home_dirs {
        for file in GENERIC_FILES {
            let Some(path) = ctx.home_join(&format!("{dir}/{file}")) else {
                continue;
            };
            let Some(text) = read_config_text(&path) else {
                continue;
            };
            let f = js(&path);
            match file {
                "config.toml" => parse_codex_toml(&text, &f, "user", &mut out),
                "hooks.json" => {
                    if let Some(value) = parse_json_file(&text) {
                        let (map, root) = if value["hooks"].is_object() {
                            (&value["hooks"], jp(&["hooks"]))
                        } else {
                            (&value, Vec::new())
                        };
                        collect_hooks_map(map, &f, "user", &mut out.hooks, &root);
                    }
                }
                _ => {
                    if let Some(value) = parse_json_file(&text) {
                        // mcp.json is a bare {name: server} map; settings/config
                        // nest it under mcpServers or mcp.
                        if file == "mcp.json" && !value["mcpServers"].is_object() {
                            mcp_map_entries(
                                &value,
                                "user",
                                &f,
                                &mut out.mcp_servers,
                                None,
                                &Vec::new(),
                            );
                        }
                        mcp_map_entries(
                            &value["mcpServers"],
                            "user",
                            &f,
                            &mut out.mcp_servers,
                            None,
                            &jp(&["mcpServers"]),
                        );
                        mcp_map_entries(
                            &value["mcp"],
                            "user",
                            &f,
                            &mut out.mcp_servers,
                            None,
                            &jp(&["mcp"]),
                        );
                    }
                }
            }
        }
    }
    for file in project_files {
        let path = ctx.project_join(file);
        let Some(text) = read_config_text(&path) else {
            continue;
        };
        let Some(value) = parse_json_file(&text) else {
            continue;
        };
        let f = js(&path);
        mcp_map_entries(
            &value["mcpServers"],
            "project",
            &f,
            &mut out.mcp_servers,
            None,
            &jp(&["mcpServers"]),
        );
        mcp_map_entries(
            &value["mcp"],
            "project",
            &f,
            &mut out.mcp_servers,
            None,
            &jp(&["mcp"]),
        );
        collect_hooks_map(
            &value["hooks"],
            &f,
            "project",
            &mut out.hooks,
            &jp(&["hooks"]),
        );
    }
    out
}

// ---- shared parsers -----------------------------------------------------------

/// Which flag flips an MCP server in a `{name: {...}}` map, if the provider
/// has a native one. `invert` covers negative flags like `disabled`.
struct McpToggleSpec {
    /// JSON path section holding the server object ("mcpServers", "mcp", …).
    /// Empty when the file itself is the server map.
    section: &'static str,
    member: &'static str,
    invert: bool,
}

/// Devin mcp_config.json: `mcpServers.<name>.disabled`.
const MCP_TOGGLE_DISABLED: McpToggleSpec = McpToggleSpec {
    section: "mcpServers",
    member: "disabled",
    invert: true,
};

/// opencode.json: `mcp.<name>.enabled`.
const MCP_TOGGLE_OPENCODE: McpToggleSpec = McpToggleSpec {
    section: "mcp",
    member: "enabled",
    invert: false,
};

/// opencode v2 nests servers under `mcp.servers.<name>`.
const MCP_TOGGLE_OPENCODE_NESTED: McpToggleSpec = McpToggleSpec {
    section: "mcp.servers",
    member: "enabled",
    invert: false,
};

/// Command may be a string (`"npx"`) or an argv array (`["npx","-y","x"]`).
fn mcp_command_parts(entry: &Value) -> (Option<String>, Vec<String>) {
    if let Some(s) = entry["command"].as_str() {
        let args: Vec<String> = entry["args"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| v.as_str().map(String::from))
            .collect();
        return (Some(s.to_string()), args);
    }
    let mut parts: Vec<String> = entry["command"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| v.as_str().map(String::from))
        .collect();
    let command = if parts.is_empty() {
        None
    } else {
        Some(parts.remove(0))
    };
    (command, parts)
}

/// Build a JSON member path from segments.
fn jp(segs: &[&str]) -> Vec<String> {
    segs.iter().map(|s| s.to_string()).collect()
}

/// `mcpServers`-style map: `{name: {command,args,env,url,type,disabled?}}`.
/// With `toggle`, entries expose the provider's native enable flag; without it
/// `disabled` is still read for display but no switch is offered. `section` is
/// the JSON path of the map itself inside `file` (empty for a root-level map)
/// and drives each entry's removal target.
fn mcp_map_entries(
    map_value: &Value,
    scope: &str,
    file: &str,
    out: &mut Vec<McpServerEntry>,
    toggle: Option<&McpToggleSpec>,
    section: &[String],
) {
    let Some(map) = map_value.as_object() else {
        return;
    };
    for (name, entry) in map {
        // Skip container objects (e.g. opencode v2 `mcp.servers`) — a server
        // entry carries at least one of these keys.
        let container = entry.is_object()
            && [
                "command",
                "url",
                "type",
                "enabled",
                "disabled",
                "env",
                "environment",
            ]
            .iter()
            .all(|k| entry[*k].is_null());
        if container {
            continue;
        }
        let (command, args) = mcp_command_parts(entry);
        let url = entry["url"].as_str().map(String::from);
        let kind = entry["type"].as_str().unwrap_or("");
        let transport = if url.is_some() {
            if kind.contains("sse") {
                "sse"
            } else {
                "http"
            }
        } else {
            "stdio"
        };
        let (member, invert) = toggle
            .map(|t| (t.member, t.invert))
            .unwrap_or(("disabled", true));
        // Absent flag means the default: `enabled` defaults true, `disabled`
        // defaults false — both resolve to enabled.
        let stored = entry[member].as_bool().unwrap_or(!invert);
        let env = if entry["env"].is_null() {
            &entry["environment"]
        } else {
            &entry["env"]
        };
        out.push(McpServerEntry {
            name: name.clone(),
            scope: scope.into(),
            file: file.into(),
            transport: transport.into(),
            summary: mcp_summary(command.as_deref(), &args, url.as_deref()),
            detail: env_count(Some(env)),
            enabled: Some(if invert { !stored } else { stored }),
            // Root-map files (empty section) can't be toggled — the first
            // path segment must be a known section.
            toggle: toggle.filter(|t| !t.section.is_empty()).map(|t| ToggleRef {
                file: file.into(),
                format: "json".into(),
                path: t
                    .section
                    .split('.')
                    .filter(|s| !s.is_empty())
                    .map(String::from)
                    .chain(std::iter::once(name.clone()))
                    .collect(),
                member: t.member.into(),
                invert: t.invert,
            }),
            remove: Some(RemoveRef {
                file: file.into(),
                format: "json".into(),
                path: section
                    .iter()
                    .cloned()
                    .chain(std::iter::once(name.clone()))
                    .collect(),
                array_item: None,
                expect: None,
            }),
        });
    }
}

/// Claude-style `{Event: [{matcher?, hooks:[{type,command,...}]}]}` maps.
/// `root` is the JSON path of the map inside `file`, so each hook's removal
/// target can be expressed as member/array-index path.
fn collect_hooks_map(
    hooks: &Value,
    file: &str,
    scope: &str,
    out: &mut Vec<HookEntry>,
    root: &[String],
) {
    let Some(map) = hooks.as_object() else {
        return;
    };
    // Index paths carry the scanned command as `expect` so removal
    // verifies the element still matches before cutting.
    let hook_remove = |segments: &[String], command: Option<&str>| RemoveRef {
        file: file.into(),
        format: "json".into(),
        path: root
            .iter()
            .cloned()
            .chain(segments.iter().cloned())
            .collect(),
        array_item: None,
        expect: command.map(String::from),
    };
    for (event, groups) in map {
        let Some(groups) = groups.as_array() else {
            continue;
        };
        for (gi, group) in groups.iter().enumerate() {
            let matcher = group["matcher"].as_str().map(String::from);
            if let Some(list) = group["hooks"].as_array() {
                for (hi, hook) in list.iter().enumerate() {
                    let kind = hook["type"].as_str().unwrap_or("command");
                    let command = hook["command"].as_str().or_else(|| hook["prompt"].as_str());
                    out.push(HookEntry {
                        event: event.clone(),
                        matcher: matcher.clone(),
                        kind: kind.into(),
                        command: command.map(String::from),
                        file: file.into(),
                        scope: scope.into(),
                        refs: Vec::new(),
                        remove: Some(hook_remove(
                            &[
                                event.clone(),
                                gi.to_string(),
                                "hooks".into(),
                                hi.to_string(),
                            ],
                            command,
                        )),
                    });
                }
            } else {
                // Flat entry: {command: "..."} without a nested hooks array.
                let command = group["command"]
                    .as_str()
                    .or_else(|| group["prompt"].as_str());
                if let Some(command) = command {
                    out.push(HookEntry {
                        event: event.clone(),
                        matcher: matcher.clone(),
                        kind: group["type"].as_str().unwrap_or("command").into(),
                        command: Some(command.to_string()),
                        file: file.into(),
                        scope: scope.into(),
                        refs: Vec::new(),
                        remove: Some(hook_remove(&[event.clone(), gi.to_string()], Some(command))),
                    });
                }
            }
        }
    }
}

/// Cursor-style flat `{event: [{command|prompt, matcher?}]}` maps.
fn collect_flat_hooks(
    hooks: &Value,
    file: &str,
    scope: &str,
    out: &mut Vec<HookEntry>,
    root: &[String],
) {
    let Some(map) = hooks.as_object() else {
        return;
    };
    for (event, list) in map {
        let Some(list) = list.as_array() else {
            continue;
        };
        for (i, entry) in list.iter().enumerate() {
            let command = entry["command"]
                .as_str()
                .or_else(|| entry["prompt"].as_str());
            if let Some(command) = command {
                out.push(HookEntry {
                    event: event.clone(),
                    matcher: entry["matcher"].as_str().map(String::from),
                    kind: entry["type"].as_str().unwrap_or("command").into(),
                    command: Some(command.to_string()),
                    file: file.into(),
                    scope: scope.into(),
                    refs: Vec::new(),
                    remove: Some(RemoveRef {
                        file: file.into(),
                        format: "json".into(),
                        path: root
                            .iter()
                            .cloned()
                            .chain([event.clone(), i.to_string()])
                            .collect(),
                        array_item: None,
                        expect: Some(command.to_string()),
                    }),
                });
            }
        }
    }
}

// ---- hook script refs ----------------------------------------------------------

fn shellish_tokens(command: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut cur = String::new();
    let mut quote = '\0';
    for c in command.chars() {
        if quote != '\0' {
            if c == quote {
                quote = '\0';
            } else {
                cur.push(c);
            }
            continue;
        }
        match c {
            '"' | '\'' | '`' => quote = c,
            ' ' | '\t' | '\n' | ';' | '|' | '&' | '>' | '<' | '(' | ')' => {
                if !cur.is_empty() {
                    tokens.push(std::mem::take(&mut cur));
                }
            }
            _ => cur.push(c),
        }
    }
    if !cur.is_empty() {
        tokens.push(cur);
    }
    tokens
}

const SCRIPT_EXTS: &[&str] = &[
    "sh", "bash", "zsh", "py", "js", "mjs", "cjs", "ts", "ps1", "command", "rb", "pl",
];

/// Absolute/relative script paths referenced by a hook command.
fn script_refs(command: &str, project: &Path, home: Option<&Path>) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let mut dynamic = 0usize;
    let mut resolved_tokens: HashSet<String> = HashSet::new();
    for token in shellish_tokens(command) {
        let token = token.trim();
        if token.is_empty() || token.contains('*') {
            continue;
        }
        let resolved: Option<PathBuf> = if let Some(rest) = token.strip_prefix("~/") {
            home.map(|h| h.join(rest))
        } else if token.starts_with("$HOME/") || token.starts_with("${HOME}/") {
            let rest = token.split('/').skip(1).collect::<Vec<_>>().join("/");
            home.map(|h| h.join(rest))
        } else if token.starts_with('$') {
            if token.contains('/') {
                dynamic += 1;
            }
            None
        } else if token.starts_with("//wsl.localhost/")
            || token.starts_with("//wsl$/")
            || token.starts_with('/')
            || token.contains(":\\")
        {
            Some(PathBuf::from(token))
        } else if (token.starts_with("./") || token.starts_with("../"))
            && token.rsplit('/').next().is_some_and(|f| f.contains('.'))
            || token.contains('/')
                && token
                    .rsplit('.')
                    .next()
                    .is_some_and(|ext| SCRIPT_EXTS.contains(&ext))
        {
            Some(project.join(token))
        } else {
            None
        };
        if let Some(path) = resolved {
            resolved_tokens.insert(token.to_string());
            if !out.contains(&path) {
                out.push(path);
            }
        }
        if out.len() + dynamic >= MAX_HOOK_REFS {
            break;
        }
    }
    // Dynamic tokens surface as unresolved refs so the UI can mark them.
    let mut result = out;
    for token in shellish_tokens(command) {
        if result.len() >= MAX_HOOK_REFS {
            break;
        }
        let token = token.trim();
        if token.starts_with('$')
            && token.contains('/')
            && !resolved_tokens.contains(token)
            && !result.iter().any(|p| p == &PathBuf::from(token))
        {
            result.push(PathBuf::from(token));
        }
    }
    result
}

/// Directory a hook's relative script refs resolve against: user-scope hooks
/// run next to their config file, project-scope hooks at the project root.
fn hook_base(hook: &HookEntry, project: &Path) -> PathBuf {
    if hook.scope == "user" {
        if let Some(parent) = Path::new(&hook.file).parent() {
            return parent.to_path_buf();
        }
    }
    project.to_path_buf()
}

/// Extract script paths from every hook command and check them in one batch.
fn resolve_hook_refs(inventory: &mut AgentConfigInventory, project: &Path, home: Option<&Path>) {
    // token path -> exists flag; dynamic ($VAR) paths keep exists=None.
    let mut wanted: Vec<PathBuf> = Vec::new();
    for provider in &inventory.providers {
        for hook in &provider.hooks {
            let Some(command) = &hook.command else {
                continue;
            };
            let base = hook_base(hook, project);
            for path in script_refs(command, &base, home) {
                if !wanted.contains(&path) {
                    wanted.push(path);
                }
            }
        }
    }
    let dynamic: HashSet<String> = wanted
        .iter()
        .filter(|p| p.to_string_lossy().starts_with('$'))
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    let concrete: Vec<PathBuf> = wanted
        .iter()
        .filter(|p| !dynamic.contains(&p.to_string_lossy().into_owned()))
        .cloned()
        .collect();
    let found = inspect_all(&concrete);
    for provider in &mut inventory.providers {
        for hook in &mut provider.hooks {
            let Some(command) = &hook.command else {
                continue;
            };
            let base = hook_base(hook, project);
            hook.refs = script_refs(command, &base, home)
                .into_iter()
                .map(|path| {
                    let key = path.to_string_lossy().into_owned();
                    let exists = if dynamic.contains(&key) {
                        None
                    } else {
                        Some(found.contains_key(&key))
                    };
                    HookRef {
                        path: js(&path),
                        exists,
                    }
                })
                .collect();
        }
    }
}

// ---- instructions -------------------------------------------------------------

fn discover_instructions(ctx: &Ctx) -> Vec<InstructionEntry> {
    let mut out: Vec<InstructionEntry> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    // path, kind, scope, consumers
    let mut candidates: Vec<(PathBuf, &str, &str, Vec<String>)> = Vec::new();

    // Project-scope rule files (root + ancestors up to home, bounded).
    let mut dirs: Vec<PathBuf> = Vec::new();
    for ancestor in ctx.project.ancestors() {
        if dirs.len() >= 8 {
            break;
        }
        if let Some(home) = &ctx.home {
            if ancestor == home.as_path() {
                break;
            }
        }
        dirs.push(ancestor.to_path_buf());
    }
    for dir in &dirs {
        for name in [
            "AGENTS.md",
            "AGENTS.local.md",
            "AGENT.md",
            "CLAUDE.md",
            "CLAUDE.local.md",
            "GEMINI.md",
            ".windsurfrules",
        ] {
            let consumers: Vec<String> = match name {
                "CLAUDE.md" | "CLAUDE.local.md" => {
                    CLAUDE_MD_READERS.iter().map(|s| s.to_string()).collect()
                }
                "GEMINI.md" => vec!["copilot".to_string()],
                "AGENT.md" => vec!["devin".to_string()],
                _ => AGENTS_MD_READERS.iter().map(|s| s.to_string()).collect(),
            };
            candidates.push((dir.join(name), "rules", "project", consumers));
        }
        for (rel, consumers) in [
            (".github/copilot-instructions.md", vec!["copilot"]),
            (".devin/global_rules.md", vec!["devin"]),
            (".codex/AGENTS.md", vec!["codex"]),
            (".opencode/AGENTS.md", vec!["opencode"]),
        ] {
            candidates.push((
                dir.join(rel),
                "rules",
                "project",
                consumers.iter().map(|s| s.to_string()).collect(),
            ));
        }
    }

    // User-scope rule files.
    if let Some(home) = &ctx.home {
        for (rel, consumers) in [
            (".claude/CLAUDE.md", CLAUDE_MD_READERS),
            (".codex/AGENTS.md", &["codex"][..]),
            (".config/devin/AGENTS.md", &["devin"][..]),
            (".config/devin/AGENT.md", &["devin"][..]),
            (".devin/global_rules.md", &["devin"][..]),
            (".omp/agent/AGENTS.md", &["omp"][..]),
            (".pi/agent/AGENTS.md", &["pi"][..]),
            (".agents/AGENTS.md", AGENTS_MD_READERS),
            (".grok/AGENTS.md", &["grok"][..]),
            (".config/opencode/AGENTS.md", &["opencode"][..]),
            (".copilot/copilot-instructions.md", &["copilot"][..]),
        ] {
            candidates.push((
                home.join(rel),
                "rules",
                "user",
                consumers.iter().map(|s| s.to_string()).collect(),
            ));
        }
    }

    // Rule directories: *.md / *.mdc inside.
    let rule_dirs: Vec<(PathBuf, &str, &[&str])> = {
        let mut v: Vec<(PathBuf, &str, &[&str])> = Vec::new();
        for dir in &dirs {
            v.extend([
                (
                    dir.join(".cursor/rules"),
                    "project",
                    &["cursor", "devin"][..],
                ),
                (dir.join(".windsurf/rules"), "project", &["devin"][..]),
                (dir.join(".devin/rules"), "project", &["devin"][..]),
                (
                    dir.join(".github/instructions"),
                    "project",
                    &["copilot"][..],
                ),
            ]);
        }
        if let Some(home) = &ctx.home {
            v.extend([
                (home.join(".devin/rules"), "user", &["devin"][..]),
                (home.join(".cursor/rules"), "user", &["cursor", "devin"][..]),
                (home.join(".windsurf/rules"), "user", &["devin"][..]),
                (home.join(".omp/agent"), "user", &["omp"][..]),
                (home.join(".pi/agent"), "user", &["pi"][..]),
                (home.join(".copilot/instructions"), "user", &["copilot"][..]),
            ]);
        }
        v
    };
    for (dir, scope, consumers) in &rule_dirs {
        for entry in list_dir(dir) {
            if entry.is_dir
                || !(entry.name.ends_with(".md") || entry.name.ends_with(".mdc"))
                || entry.name.starts_with('.')
            {
                continue;
            }
            candidates.push((
                PathBuf::from(&entry.path),
                "rules",
                scope,
                consumers.iter().map(|s| s.to_string()).collect(),
            ));
        }
    }

    // Subagent definitions.
    let agent_dirs: Vec<(PathBuf, &str, &[&str])> = {
        let mut v: Vec<(PathBuf, &str, &[&str])> = vec![
            (
                ctx.project_join(".claude/agents"),
                "project",
                &["claude", "cursor"][..],
            ),
            (ctx.project_join(".devin/agents"), "project", &["devin"][..]),
            (
                ctx.project_join(".codex/agents"),
                "project",
                &["codex", "cursor"][..],
            ),
            (
                ctx.project_join(".cursor/agents"),
                "project",
                &["cursor"][..],
            ),
            (
                ctx.project_join(".opencode/agents"),
                "project",
                &["opencode"][..],
            ),
            (
                ctx.project_join(".agents/agents"),
                "project",
                &["devin"][..],
            ),
            (
                ctx.project_join(".github/agents"),
                "project",
                &["copilot"][..],
            ),
        ];
        if let Some(home) = &ctx.home {
            v.extend([
                (
                    home.join(".claude/agents"),
                    "user",
                    &["claude", "cursor"][..],
                ),
                (home.join(".codex/agents"), "user", &["codex", "cursor"][..]),
                (home.join(".cursor/agents"), "user", &["cursor"][..]),
                (home.join(".copilot/agents"), "user", &["copilot"][..]),
                (
                    home.join(".config/opencode/agents"),
                    "user",
                    &["opencode"][..],
                ),
                (home.join(".omp/agent/agents"), "user", &["omp"][..]),
                (home.join(".pi/agent/agents"), "user", &["pi"][..]),
                (home.join(".config/devin/agents"), "user", &["devin"][..]),
            ]);
        }
        v
    };
    for (dir, scope, consumers) in &agent_dirs {
        for entry in list_dir(dir) {
            if entry.is_dir || entry.name.starts_with('.') {
                continue;
            }
            if !(entry.name.ends_with(".md")
                || entry.name.ends_with(".toml")
                || entry.name.ends_with(".yaml"))
            {
                continue;
            }
            candidates.push((
                PathBuf::from(&entry.path),
                "subagent",
                scope,
                consumers.iter().map(|s| s.to_string()).collect(),
            ));
        }
    }

    // Slash-command folders (file-defined commands).
    let command_dirs: Vec<(PathBuf, &str, &[&str])> = {
        let mut v: Vec<(PathBuf, &str, &[&str])> = vec![
            (
                ctx.project_join(".claude/commands"),
                "project",
                &["claude"][..],
            ),
            (
                ctx.project_join(".cursor/commands"),
                "project",
                &["cursor"][..],
            ),
            (
                ctx.project_join(".opencode/commands"),
                "project",
                &["opencode"][..],
            ),
            (
                ctx.project_join(".opencode/command"),
                "project",
                &["opencode"][..],
            ),
        ];
        if let Some(home) = &ctx.home {
            v.extend([
                (home.join(".claude/commands"), "user", &["claude"][..]),
                (home.join(".codex/prompts"), "user", &["codex"][..]),
                (home.join(".cursor/commands"), "user", &["cursor"][..]),
                (
                    home.join(".config/opencode/commands"),
                    "user",
                    &["opencode"][..],
                ),
                (
                    home.join(".config/opencode/command"),
                    "user",
                    &["opencode"][..],
                ),
            ]);
        }
        v
    };
    for (dir, scope, consumers) in &command_dirs {
        for entry in list_dir(dir) {
            if entry.is_dir || !entry.name.ends_with(".md") || entry.name.starts_with('.') {
                continue;
            }
            candidates.push((
                PathBuf::from(&entry.path),
                "command",
                scope,
                consumers.iter().map(|s| s.to_string()).collect(),
            ));
        }
    }

    // One batched existence/size pass for every candidate.
    let existing = probe(
        &candidates
            .iter()
            .map(|(p, _, _, _)| p.clone())
            .collect::<Vec<_>>(),
    );
    for (path, kind, scope, consumers) in candidates {
        if out.len() >= MAX_INSTRUCTION_FILES {
            break;
        }
        let key = path.to_string_lossy().into_owned();
        let Some((size, is_dir)) = existing.get(&key) else {
            continue;
        };
        if *is_dir {
            continue;
        }
        push_instruction(&mut out, &mut seen, path, kind, scope, &consumers, *size);
    }

    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

fn push_instruction(
    out: &mut Vec<InstructionEntry>,
    seen: &mut HashSet<String>,
    path: PathBuf,
    kind: &str,
    scope: &str,
    consumers: &[String],
    size: u64,
) {
    if out.len() >= MAX_INSTRUCTION_FILES {
        return;
    }
    let key = path.to_string_lossy().into_owned();
    if !seen.insert(key) {
        return;
    }
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();
    out.push(InstructionEntry {
        path: js(&path),
        name,
        kind: kind.into(),
        scope: scope.into(),
        consumers: consumers.to_vec(),
        size,
    });
}

// ---- set_enabled ---------------------------------------------------------------

/// Serializes config mutations: every change is an unlocked
/// read-modify-write, so overlapping invokes on the same file would
/// resurrect entries or drop flags.
static CONFIG_MUTATION: Mutex<()> = Mutex::new(());

/// `cwd` is the trust root for the project bound — the frontend passes the
/// open project's path, but invoke args are not trusted input. Refuse a root
/// filesystem identity, which would make every path "within the project".
fn checked_project(cwd: &str) -> Result<PathBuf, String> {
    let project = expand_home(cwd);
    match wsl::path_location(&project) {
        Ok(Some(location)) => {
            if location.path == "/" || location.path.is_empty() {
                return Err("Refusing a filesystem root as the project path".into());
            }
        }
        Ok(None) => {
            let canonical = project
                .canonicalize()
                .map_err(|_| "Project path does not exist".to_string())?;
            if !canonical.is_dir() || canonical.parent().is_none() {
                return Err("Refusing a filesystem root as the project path".into());
            }
            return Ok(canonical);
        }
        Err(e) => return Err(e),
    }
    Ok(project)
}

/// Basenames of files the inventory itself may offer for removal, and
/// directory names whose immediate children are removable (extension/plugin
/// files, rules, agent files, hook files, provider config files). Keeps
/// `format: "file"` removal from renaming arbitrary files or directories —
/// `~`, `~/.ssh`, `.git` all fail this check.
fn known_removable_file(path: &Path) -> bool {
    const KNOWN_FILES: &[&str] = &[
        ".claude.json",
        ".cursorrules",
        ".fx.json",
        ".mcp.json",
        ".windsurfrules",
        "agent.md",
        "agents.md",
        "claude.md",
        "config.json",
        "config.toml",
        "config.yml",
        "config.yaml",
        "copilot-instructions.md",
        "gemini.md",
        "hooks.json",
        "hooks.v1.json",
        "installed_plugins.json",
        "mcp-config.json",
        "mcp.json",
        "mcp.jsonc",
        "mcp_config.json",
        "opencode.json",
        "opencode.jsonc",
        "package.json",
        "settings.json",
        "settings.local.json",
        "managed-settings.json",
    ];
    const KNOWN_PARENTS: &[&str] = &[
        ".devin",
        ".github",
        ".opencode",
        ".vscode",
        "agent",
        "agents",
        "command",
        "commands",
        "extensions",
        "hooks",
        "instructions",
        "plugins",
        "rules",
        "skills",
        "copilot",
        "muse",
        "opencode",
    ];
    const KNOWN_EXTS: &[&str] = &[
        "json", "jsonc", "toml", "yml", "yaml", "md", "mdc", "ts", "js",
    ];
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_lowercase();
    if KNOWN_FILES.contains(&name.as_str()) || name.ends_with(".mdc") {
        return true;
    }
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    // Directories (plugin/extension dirs have no extension) are fine under a
    // known parent; files need a config/text extension too.
    if !ext.is_empty() && !KNOWN_EXTS.contains(&ext.as_str()) {
        return false;
    }
    path.parent()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        .is_some_and(|p| KNOWN_PARENTS.contains(&p.to_lowercase().as_str()))
}

/// Whether `file` sits beneath `root`, comparing canonical paths on the host
/// and (distribution, linux path) pairs for WSL identities.
fn path_within(file: &Path, root: &Path) -> bool {
    match (wsl::path_location(file), wsl::path_location(root)) {
        (Ok(Some(f)), Ok(Some(r))) => {
            f.distribution.eq_ignore_ascii_case(&r.distribution)
                && Path::new(&f.path).starts_with(&r.path)
        }
        (Ok(None), Ok(None)) => {
            let f = file.canonicalize().unwrap_or_else(|_| file.to_path_buf());
            let r = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
            f.starts_with(&r)
        }
        _ => false,
    }
}

/// Write-binding for toggles: the member must be a known enable flag inside a
/// known section, and the file must live under the project or home directory
/// of the execution host being scanned.
fn toggle_allowed(
    toggle: &ToggleRequest,
    path: &Path,
    project: &Path,
    home: Option<&Path>,
) -> Result<(), String> {
    if toggle.path.len() > 8 || toggle.path.iter().any(|s| s.is_empty() || s == "..") {
        return Err("Invalid config path".into());
    }
    if toggle.member.is_empty() || toggle.member.len() > 160 {
        return Err("Invalid config member".into());
    }
    let section = toggle.path.first().map(String::as_str).unwrap_or("");
    let section_ok = match toggle.format.as_str() {
        "json" => matches!(
            section,
            "mcpServers" | "mcp" | "mcp_servers" | "enabledPlugins"
        ),
        "toml" => matches!(section, "mcp_servers" | "plugins"),
        _ => return Err(format!("Unsupported config format: {}", toggle.format)),
    };
    if !section_ok {
        return Err("This config section cannot be toggled".into());
    }
    if !matches!(toggle.member.as_str(), "enabled" | "disabled") && section != "enabledPlugins" {
        return Err("Only enable/disable flags can be toggled".into());
    }
    // Reject `..`/`.` components outright — a lexical `starts_with` check
    // alone would let `~/../../etc` escape the intended boundary.
    if !path.is_absolute()
        || path.components().any(|c| {
            matches!(
                c,
                std::path::Component::ParentDir | std::path::Component::CurDir
            )
        })
    {
        return Err("Invalid config file path".into());
    }
    if !path_within(path, project) && !home.is_some_and(|h| path_within(path, h)) {
        return Err("Refusing to write outside the project and home directory".into());
    }
    Ok(())
}

#[tauri::command(async)]
pub fn agent_config_set_enabled(
    cwd: String,
    toggle: ToggleRequest,
    enabled: bool,
) -> Result<(), String> {
    let _guard = CONFIG_MUTATION
        .lock()
        .map_err(|_| "Config mutation lock poisoned".to_string())?;
    let project = checked_project(&cwd)?;
    let home = home_for(&project);
    let path = expand_home(&toggle.file);
    toggle_allowed(&toggle, &path, &project, home.as_deref())?;
    let text = read_config_text(&path).ok_or("Config file could not be read")?;
    let value = if toggle.invert { !enabled } else { enabled };
    let next = match toggle.format.as_str() {
        "json" => set_json_bool(&text, &toggle.path, &toggle.member, value)?,
        "toml" => set_toml_bool(&text, &toggle.path, &toggle.member, value)?,
        other => return Err(format!("Unsupported config format: {other}")),
    };
    if next == text {
        return Ok(());
    }
    // Never leave a syntactically broken file behind.
    if toggle.format == "json" && parse_json_file(&next).is_none() {
        return Err("Toggle would produce invalid JSON — aborted".into());
    }
    // Keep a pre-edit copy next to the file so a bad edit is recoverable —
    // and refuse to write without it.
    let backup = path.with_file_name(format!(
        "{}.monocode-bak",
        path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("config")
    ));
    write_config_text(&backup, &text)?;
    write_config_text(&path, &next)
}

/// Sections whose members/tables may be removed, mirroring `toggle_allowed`.
/// Dedicated map files (`mcp.json`, `hooks.json`, …) and files inside a
/// `hooks/` directory are themselves entry maps, so any top-level member
/// counts as a removable entry.
fn remove_allowed(
    remove: &RemoveRef,
    path: &Path,
    project: &Path,
    home: Option<&Path>,
) -> Result<(), String> {
    if remove.path.len() > 8 || remove.path.iter().any(|s| s.is_empty() || s == "..") {
        return Err("Invalid config path".into());
    }
    if !path.is_absolute()
        || path.components().any(|c| {
            matches!(
                c,
                std::path::Component::ParentDir | std::path::Component::CurDir
            )
        })
    {
        return Err("Invalid config file path".into());
    }
    if !path_within(path, project) && !home.is_some_and(|h| path_within(path, h)) {
        return Err("Refusing to write outside the project and home directory".into());
    }
    if remove.format == "file" {
        // File removal renames to <name>.monocode-bak — recoverable — but the
        // target must still be a file the inventory could have produced: a
        // known config name or a child of a known extension dir. The project
        // and home roots themselves are never removable.
        if path == project || home.is_some_and(|h| path == h) {
            return Err("Refusing to remove the project or home directory".into());
        }
        if !known_removable_file(path) {
            return Err("This file cannot be removed from here".into());
        }
        return Ok(());
    }
    let section = remove.path.first().map(String::as_str).unwrap_or("");
    let section_ok = match remove.format.as_str() {
        "json" => matches!(
            section,
            "mcpServers"
                | "mcp"
                | "mcp_servers"
                | "servers"
                | "plugin"
                | "plugins"
                | "packages"
                | "extensions"
                | "hooks"
                | "pi"
                | "projects"
                | "enabledPlugins"
                | "enabledMcpjsonServers"
                | "disabledMcpjsonServers"
        ),
        "toml" => matches!(
            section,
            "mcp_servers" | "plugins" | "marketplaces" | "hooks" | "notify"
        ),
        other => return Err(format!("Unsupported config format: {other}")),
    };
    if section_ok {
        // Whitelisted sections are maps/arrays — a removal must address an
        // entry inside them (`["mcpServers", "x"]`, `["plugin"]` + array_item),
        // never the section itself. `projects` in particular would wipe every
        // per-project approval in ~/.claude.json at depth 1.
        let minimum = if remove.array_item.is_some() || section == "notify" {
            1
        } else {
            2
        };
        if remove.path.len() < minimum {
            return Err("Only entries inside a config section can be removed".into());
        }
        return Ok(());
    }
    let dedicated = remove.format == "json"
        && (path.file_name().and_then(|n| n.to_str()).is_some_and(|n| {
            matches!(
                n,
                "mcp.json" | "mcp_config.json" | "mcp.jsonc" | "hooks.json" | "hooks.v1.json"
            )
        }) || path
            .parent()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            == Some("hooks"));
    if dedicated {
        return Ok(());
    }
    Err("This config section cannot be removed".into())
}

/// Rename a file to `<name>.monocode-bak` so removal stays recoverable.
fn remove_config_file(path: &Path) -> Result<(), String> {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("Invalid file path")?;
    let mut last_err = "Could not rename file".to_string();
    for i in 0..10 {
        let candidate = if i == 0 {
            format!("{name}.monocode-bak")
        } else {
            format!("{name}.monocode-bak-{i}")
        };
        match rename_path_sync(&path.to_string_lossy(), &candidate) {
            Ok(_) => return Ok(()),
            Err(e) => {
                if !e.to_lowercase().contains("exist") {
                    return Err(e);
                }
                last_err = e;
            }
        }
    }
    Err(last_err)
}

#[tauri::command(async)]
pub fn agent_config_remove(cwd: String, remove: RemoveRef) -> Result<(), String> {
    let _guard = CONFIG_MUTATION
        .lock()
        .map_err(|_| "Config mutation lock poisoned".to_string())?;
    let project = checked_project(&cwd)?;
    let home = home_for(&project);
    let path = expand_home(&remove.file);
    remove_allowed(&remove, &path, &project, home.as_deref())?;
    if remove.format == "file" {
        return remove_config_file(&path);
    }
    let text = read_config_text(&path).ok_or("Config file could not be read")?;
    let next = match remove.format.as_str() {
        "json" => match &remove.array_item {
            Some(item) => remove_json_array_item(&text, &remove.path, item)?,
            None => remove_json_at(&text, &remove.path, remove.expect.as_deref())?,
        },
        "toml" => remove_toml(&text, &remove.path, remove.array_item.as_deref())?,
        other => return Err(format!("Unsupported config format: {other}")),
    };
    if next == text {
        return Err("Entry not found in config file".into());
    }
    // Never leave a syntactically broken file behind.
    if remove.format == "json" && parse_json_file(&next).is_none() {
        return Err("Removal would produce invalid JSON — aborted".into());
    }
    let backup = path.with_file_name(format!(
        "{}.monocode-bak",
        path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("config")
    ));
    write_config_text(&backup, &text)?;
    write_config_text(&path, &next)
}

// ---------------------------------------------------------------------------
// tests

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_bool_replaces_existing() {
        let text = "{\n  \"mcp\": {\n    \"a\": { \"enabled\": true }\n  }\n}";
        let next = set_json_bool(text, &["mcp".into(), "a".into()], "enabled", false).unwrap();
        assert!(next.contains("\"enabled\": false"));
        let reparsed: Value = serde_json::from_str(&next).unwrap();
        assert_eq!(reparsed["mcp"]["a"]["enabled"], false);
    }

    #[test]
    fn json_bool_inserts_missing_member() {
        let text = "{\n  \"mcp\": {\n    \"a\": {\n      \"command\": [\"x\"]\n    }\n  }\n}";
        let next = set_json_bool(text, &["mcp".into(), "a".into()], "enabled", false).unwrap();
        let reparsed: Value = serde_json::from_str(&next).unwrap();
        assert_eq!(reparsed["mcp"]["a"]["enabled"], false);
        // Existing formatting of other members is preserved.
        assert!(next.contains("\"command\": [\"x\"]"));
    }

    #[test]
    fn json_bool_handles_comments() {
        let text = "{\n  // user comment\n  \"mcp\": { \"a\": {\"enabled\": true} }\n}";
        let next = set_json_bool(text, &["mcp".into(), "a".into()], "enabled", false).unwrap();
        assert!(next.contains("// user comment"));
        assert!(next.contains("\"enabled\": false"));
    }

    #[test]
    fn json_bool_handles_quoted_member() {
        let text = "{\"enabledPlugins\": {\"foo@bar\": true}}";
        let next = set_json_bool(text, &["enabledPlugins".into()], "foo@bar", false).unwrap();
        let reparsed: Value = serde_json::from_str(&next).unwrap();
        assert_eq!(reparsed["enabledPlugins"]["foo@bar"], false);
    }

    #[test]
    fn strip_comments_preserves_strings() {
        let text = "{\"u\": \"http://x//y\", \"b\": 1 /* note */}";
        let stripped = strip_json_comments(text);
        let value: Value = serde_json::from_str(&stripped).unwrap();
        assert_eq!(value["u"], "http://x//y");
        assert_eq!(value["b"], 1);
    }

    #[test]
    fn toml_tables_parse_quoted_segments() {
        let text = "[mcp_servers.a]\ncommand = \"x\"\n\n[plugins.\"b@c\"]\nenabled = true\n";
        let tables = toml_tables(text);
        assert_eq!(tables[0].path, vec!["mcp_servers", "a"]);
        assert_eq!(tables[1].path, vec!["plugins", "b@c"]);
    }

    #[test]
    fn toml_set_bool_replaces_and_inserts() {
        let text = "[mcp_servers.a]\ncommand = \"x\"\nenabled = true # keep me\n\n[mcp_servers.b]\nurl = \"u\"\n";
        let next =
            set_toml_bool(text, &["mcp_servers".into(), "a".into()], "enabled", false).unwrap();
        assert!(next.contains("enabled = false # keep me"));
        let next2 =
            set_toml_bool(text, &["mcp_servers".into(), "b".into()], "enabled", false).unwrap();
        assert!(next2.contains("[mcp_servers.b]\nenabled = false\nurl = \"u\""));
    }

    #[test]
    fn toml_get_reads_multiline_array() {
        let body = "args = [\n  \"mcp\",\n  \"--host=codex\",\n]\nenabled = false\n";
        let args = toml_get(body, "args").unwrap();
        assert!(args.contains("\"mcp\""));
        assert_eq!(toml_bool_value(body, "enabled"), Some(false));
    }

    #[test]
    fn script_refs_extracts_paths() {
        let project = Path::new("/repo");
        let home = Path::new("/home/u");
        let refs = script_refs(
            "if [ -x \"$X/y.sh\" ]; then /abs/executor.sh; ~/rel.sh; ./scripts/e.sh; fi",
            project,
            Some(home),
        );
        assert!(refs.contains(&PathBuf::from("/abs/executor.sh")));
        assert!(refs.contains(&PathBuf::from("/home/u/rel.sh")));
        assert!(refs.contains(&PathBuf::from("/repo/scripts/e.sh")));
    }

    #[test]
    fn hooks_map_collects_nested() {
        let value: Value = serde_json::from_str(
            r#"{"PreToolUse":[{"matcher":"exec","hooks":[{"type":"command","command":"./x.sh"}]}]}"#,
        )
        .unwrap();
        let mut out = Vec::new();
        collect_hooks_map(&value, "f", "project", &mut out, &Vec::new());
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].event, "PreToolUse");
        assert_eq!(out[0].matcher.as_deref(), Some("exec"));
    }

    #[test]
    fn json_spans_survives_bare_slash() {
        let spans = json_spans("{\"a\": 1 / 2}").unwrap();
        assert!(spans.len() >= 4);
    }

    #[test]
    fn toml_comment_inside_string_is_not_a_comment() {
        let body = "command = \"run #me\"\nenabled = true\n";
        assert_eq!(toml_get(body, "command").as_deref(), Some("\"run #me\""));
    }

    #[test]
    fn toggle_binding_restricts_writes() {
        let project = Path::new("/repo");
        let home = Path::new("/home/u");
        let toggle = ToggleRequest {
            file: "/home/u/.codex/config.toml".into(),
            format: "toml".into(),
            path: vec!["mcp_servers".into(), "x".into()],
            member: "enabled".into(),
            invert: false,
        };
        assert!(toggle_allowed(
            &toggle,
            Path::new("/home/u/.codex/config.toml"),
            project,
            Some(home)
        )
        .is_ok());

        // Outside both roots is refused.
        assert!(toggle_allowed(&toggle, Path::new("/etc/passwd"), project, Some(home)).is_err());

        // Unknown sections are refused even under home.
        let other = ToggleRequest {
            file: "/home/u/app/settings.json".into(),
            format: "json".into(),
            path: vec!["theme".into()],
            member: "enabled".into(),
            invert: false,
        };
        assert!(toggle_allowed(
            &other,
            Path::new("/home/u/app/settings.json"),
            project,
            Some(home)
        )
        .is_err());
    }

    #[test]
    fn toggle_rejects_dotdot_and_relative_files() {
        let project = Path::new("/repo");
        let home = Path::new("/home/u");
        let toggle = ToggleRequest {
            file: "x".into(),
            format: "json".into(),
            path: vec!["mcpServers".into(), "a".into()],
            member: "enabled".into(),
            invert: false,
        };
        // `..` inside an in-bounds-looking prefix still escapes.
        assert!(toggle_allowed(
            &toggle,
            Path::new("/home/u/../etc/config.json"),
            project,
            Some(home)
        )
        .is_err());
        // Relative paths are never writable.
        assert!(toggle_allowed(&toggle, Path::new("cfg/x.json"), project, Some(home)).is_err());
    }

    #[test]
    fn toml_set_bool_keeps_line_endings() {
        // CRLF input keeps CRLF on replace.
        let text = "[mcp_servers.a]\r\nenabled = true\r\n";
        let next =
            set_toml_bool(text, &["mcp_servers".into(), "a".into()], "enabled", false).unwrap();
        assert!(next.contains("enabled = false\r\n"));
        assert!(!next.contains('\n') || next.matches('\n').count() == next.matches("\r\n").count());

        // Member replace on a final line without trailing newline does not
        // glue the next content onto it.
        let eof = "[mcp_servers.a]\nenabled = true";
        let next =
            set_toml_bool(eof, &["mcp_servers".into(), "a".into()], "enabled", false).unwrap();
        assert_eq!(next, "[mcp_servers.a]\nenabled = false");

        // Insert after a header line that ends the file without a newline.
        let bare = "[mcp_servers.a]";
        let next =
            set_toml_bool(bare, &["mcp_servers".into(), "a".into()], "enabled", false).unwrap();
        assert_eq!(next, "[mcp_servers.a]\nenabled = false\n");
    }

    #[test]
    fn toml_set_bool_skips_multiline_values() {
        let text = "[mcp_servers.a]\nargs = [\n  \"enabled = false\",\n]\nenabled = true\n";
        let next =
            set_toml_bool(text, &["mcp_servers".into(), "a".into()], "enabled", false).unwrap();
        // The real flag flips; the lookalike inside the array is untouched.
        assert!(next.contains("\"enabled = false\""));
        assert!(next.trim_end().ends_with("enabled = false"));
    }

    #[test]
    fn toml_header_with_comment_and_array_tables() {
        let text =
            "# top\n[mcp_servers.a] # inline\nenabled = true\n[[plugins.b]]\nenabled = true\n";
        let tables = toml_tables(text);
        assert_eq!(tables[0].path, vec!["mcp_servers", "a"]);
        assert_eq!(tables[1].path, vec!["plugins", "b"]);
        let next =
            set_toml_bool(text, &["mcp_servers".into(), "a".into()], "enabled", false).unwrap();
        assert!(next.contains("[mcp_servers.a] # inline\nenabled = false"));
    }

    #[test]
    fn jsonc_trailing_comma_keeps_utf8() {
        // Multibyte characters must survive comment/comma stripping.
        let text = "{\n  \"n\": \"héllo—✓\",\n}\n";
        let value = parse_json_file(text).unwrap();
        assert_eq!(value["n"], "héllo—✓");
    }

    #[test]
    fn mcp_map_skips_containers_and_reads_arrays() {
        let value: Value = serde_json::from_str(
            r#"{"mcp": {
                "servers": {"inner": {"command": "x"}},
                "real": {"command": ["npx", "-y", "srv"], "enabled": false, "environment": {"A": "1"}}
            }}"#,
        )
        .unwrap();
        let mut out = Vec::new();
        mcp_map_entries(
            &value["mcp"],
            "user",
            "f.json",
            &mut out,
            Some(&MCP_TOGGLE_OPENCODE),
            &jp(&["mcp"]),
        );
        // "servers" is a container, not a server named "servers".
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].name, "real");
        assert_eq!(out[0].summary, "npx -y srv");
        assert_eq!(out[0].enabled, Some(false));
        assert_eq!(
            out[0].toggle.as_ref().map(|t| t.path.clone()),
            Some(vec!["mcp".to_string(), "real".to_string()])
        );

        // Nested v2 layout gets the deeper toggle path.
        let mut nested = Vec::new();
        mcp_map_entries(
            &value["mcp"]["servers"],
            "user",
            "f.json",
            &mut nested,
            Some(&MCP_TOGGLE_OPENCODE_NESTED),
            &jp(&["mcp", "servers"]),
        );
        assert_eq!(
            nested[0].toggle.as_ref().map(|t| t.path.clone()),
            Some(vec!["mcp".into(), "servers".into(), "inner".into()])
        );
    }

    #[test]
    fn hooks_map_collects_flat_with_prompt_and_matcher() {
        let value: Value = serde_json::from_str(
            r#"{"SessionStart":[{"matcher":"boot","prompt":"say hi","type":"prompt"}]}"#,
        )
        .unwrap();
        let mut out = Vec::new();
        collect_hooks_map(&value, "f", "user", &mut out, &Vec::new());
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].command.as_deref(), Some("say hi"));
        assert_eq!(out[0].matcher.as_deref(), Some("boot"));
        assert_eq!(out[0].kind, "prompt");
    }

    #[test]
    fn hook_base_resolves_by_scope() {
        let project = Path::new("/repo");
        let mut hook = HookEntry {
            event: "e".into(),
            matcher: None,
            kind: "command".into(),
            command: None,
            file: "/home/u/.claude/settings.json".into(),
            scope: "user".into(),
            refs: Vec::new(),
            remove: None,
        };
        // User hooks resolve relative to the settings file's dir.
        assert_eq!(hook_base(&hook, project), PathBuf::from("/home/u/.claude"));
        // Project/local hooks resolve relative to the project root.
        hook.scope = "project".into();
        assert_eq!(hook_base(&hook, project), project);
        hook.scope = "local".into();
        assert_eq!(hook_base(&hook, project), project);
    }

    #[test]
    fn json_remove_member_positions() {
        // First, middle and last members all cut cleanly with one comma.
        let text = "{\n  \"a\": 1,\n  \"b\": 2,\n  \"c\": 3\n}";
        for key in ["a", "b", "c"] {
            let next = remove_json_at(text, &[key.into()], None).unwrap();
            let reparsed: Value = serde_json::from_str(&next).unwrap();
            assert!(reparsed.get(key).is_none(), "{key} still present");
            assert_eq!(reparsed.as_object().unwrap().len(), 2);
        }
        let next = remove_json_at(text, &["b".into()], None).unwrap();
        let reparsed: Value = serde_json::from_str(&next).unwrap();
        assert_eq!(reparsed, serde_json::json!({"a": 1, "c": 3}));
        // Single-line object keeps it single-line.
        let flat = "{\"a\": 1, \"b\": 2}";
        assert_eq!(
            remove_json_at(flat, &["a".into()], None).unwrap(),
            "{ \"b\": 2}"
        );
    }

    #[test]
    fn json_remove_nested_and_array_index() {
        // Nested member and array-index descent (hook-style paths).
        let text = r#"{"mcpServers": {"a": {"command": "x"}, "b": {"url": "u"}},
            "hooks": {"Pre": [{"matcher": "m", "hooks": [{"type": "command", "command": "one"}, {"type": "command", "command": "two"}]}]}}"#;
        let next = remove_json_at(text, &jp(&["mcpServers", "a"]), None).unwrap();
        let reparsed: Value = serde_json::from_str(&next).unwrap();
        assert!(reparsed["mcpServers"].get("a").is_none());
        assert!(reparsed["mcpServers"].get("b").is_some());

        let path = jp(&["hooks", "Pre", "0", "hooks", "0"]);
        let next = remove_json_at(text, &path, None).unwrap();
        let reparsed: Value = serde_json::from_str(&next).unwrap();
        let hooks = reparsed["hooks"]["Pre"][0]["hooks"].as_array().unwrap();
        assert_eq!(hooks.len(), 1);
        assert_eq!(hooks[0]["command"], "two");
    }

    #[test]
    fn json_remove_array_item_forms() {
        // String elements, "-disabled" markers, and {package} objects.
        let text = r#"{"plugin": ["a", "-b", {"package": "c", "options": {}}]}"#;
        for (item, gone) in [("a", "a"), ("b", "b"), ("c", "c")] {
            let next = remove_json_array_item(text, &jp(&["plugin"]), item).unwrap();
            let reparsed: Value = serde_json::from_str(&next).unwrap();
            let list = reparsed["plugin"].as_array().unwrap();
            assert_eq!(list.len(), 2);
            assert!(!list
                .iter()
                .any(|v| v.as_str() == Some(gone) || v["package"].as_str() == Some(gone)));
        }
    }

    #[test]
    fn json_remove_keeps_utf8_and_comments() {
        let text = "{\n  // keep me\n  \"n\": \"héllo—✓\",\n  \"m\": 1\n}";
        let next = remove_json_at(text, &["n".into()], None).unwrap();
        assert!(next.contains("// keep me"));
        let reparsed = parse_json_file(&next).unwrap();
        assert_eq!(reparsed, serde_json::json!({"m": 1}));
    }

    #[test]
    fn toml_remove_table_member_and_list_item() {
        let text = "# top\n[mcp_servers.a]\nenabled = true\n\n[mcp_servers.b]\ncommand = \"x\"\n\n[plugins]\nenabled = [\"one\", \"two\"]\n";
        // Whole-table removal keeps the other table and the header comment.
        let next = remove_toml(text, &jp(&["mcp_servers", "a"]), None).unwrap();
        assert!(!next.contains("mcp_servers.a"));
        assert!(next.contains("# top"));
        assert!(next.contains("[mcp_servers.b]"));
        // Member-line removal.
        let next = remove_toml(text, &jp(&["mcp_servers", "b", "command"]), None).unwrap();
        assert!(next.contains("[mcp_servers.b]"));
        assert!(!next.contains("command = \"x\""));
        // List-element removal.
        let next = remove_toml(text, &jp(&["plugins", "enabled"]), Some("one")).unwrap();
        assert!(next.contains("enabled = [ \"two\"]") || next.contains("\"two\""));
        assert!(!next.contains("\"one\""));
        // Root member (notify) removal.
        let notify = "notify = \"x.sh\"\n[mcp_servers.a]\nenabled = true\n";
        let next = remove_toml(notify, &jp(&["notify"]), None).unwrap();
        assert!(!next.contains("notify"));
        assert!(next.contains("[mcp_servers.a]"));
    }

    #[test]
    fn toml_remove_array_table_by_name() {
        let text = "[[hooks.a]]\ncommand = \"one\"\n\n[[hooks.a]]\ncommand = \"two\"\n";
        let next = remove_toml(text, &jp(&["hooks", "a"]), Some("one")).unwrap();
        assert!(!next.contains("\"one\""));
        assert!(next.contains("command = \"two\""));
    }

    #[test]
    fn remove_binding_restricts_targets() {
        let project = Path::new("/repo");
        let home = Path::new("/home/u");
        let entry = RemoveRef {
            file: "/home/u/.codex/config.toml".into(),
            format: "toml".into(),
            path: jp(&["mcp_servers", "x"]),
            array_item: None,
            expect: None,
        };
        assert!(remove_allowed(
            &entry,
            Path::new("/home/u/.codex/config.toml"),
            project,
            Some(home)
        )
        .is_ok());
        // Outside project/home is refused.
        assert!(remove_allowed(&entry, Path::new("/etc/x"), project, Some(home)).is_err());
        // `..` components are refused even under home.
        assert!(
            remove_allowed(&entry, Path::new("/home/u/../etc/x"), project, Some(home)).is_err()
        );
        // Unknown sections are refused.
        let other = RemoveRef {
            file: "/home/u/app/settings.json".into(),
            format: "json".into(),
            path: jp(&["theme"]),
            array_item: None,
            expect: None,
        };
        assert!(remove_allowed(
            &other,
            Path::new("/home/u/app/settings.json"),
            project,
            Some(home)
        )
        .is_err());
        // Dedicated map files accept root members.
        let map = RemoveRef {
            file: "/home/u/.fx/mcp.json".into(),
            format: "json".into(),
            path: jp(&["myserver"]),
            array_item: None,
            expect: None,
        };
        assert!(
            remove_allowed(&map, Path::new("/home/u/.fx/mcp.json"), project, Some(home)).is_ok()
        );
    }

    #[test]
    fn json_remove_index_verifies_expected_content() {
        let text = r#"{"hooks": {"PostToolUse": [{"hooks": [{"command": "a.sh"}, {"command": "b.sh"}]}]}}"#;
        // Index path + expect match: removes the right element.
        let next = remove_json_at(
            text,
            &jp(&["hooks", "PostToolUse", "0", "hooks", "1"]),
            Some("b.sh"),
        )
        .unwrap();
        assert_eq!(
            parse_json_file(&next).unwrap(),
            serde_json::json!({"hooks": {"PostToolUse": [{"hooks": [{"command": "a.sh"}]}]}})
        );
        // Stale ref (file changed: the element at index 1 is now "c.sh") is
        // refused instead of cutting the wrong entry.
        let shifted = r#"{"hooks": {"PostToolUse": [{"hooks": [{"command": "c.sh"}]}]}}"#;
        assert!(remove_json_at(
            shifted,
            &jp(&["hooks", "PostToolUse", "0", "hooks", "1"]),
            Some("b.sh"),
        )
        .is_err());
    }

    #[test]
    fn toml_tables_skip_multiline_arrays() {
        // A `["y"]` line inside an unterminated array value is not a header.
        let text = "[mcp_servers.a]\nargs = [\n  \"x\",\n  [\"y\"]\n]\n\n[mcp_servers.b]\ncommand = \"z\"\n";
        let tables = toml_tables(text);
        assert_eq!(tables.len(), 2);
        assert_eq!(tables[0].path, vec!["mcp_servers", "a"]);
        assert_eq!(tables[1].path, vec!["mcp_servers", "b"]);
        // Removing table a leaves balanced brackets.
        let next = remove_toml(text, &jp(&["mcp_servers", "a"]), None).unwrap();
        assert!(!next.contains("mcp_servers.a"));
        assert!(next.contains("[mcp_servers.b]"));
        assert!(!next.contains("[\"y\"]"));
    }

    #[test]
    fn remove_requires_known_file_and_entry_depth() {
        let project = Path::new("/repo");
        let home = Path::new("/home/u");
        let file_remove = |file: &str| RemoveRef {
            file: file.into(),
            format: "file".into(),
            path: Vec::new(),
            array_item: None,
            expect: None,
        };
        // Arbitrary files and dirs are refused even inside the bounds.
        for bad in [
            "/home/u/.ssh/config",
            "/home/u/.zshrc",
            "/repo/.git",
            "/repo/src/main.rs",
            "/home/u",
            "/repo",
        ] {
            let r = file_remove(bad);
            assert!(
                remove_allowed(&r, Path::new(bad), project, Some(home)).is_err(),
                "{bad} must not be removable"
            );
        }
        // Inventory-emitted file targets pass.
        for good in [
            "/repo/CLAUDE.md",
            "/repo/.mcp.json",
            "/home/u/.claude/settings.json",
            "/home/u/.codex/hooks/notify.json",
            "/repo/.cursor/rules/style.mdc",
            "/home/u/.pi/agent/extensions/foo.ts",
            "/repo/.devin/config.json",
        ] {
            let r = file_remove(good);
            assert!(
                remove_allowed(&r, Path::new(good), project, Some(home)).is_ok(),
                "{good} should be removable"
            );
        }
        // Whole-section removal is refused; entries inside are allowed.
        let whole = RemoveRef {
            file: "/home/u/.claude.json".into(),
            format: "json".into(),
            path: jp(&["projects"]),
            array_item: None,
            expect: None,
        };
        assert!(remove_allowed(
            &whole,
            Path::new("/home/u/.claude.json"),
            project,
            Some(home)
        )
        .is_err());
        let entry = RemoveRef {
            file: "/home/u/.claude.json".into(),
            format: "json".into(),
            path: jp(&["projects", "/repo"]),
            array_item: None,
            expect: None,
        };
        assert!(remove_allowed(
            &entry,
            Path::new("/home/u/.claude.json"),
            project,
            Some(home)
        )
        .is_ok());
    }

    #[test]
    fn project_root_is_rejected() {
        assert!(checked_project("/").is_err());
        assert!(checked_project("/definitely/not/here").is_err());
        // A real directory passes.
        assert!(checked_project(env!("CARGO_MANIFEST_DIR")).is_ok());
    }

    #[test]
    fn json_remove_truncated_file_does_not_panic() {
        // `{"mcpServers":` — member present, value token missing.
        assert!(remove_json_at("{\"mcpServers\":", &jp(&["mcpServers", "x"]), None).is_err());
    }

    #[test]
    fn json_remove_last_keeps_trailing_comment() {
        let text = "{\n  \"a\": 1, // keep\n  \"b\": 2\n}";
        let next = remove_json_at(text, &["b".into()], None).unwrap();
        assert!(next.contains("// keep"));
        assert_eq!(parse_json_file(&next).unwrap(), serde_json::json!({"a": 1}));
    }

    #[test]
    fn toml_remove_refuses_scalar_list_item() {
        // `enabled = "one"` is not an array — a string cut would leave
        // `enabled = ` behind, which is invalid TOML.
        let text = "[plugins]\nenabled = \"one\"\n";
        assert!(remove_toml(text, &jp(&["plugins", "enabled"]), Some("one")).is_err());
    }

    #[test]
    fn toml_remove_table_takes_subtables() {
        let text = "[mcp_servers.a]\ncommand = \"x\"\n\n[mcp_servers.a.env]\nKEY = \"secret\"\n\n[mcp_servers.b]\ncommand = \"y\"\n";
        let next = remove_toml(text, &jp(&["mcp_servers", "a"]), None).unwrap();
        assert!(!next.contains("mcp_servers.a"));
        assert!(!next.contains("secret"));
        assert!(next.contains("[mcp_servers.b]"));
        // A verified single array-table match still checks the needle.
        let text = "[[hooks.a]]\ncommand = \"one\"\n";
        assert!(remove_toml(text, &jp(&["hooks", "a"]), Some("other")).is_err());
        assert!(remove_toml(text, &jp(&["hooks", "a"]), Some("one")).is_ok());
    }
}
