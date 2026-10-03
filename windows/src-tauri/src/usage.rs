// Token usage and an estimated cost, from the transcripts Claude Code keeps in
// %USERPROFILE%\.claude\projects (every assistant message records its `usage`).
//
// The cost is an *estimate at API list prices*: people on a subscription do not
// pay it, it is the figure the same work would have cost through the API.
//
// Transcripts are parsed once and remembered per file (path, size, mtime); only
// the files that changed are read again. A message that appears in several
// files (a resumed conversation copies its history) is counted once, by id.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;
use windows::Win32::Foundation::SYSTEMTIME;
use windows::Win32::System::SystemInformation::{GetLocalTime, GetSystemTime};

const DAYS: i64 = 7;
const CACHE_TTL: Duration = Duration::from_secs(45);
/// Folders are walked this deep below `projects` (project / session / subagents).
const MAX_DEPTH: usize = 4;

/// Tokens of one message, by how they are billed.
#[derive(Clone, Default)]
struct Tokens {
    input: u64,
    output: u64,
    cache_write_5m: u64,
    cache_write_1h: u64,
    cache_read: u64,
}

impl Tokens {
    /// A message can be logged several times as it streams; keep the largest.
    fn merge_max(&mut self, other: &Tokens) {
        self.input = self.input.max(other.input);
        self.output = self.output.max(other.output);
        self.cache_write_5m = self.cache_write_5m.max(other.cache_write_5m);
        self.cache_write_1h = self.cache_write_1h.max(other.cache_write_1h);
        self.cache_read = self.cache_read.max(other.cache_read);
    }
}

#[derive(Clone)]
struct Entry {
    day: i64,
    model: String,
    tokens: Tokens,
}

struct FileCache {
    len: u64,
    modified: SystemTime,
    entries: HashMap<String, Entry>,
}

struct Cache {
    files: HashMap<PathBuf, FileCache>,
    last: Option<(Instant, UsageSummary)>,
}

fn cache() -> &'static Mutex<Cache> {
    static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(Cache { files: HashMap::new(), last: None }))
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Bucket {
    pub input: u64,
    pub output: u64,
    pub cache_write: u64,
    pub cache_read: u64,
    pub messages: u64,
    /// Estimated, in US dollars at API list prices.
    pub cost: f64,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct DayBucket {
    pub cost: f64,
    pub tokens: u64,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    pub today: Bucket,
    pub week: Bucket,
    /// The last seven days, oldest first; the last one is today.
    pub days: Vec<DayBucket>,
}

// ── Prices ────────────────────────────────────────────────────────────────────

/// US dollars per million tokens.
struct Price {
    input: f64,
    output: f64,
    cache_write_5m: f64,
    cache_write_1h: f64,
    cache_read: f64,
}

fn price(input: f64, output: f64, cache_read: f64) -> Price {
    Price { input, output, cache_write_5m: input * 1.25, cache_write_1h: input * 2.0, cache_read }
}

/// List prices by model family. Unknown ids fall back to their family's current
/// tier, so the estimate degrades gracefully instead of showing nothing.
fn price_for(model: &str) -> Option<Price> {
    let m = model.to_ascii_lowercase();
    if m.starts_with('<') || m.is_empty() {
        return None;
    }
    Some(if m.contains("fable") || m.contains("mythos") {
        price(10.0, 50.0, 0.25)
    } else if m.contains("opus-5-5") {
        price(4.0, 20.0, 0.20)
    } else if m.contains("opus") {
        price(5.0, 25.0, 0.50)
    } else if m.contains("sonnet-5") {
        price(2.0, 10.0, 0.20)
    } else if m.contains("sonnet") {
        price(3.0, 15.0, 0.30)
    } else if m.contains("haiku") {
        price(1.0, 5.0, 0.10)
    } else {
        return None;
    })
}

fn cost_of(model: &str, t: &Tokens) -> f64 {
    let Some(p) = price_for(model) else { return 0.0 };
    (t.input as f64 * p.input
        + t.output as f64 * p.output
        + t.cache_write_5m as f64 * p.cache_write_5m
        + t.cache_write_1h as f64 * p.cache_write_1h
        + t.cache_read as f64 * p.cache_read)
        / 1_000_000.0
}

// ── Dates (no time crate: days-from-civil and the machine's UTC offset) ───────

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn systemtime_secs(t: &SYSTEMTIME) -> i64 {
    days_from_civil(t.wYear as i64, t.wMonth as i64, t.wDay as i64) * 86_400
        + t.wHour as i64 * 3600
        + t.wMinute as i64 * 60
        + t.wSecond as i64
}

/// Local time minus UTC, in seconds, rounded to a quarter hour.
fn utc_offset_secs() -> i64 {
    let (local, utc) = unsafe { (GetLocalTime(), GetSystemTime()) };
    let raw = systemtime_secs(&local) - systemtime_secs(&utc);
    ((raw + 450).div_euclid(900)) * 900
}

/// "2026-10-01T18:22:13.123Z" → seconds since the Unix epoch (UTC).
fn parse_timestamp(ts: &str) -> Option<i64> {
    let num = |range: std::ops::Range<usize>| ts.get(range)?.parse::<i64>().ok();
    Some(
        days_from_civil(num(0..4)?, num(5..7)?, num(8..10)?) * 86_400
            + num(11..13)? * 3600
            + num(14..16)? * 60
            + num(17..19)?,
    )
}

// ── Reading transcripts ───────────────────────────────────────────────────────

fn transcripts(root: &Path, depth: usize, oldest: SystemTime, out: &mut Vec<(PathBuf, u64, SystemTime)>) {
    let Ok(entries) = std::fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            if depth < MAX_DEPTH {
                transcripts(&path, depth + 1, oldest, out);
            }
        } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            if let Ok(modified) = meta.modified() {
                if modified >= oldest {
                    out.push((path, meta.len(), modified));
                }
            }
        }
    }
}

