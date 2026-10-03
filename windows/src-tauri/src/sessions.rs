// Recent Claude Code conversations, read from the transcripts Claude Code keeps
// in %USERPROFILE%\.claude\projects\<project>\<session-id>.jsonl.
//
// This is what fills the island's "Conversaciones" card when Coucou starts or the
// island opens, before any hook event has said a word. Only the tail of each
// file is read (transcripts grow to megabytes) and only a short line of text is
// kept from it: nothing is stored or sent anywhere.

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;

/// How much of the end of a transcript is looked at.
const TAIL_BYTES: u64 = 256 * 1024;
/// A transcript touched this recently is still being written to.
const WORKING_WINDOW_MS: u64 = 20_000;
/// Longest line of text handed to the island.
const MAX_TEXT: usize = 80;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentSession {
    pub id: String,
    pub cwd: String,
    /// `working` or `finished`.
    pub status: &'static str,
    /// The line that says what the conversation is about.
    pub detail: String,
    /// Milliseconds since the Unix epoch.
    pub last_seen: u64,
}

fn projects_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").map(|home| PathBuf::from(home).join(".claude").join("projects"))
}

/// How much of the start of a transcript is looked at for the original folder.
const HEAD_BYTES: u64 = 128 * 1024;

/// The transcript of a session, wherever Claude Code filed it. `id` must be a
/// UUID: it becomes part of a path, so nothing else is ever looked up.
pub fn find_transcript(id: &str) -> Option<PathBuf> {
    if !is_uuid(id) {
        return None;
    }
    let root = projects_dir()?;
    for project in std::fs::read_dir(root).ok()?.flatten() {
        let candidate = project.path().join(format!("{id}.jsonl"));
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// The folder a conversation was started in: the first `cwd` its transcript
/// records. Resuming from that folder is what makes Claude Code find the session
/// again, even if the session wandered into other folders afterwards.
pub fn original_cwd(transcript: &Path) -> Option<String> {
    let file = std::fs::File::open(transcript).ok()?;
    let mut bytes = Vec::new();
    file.take(HEAD_BYTES).read_to_end(&mut bytes).ok()?;
    String::from_utf8_lossy(&bytes).lines().find_map(|line| {
        serde_json::from_str::<Value>(line)
            .ok()?
            .get("cwd")?
            .as_str()
            .map(str::to_string)
    })
}

/// 8-4-4-4-12 hex, the shape of a Claude Code session id (and of its file name).
fn is_uuid(s: &str) -> bool {
    let parts: Vec<&str> = s.split('-').collect();
    parts.len() == 5
        && parts
            .iter()
            .zip([8usize, 4, 4, 4, 12])
            .all(|(p, n)| p.len() == n && p.chars().all(|c| c.is_ascii_hexdigit()))
}

fn millis(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// The most recently modified conversations, newest first.
pub fn recent(limit: usize) -> Vec<RecentSession> {
    let Some(root) = projects_dir() else { return Vec::new() };
    let Ok(projects) = std::fs::read_dir(root) else { return Vec::new() };

    // (modified, session id, path) for every top-level transcript.
    let mut found: Vec<(u64, String, PathBuf)> = Vec::new();
    for project in projects.flatten() {
        let Ok(files) = std::fs::read_dir(project.path()) else { continue };
        for file in files.flatten() {
            let path = file.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let Some(id) = path.file_stem().and_then(|s| s.to_str()).map(str::to_string) else {
                continue;
            };
            if !is_uuid(&id) {
                continue;
            }
            let Ok(modified) = file.metadata().and_then(|m| m.modified()) else { continue };
            found.push((millis(modified), id, path));
        }
    }
    found.sort_by(|a, b| b.0.cmp(&a.0));

    let now = millis(SystemTime::now());
    let mut out = Vec::new();
    // A few spare candidates: some files hold no real conversation.
    for (modified, id, path) in found.into_iter().take(limit.saturating_mul(3).max(limit)) {
        let Some(read) = read_tail(&path) else { continue };
        if read.cwd.is_empty() {
            continue;
        }
        let working = now.saturating_sub(modified) < WORKING_WINDOW_MS;
        let detail = if working {
            read.prompt.or(read.reply)
        } else {
            read.reply.or(read.prompt)
        }
        .unwrap_or_default();
        out.push(RecentSession {
            id,
            cwd: read.cwd,
            status: if working { "working" } else { "finished" },
            detail,
            last_seen: modified,
        });
        if out.len() >= limit {
            break;
        }
    }
    out
}

struct Tail {
    cwd: String,
    prompt: Option<String>,
    reply: Option<String>,
}

fn first_line(text: &str) -> Option<String> {
    let line = text.trim().lines().next()?.trim();
    if line.is_empty() {
        return None;
    }
    Some(line.chars().take(MAX_TEXT).collect())
}

/// Text of a message's content: a plain string, or the `text` blocks of a list.
fn content_text(content: &Value) -> Option<String> {
    match content {
        Value::String(s) => Some(s.clone()),
        Value::Array(blocks) => blocks
            .iter()
            .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .next()
            .map(str::to_string),
        _ => None,
    }
}

fn read_tail(path: &Path) -> Option<Tail> {
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let start = len.saturating_sub(TAIL_BYTES);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::new();
    file.take(TAIL_BYTES).read_to_end(&mut bytes).ok()?;
    let text = String::from_utf8_lossy(&bytes);

    let mut lines = text.lines();
    // Starting mid-file means the first line is cut off.
    if start > 0 {
        lines.next();
    }
    let lines: Vec<&str> = lines.collect();

    let mut tail = Tail { cwd: String::new(), prompt: None, reply: None };
    for line in lines.iter().rev() {
        let Ok(entry) = serde_json::from_str::<Value>(line) else { continue };
        if tail.cwd.is_empty() {
            if let Some(cwd) = entry.get("cwd").and_then(Value::as_str) {
                tail.cwd = cwd.to_string();
            }
        }
        match entry.get("type").and_then(Value::as_str) {
            Some("last-prompt") if tail.prompt.is_none() => {
                tail.prompt = entry.get("lastPrompt").and_then(Value::as_str).and_then(first_line);
            }
            Some("user") if tail.prompt.is_none() && entry.get("isMeta") != Some(&Value::Bool(true)) => {
                // Tool results and injected reminders ride in user messages too.
                tail.prompt = entry
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(content_text)
                    .filter(|t| !t.trim_start().starts_with('<'))
                    .and_then(|t| first_line(&t));
            }
            Some("assistant") if tail.reply.is_none() => {
                tail.reply = entry
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(content_text)
                    .and_then(|t| first_line(&t));
            }
            _ => {}
        }
        if !tail.cwd.is_empty() && tail.prompt.is_some() && tail.reply.is_some() {
            break;
        }
    }
    Some(tail)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uuid_shape() {
        assert!(is_uuid("0af41ffe-508f-4df7-88f2-05aeb1563163"));
        assert!(!is_uuid("sessions"));
        assert!(!is_uuid("0af41ffe-508f-4df7-88f2-05aeb156316"));
    }

    #[test]
    fn first_line_is_trimmed_and_capped() {
        assert_eq!(first_line("  hola\nmundo").as_deref(), Some("hola"));
        assert_eq!(first_line("   \n").as_deref(), None);
        assert_eq!(first_line(&"é".repeat(200)).unwrap().chars().count(), MAX_TEXT);
    }
}
