// The "Proyectos" panel: git repositories one level below the projects folder,
// with their branch, uncommitted changes and distance from the upstream.
//
// Everything is read with `git` itself (status --porcelain=v2, log -1), so the
// numbers are exactly what the user would see in a terminal. Results are cached
// for a few seconds because the panel asks every time it is shown.

use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;

/// Keeps spawned helpers from flashing a console window.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// A folder with more repositories than this is not a projects folder.
const MAX_REPOS: usize = 40;
const CACHE_TTL: Duration = Duration::from_secs(20);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub name: String,
    pub path: String,
    pub branch: String,
    /// Files modified, staged or untracked.
    pub changes: u32,
    pub ahead: u32,
    pub behind: u32,
    /// Milliseconds since the Unix epoch; 0 when the repository has no commits.
    pub last_commit: u64,
}

struct Cached {
    at: Instant,
    root: PathBuf,
    projects: Vec<Project>,
}

fn cache() -> &'static Mutex<Option<Cached>> {
    static CACHE: OnceLock<Mutex<Option<Cached>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

/// The configured folder, or the first of the usual places that exists.
pub fn resolve_root(configured: &str) -> Option<PathBuf> {
    let configured = configured.trim();
    if !configured.is_empty() {
        let path = PathBuf::from(configured);
        return path.is_dir().then_some(path);
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(home) = std::env::var_os("USERPROFILE").map(PathBuf::from) {
        candidates.push(home.join("Proyectos"));
        candidates.push(home.join("source").join("repos"));
        candidates.push(home.join("Documents").join("GitHub"));
    }
    candidates.push(PathBuf::from("C:/Proyectos"));
    candidates.into_iter().find(|p| p.is_dir())
}

fn git(repo: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        // Reading status must never take the index lock away from the user's own git.
        .env("GIT_OPTIONAL_LOCKS", "0")
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).to_string())
}

fn inspect(path: &Path) -> Option<Project> {
    let status = git(path, &["status", "--porcelain=v2", "--branch"])?;
    let mut branch = String::from("?");
    let (mut ahead, mut behind, mut changes) = (0u32, 0u32, 0u32);
    for line in status.lines() {
        if let Some(head) = line.strip_prefix("# branch.head ") {
            branch = if head == "(detached)" { "HEAD suelta".into() } else { head.to_string() };
        } else if let Some(ab) = line.strip_prefix("# branch.ab ") {
            // "+2 -1"
            let mut parts = ab.split_whitespace();
            ahead = parts.next().and_then(|p| p.trim_start_matches('+').parse().ok()).unwrap_or(0);
            behind = parts.next().and_then(|p| p.trim_start_matches('-').parse().ok()).unwrap_or(0);
        } else if !line.starts_with('#') && !line.is_empty() {
            changes += 1;
        }
    }
    let last_commit = git(path, &["log", "-1", "--format=%ct"])
        .and_then(|s| s.trim().parse::<u64>().ok())
        .map(|secs| secs * 1000)
        .unwrap_or(0);
    Some(Project {
        name: path.file_name()?.to_string_lossy().to_string(),
        path: path.to_string_lossy().to_string(),
        branch,
        changes,
        ahead,
        behind,
        last_commit,
    })
}

/// Repositories under `configured` (or the default folder), most recently
/// committed first. Uncommitted work floats a repository to the top.
pub fn list(configured: &str) -> Vec<Project> {
    let Some(root) = resolve_root(configured) else { return Vec::new() };

    if let Some(hit) = cache().lock().unwrap().as_ref() {
        if hit.root == root && hit.at.elapsed() < CACHE_TTL {
            return hit.projects.clone();
        }
    }

    let repos: Vec<PathBuf> = std::fs::read_dir(&root)
        .map(|entries| {
            entries
                .flatten()
                .map(|e| e.path())
                // `.git` is a folder in a clone and a file in a worktree.
                .filter(|p| p.is_dir() && p.join(".git").exists())
                .take(MAX_REPOS)
                .collect()
        })
        .unwrap_or_default();

    let mut projects: Vec<Project> = std::thread::scope(|scope| {
        let handles: Vec<_> = repos.iter().map(|repo| scope.spawn(move || inspect(repo))).collect();
        handles.into_iter().filter_map(|h| h.join().ok().flatten()).collect()
    });
    projects.sort_by(|a, b| (b.changes > 0).cmp(&(a.changes > 0)).then(b.last_commit.cmp(&a.last_commit)));

    *cache().lock().unwrap() = Some(Cached { at: Instant::now(), root, projects: projects.clone() });
    projects
}

/// Percent-encodes everything except unreserved characters, for a `claude://` link.
pub fn url_encode(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_a_windows_path() {
        assert_eq!(url_encode("C:\\Mis Proyectos\\a&b"), "C%3A%5CMis%20Proyectos%5Ca%26b");
        assert_eq!(url_encode("abc-1_2.~"), "abc-1_2.~");
    }
}