fn u64_at(v: &Value, key: &str) -> u64 {
    v.get(key).and_then(Value::as_u64).unwrap_or(0)
}

fn read_file(path: &Path, offset: i64) -> HashMap<String, Entry> {
    let mut entries: HashMap<String, Entry> = HashMap::new();
    let Ok(file) = std::fs::File::open(path) else { return entries };
    for (n, line) in BufReader::new(file).lines().enumerate() {
        let Ok(line) = line else { continue };
        // Cheap filter before parsing: only assistant messages carry usage.
        if !line.contains("\"usage\"") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        if v.get("type").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let Some(message) = v.get("message") else { continue };
        let Some(usage) = message.get("usage") else { continue };
        let Some(secs) = v.get("timestamp").and_then(Value::as_str).and_then(parse_timestamp) else {
            continue;
        };
        let (mut w5, mut w1) = (u64_at(usage, "cache_creation_input_tokens"), 0);
        if let Some(split) = usage.get("cache_creation") {
            w5 = u64_at(split, "ephemeral_5m_input_tokens");
            w1 = u64_at(split, "ephemeral_1h_input_tokens");
        }
        let tokens = Tokens {
            input: u64_at(usage, "input_tokens"),
            output: u64_at(usage, "output_tokens"),
            cache_write_5m: w5,
            cache_write_1h: w1,
            cache_read: u64_at(usage, "cache_read_input_tokens"),
        };
        let id = message
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("{}:{n}", path.display()));
        let model = message.get("model").and_then(Value::as_str).unwrap_or("").to_string();
        let day = (secs + offset).div_euclid(86_400);
        match entries.get_mut(&id) {
            Some(e) => e.tokens.merge_max(&tokens),
            None => {
                entries.insert(id, Entry { day, model, tokens });
            }
        }
    }
    entries
}

/// Usage for today and the last seven days.
pub fn summary() -> UsageSummary {
    if let Some((at, last)) = cache().lock().unwrap().last.as_ref() {
        if at.elapsed() < CACHE_TTL {
            return last.clone();
        }
    }

    let Some(root) = std::env::var_os("USERPROFILE")
        .map(|h| PathBuf::from(h).join(".claude").join("projects"))
    else {
        return UsageSummary::default();
    };

    let offset = utc_offset_secs();
    let now = SystemTime::now();
    let today = (now.duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0) + offset)
        .div_euclid(86_400);
    let first_day = today - (DAYS - 1);
    // A file untouched for longer than the window cannot hold a recent message.
    let oldest = now - Duration::from_secs(((DAYS + 1) * 86_400) as u64);

    let mut files = Vec::new();
    transcripts(&root, 0, oldest, &mut files);

    let mut guard = cache().lock().unwrap();
    for (path, len, modified) in &files {
        let fresh = guard
            .files
            .get(path)
            .map(|c| c.len == *len && c.modified == *modified)
            .unwrap_or(false);
        if !fresh {
            let entries = read_file(path, offset);
            guard.files.insert(path.clone(), FileCache { len: *len, modified: *modified, entries });
        }
    }
    // Forget files that dropped out of the window or were deleted.
    let present: std::collections::HashSet<&PathBuf> = files.iter().map(|(p, _, _)| p).collect();
    guard.files.retain(|p, _| present.contains(p));

    // One entry per message id across every file.
    let mut unique: HashMap<&String, Entry> = HashMap::new();
    for file in guard.files.values() {
        for (id, entry) in &file.entries {
            match unique.get_mut(id) {
                Some(e) => e.tokens.merge_max(&entry.tokens),
                None => {
                    unique.insert(id, entry.clone());
                }
            }
        }
    }

    let mut summary = UsageSummary { days: vec![DayBucket::default(); DAYS as usize], ..Default::default() };
    for entry in unique.values() {
        if entry.day < first_day || entry.day > today {
            continue;
        }
        let t = &entry.tokens;
        let cost = cost_of(&entry.model, t);
        let tokens = t.input + t.output + t.cache_write_5m + t.cache_write_1h + t.cache_read;
        let slot = (entry.day - first_day) as usize;
        summary.days[slot].cost += cost;
        summary.days[slot].tokens += tokens;
        let add = |b: &mut Bucket| {
            b.input += t.input;
            b.output += t.output;
            b.cache_write += t.cache_write_5m + t.cache_write_1h;
            b.cache_read += t.cache_read;
            b.messages += 1;
            b.cost += cost;
        };
        add(&mut summary.week);
        if entry.day == today {
            add(&mut summary.today);
        }
    }

    guard.last = Some((Instant::now(), summary.clone()));
    summary
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_days_match_known_dates() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(2000, 3, 1), 11_017);
    }

    #[test]
    fn parses_a_transcript_timestamp() {
        assert_eq!(parse_timestamp("1970-01-02T00:00:10.000Z"), Some(86_410));
        assert_eq!(parse_timestamp("nope"), None);
    }

    #[test]
    fn prices_follow_the_model_family() {
        let t = Tokens { input: 1_000_000, ..Default::default() };
        assert!((cost_of("claude-opus-5-5", &t) - 4.0).abs() < 1e-9);
        assert!((cost_of("claude-sonnet-5-5", &t) - 2.0).abs() < 1e-9);
        assert!((cost_of("claude-haiku-4-5-20251001", &t) - 1.0).abs() < 1e-9);
        assert_eq!(cost_of("<synthetic>", &t), 0.0);
    }
}
