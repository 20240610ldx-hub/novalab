//! Offline draft-recovery journal (A15, round 7 follow-up; docs/proposal-offline-draft-journal.md).
//!
//! While the bridge is disconnected (or a tab is bridge-lost) the frontend cannot reach the
//! bridge's `draft.write`, so it calls the `write_draft_journal` command instead. The file is
//! byte-for-byte the round-7 format the bridge reads (`bridge/src/drafts.ts`):
//! `<notebook dir>/.novalab/drafts/<basename>.<ms>-<rand8>.draft.json`, at most 5 copies per
//! notebook, deleted after 7 days, at most 2 MiB each. Reading, offering, restoring, preserving
//! and clearing stay with the bridge. Shared fixtures: `bridge/test-fixtures/draft-journal/`.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const MAX_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_COPIES: usize = 5;
pub const TTL_MS: u128 = 7 * 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct DraftCell {
    pub id: String,
    pub code: String,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DraftWritten {
    pub draft_id: String,
    pub bytes: usize,
}

#[derive(Debug, PartialEq)]
pub enum DraftError {
    /// Not an absolute path to an existing regular `.py` file.
    InvalidNotebook(String),
    /// `baselineSha256` is neither null nor 64 lowercase hex characters.
    InvalidBaseline,
    /// Serialized journal is larger than `MAX_BYTES` (the frontend shows the round-7 notice).
    TooLarge(usize),
    Io(String),
}

impl std::fmt::Display for DraftError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DraftError::InvalidNotebook(why) => write!(f, "invalid notebook path: {why}"),
            DraftError::InvalidBaseline => write!(f, "invalid baselineSha256"),
            DraftError::TooLarge(bytes) => write!(f, "draft journal is {bytes} bytes; limit is {MAX_BYTES}"),
            DraftError::Io(why) => write!(f, "draft journal write failed: {why}"),
        }
    }
}

/// `<notebook dir>/.novalab/drafts`.
pub fn drafts_dir(notebook: &Path) -> PathBuf {
    notebook
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(".novalab")
        .join("drafts")
}

/// Journal body; field order matches the bridge writer (`JSON.stringify` of DraftJournal).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Journal<'a> {
    version: u8,
    notebook: &'a str,
    baseline_sha256: Option<&'a str>,
    saved_at: String,
    cells: &'a [DraftCell],
    dirty_cell_ids: &'a [String],
}

fn validate_notebook(notebook: &Path) -> Result<String, DraftError> {
    if !notebook.is_absolute() {
        return Err(DraftError::InvalidNotebook("not absolute".into()));
    }
    let is_py = notebook
        .extension()
        .map(|e| e.eq_ignore_ascii_case("py"))
        .unwrap_or(false);
    if !is_py {
        return Err(DraftError::InvalidNotebook("not a .py file".into()));
    }
    let meta = std::fs::metadata(notebook)
        .map_err(|_| DraftError::InvalidNotebook("does not exist".into()))?;
    if !meta.is_file() {
        return Err(DraftError::InvalidNotebook("not a regular file".into()));
    }
    notebook
        .file_name()
        .and_then(|n| n.to_str())
        .map(str::to_owned)
        .ok_or_else(|| DraftError::InvalidNotebook("file name is not UTF-8".into()))
}

fn valid_baseline(sha: &str) -> bool {
    sha.len() == 64 && sha.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// 8 lowercase hex characters; std-only (RandomState is seeded per process from the OS).
fn rand8() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let mut h = RandomState::new().build_hasher();
    h.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
    h.write_u128(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
    );
    format!("{:08x}", h.finish() as u32)
}

/// Validate the notebook path and write one journal copy atomically, then prune.
pub fn write_draft(
    notebook: &Path,
    baseline_sha256: Option<&str>,
    cells: &[DraftCell],
    dirty_cell_ids: &[String],
    now_ms: u128,
) -> Result<DraftWritten, DraftError> {
    let basename = validate_notebook(notebook)?;
    if let Some(sha) = baseline_sha256 {
        if !valid_baseline(sha) {
            return Err(DraftError::InvalidBaseline);
        }
    }
    let body = serde_json::to_string(&Journal {
        version: 1,
        notebook: &basename,
        baseline_sha256,
        saved_at: iso_utc(now_ms),
        cells,
        dirty_cell_ids,
    })
    .map_err(|e| DraftError::Io(e.to_string()))?;
    if body.len() > MAX_BYTES {
        return Err(DraftError::TooLarge(body.len()));
    }

    let dir = drafts_dir(notebook);
    std::fs::create_dir_all(&dir).map_err(|e| DraftError::Io(e.to_string()))?;
    let draft_id = format!("{now_ms}-{}", rand8());
    let target = dir.join(format!("{basename}.{draft_id}.draft.json"));
    let temporary = dir.join(format!(".{basename}.{draft_id}.tmp"));
    // Round-4 pattern: exclusive temp file in the same directory → write → fsync → rename.
    let written = (|| -> std::io::Result<()> {
        use std::io::Write;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(body.as_bytes())?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temporary, &target)
    })();
    if let Err(e) = written {
        let _ = std::fs::remove_file(&temporary);
        return Err(DraftError::Io(e.to_string()));
    }
    #[cfg(unix)]
    {
        // Best effort, like round 4: no promise of directory durability across power loss.
        if let Ok(d) = std::fs::File::open(&dir) {
            let _ = d.sync_all();
        }
    }
    prune(notebook, now_ms);
    Ok(DraftWritten { draft_id, bytes: body.len() })
}

/// This notebook's copies `(timestamp, file name)`, newest first (same naming rule as the bridge).
fn own_entries(notebook: &Path) -> Vec<(u128, String)> {
    let Some(basename) = notebook.file_name().and_then(|n| n.to_str()) else {
        return Vec::new();
    };
    let prefix = format!("{basename}.");
    let Ok(entries) = std::fs::read_dir(drafts_dir(notebook)) else {
        return Vec::new();
    };
    let mut out: Vec<(u128, String)> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().into_string().ok())
        .filter_map(|name| {
            let id = name.strip_prefix(&prefix)?.strip_suffix(".draft.json")?;
            let (ms, rand) = id.split_once('-')?;
            let ok_ms = !ms.is_empty() && ms.len() <= 15 && ms.bytes().all(|b| b.is_ascii_digit());
            let ok_rand = rand.len() == 8 && rand.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
            if ok_ms && ok_rand {
                Some((ms.parse::<u128>().ok()?, name.clone()))
            } else {
                None
            }
        })
        .collect();
    out.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
    out
}

/// Remove expired (> TTL) copies and copies beyond `MAX_COPIES`; returns kept timestamps, newest first.
pub fn prune(notebook: &Path, now_ms: u128) -> Vec<u128> {
    let dir = drafts_dir(notebook);
    let mut kept = Vec::new();
    for (at, name) in own_entries(notebook) {
        if now_ms.saturating_sub(at) > TTL_MS || kept.len() >= MAX_COPIES {
            let _ = std::fs::remove_file(dir.join(name));
        } else {
            kept.push(at);
        }
    }
    kept
}

/// RFC 3339 / `Date.prototype.toISOString` form with milliseconds, UTC.
pub fn iso_utc(ms: u128) -> String {
    let millis = (ms % 1000) as u32;
    let secs = (ms / 1000) as i64;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + if month <= 2 { 1 } else { 0 };
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static SEQ: AtomicUsize = AtomicUsize::new(0);

    struct Tmp(PathBuf);
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn tmp_notebook(name: &str) -> (Tmp, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "novalab-rs-drafts-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir_all(&dir).unwrap();
        let nb = dir.join(name);
        fs::write(&nb, "# %% [cell-id: aaaaaaaa]\nx = 1\n").unwrap();
        (Tmp(dir), nb)
    }
    fn fixtures() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../bridge/test-fixtures/draft-journal")
    }
    fn cells() -> Vec<DraftCell> {
        vec![
            DraftCell { id: "aaaaaaaa".into(), code: "x = 2  # draft\nprint(\"é\")".into() },
            DraftCell { id: "bbbbbbbb".into(), code: "y = x".into() },
        ]
    }
    const SHA: &str = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
    fn own_files(nb: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(drafts_dir(nb))
            .map(|it| it.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect())
            .unwrap_or_default();
        names.sort();
        names
    }

    #[test]
    fn writes_the_canonical_v1_journal_next_to_the_notebook() {
        let (_t, nb) = tmp_notebook("a.py");
        let dirty = vec!["aaaaaaaa".to_string()];
        let out = write_draft(&nb, Some(SHA), &cells(), &dirty, 1_760_688_000_000).unwrap();
        assert_eq!(drafts_dir(&nb), nb.parent().unwrap().join(".novalab").join("drafts"));
        let names = own_files(&nb);
        assert_eq!(names, vec![format!("a.py.{}.draft.json", out.draft_id)], "one file, no temp left");
        assert!(out.draft_id.starts_with("1760688000000-") && out.draft_id.len() == "1760688000000-".len() + 8);
        assert!(out.draft_id["1760688000000-".len()..].chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        let body = fs::read_to_string(drafts_dir(&nb).join(&names[0])).unwrap();
        assert_eq!(body.len(), out.bytes);
        // Same JSON value as the shared fixture the bridge reader is tested against.
        let ours: serde_json::Value = serde_json::from_str(&body).unwrap();
        let fixture: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(fixtures().join("valid.v1.draft.json")).unwrap()).unwrap();
        assert_eq!(ours, fixture);
    }

    #[test]
    fn null_baseline_is_written_as_null() {
        let (_t, nb) = tmp_notebook("a.py");
        write_draft(&nb, None, &cells(), &[], 1).unwrap();
        let body = fs::read_to_string(drafts_dir(&nb).join(&own_files(&nb)[0])).unwrap();
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert!(v["baselineSha256"].is_null());
    }

    #[test]
    fn rejects_paths_that_are_not_an_existing_absolute_py_file() {
        let (t, nb) = tmp_notebook("a.py");
        let txt = t.0.join("notes.txt");
        fs::write(&txt, "x").unwrap();
        for bad in [PathBuf::from("a.py"), t.0.join("missing.py"), txt, t.0.clone()] {
            assert!(
                matches!(write_draft(&bad, None, &cells(), &[], 1), Err(DraftError::InvalidNotebook(_))),
                "{}",
                bad.display()
            );
        }
        assert!(!drafts_dir(&nb).exists(), "nothing written for rejected paths");
    }

    #[test]
    fn rejects_a_malformed_baseline() {
        let (_t, nb) = tmp_notebook("a.py");
        for bad in ["", "abc", &SHA.to_uppercase(), &format!("{SHA}0")] {
            assert_eq!(write_draft(&nb, Some(bad), &cells(), &[], 1), Err(DraftError::InvalidBaseline));
        }
    }

    #[test]
    fn refuses_a_copy_above_the_limit_and_writes_nothing() {
        let (_t, nb) = tmp_notebook("a.py");
        let big = vec![DraftCell { id: "a".into(), code: "x".repeat(MAX_BYTES) }];
        assert!(matches!(write_draft(&nb, None, &big, &[], 1), Err(DraftError::TooLarge(_))));
        assert!(own_files(&nb).is_empty());
    }

    #[test]
    fn prune_matches_the_shared_cases() {
        let raw = fs::read_to_string(fixtures().join("prune-cases.json")).unwrap();
        let spec: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(spec["maxCopies"].as_u64().unwrap() as usize, MAX_COPIES);
        assert_eq!(spec["ttlMs"].as_u64().unwrap() as u128, TTL_MS);
        for case in spec["cases"].as_array().unwrap() {
            let (_t, nb) = tmp_notebook("a.py");
            let dir = drafts_dir(&nb);
            fs::create_dir_all(&dir).unwrap();
            for (i, ms) in case["existing"].as_array().unwrap().iter().enumerate() {
                fs::write(dir.join(format!("a.py.{}-{:08x}.draft.json", ms.as_u64().unwrap(), i)), "{}").unwrap();
            }
            let kept = prune(&nb, case["now"].as_u64().unwrap() as u128);
            let expect: Vec<u128> = case["expect"].as_array().unwrap().iter().map(|v| v.as_u64().unwrap() as u128).collect();
            assert_eq!(kept, expect, "{}", case["name"]);
            assert_eq!(own_files(&nb).len(), expect.len(), "{}", case["name"]);
        }
    }

    #[test]
    fn prune_never_touches_other_notebooks() {
        let (t, nb) = tmp_notebook("a.py");
        let other = t.0.join("aa.py");
        fs::write(&other, "z = 1\n").unwrap();
        write_draft(&other, None, &cells(), &[], 1_000).unwrap();
        for i in 0..7u128 {
            write_draft(&nb, None, &cells(), &[], 1_760_688_000_000 + i * 1_000).unwrap();
        }
        assert_eq!(own_files(&nb).iter().filter(|n| n.starts_with("a.py.")).count(), MAX_COPIES);
        assert_eq!(own_files(&nb).iter().filter(|n| n.starts_with("aa.py.")).count(), 1);
    }

    #[test]
    fn iso_matches_javascript_to_iso_string() {
        assert_eq!(iso_utc(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_utc(1_760_688_000_000), "2025-10-17T08:00:00.000Z");
        assert_eq!(iso_utc(951_782_400_123), "2000-02-29T00:00:00.123Z");
    }

    #[cfg(unix)]
    #[test]
    fn journal_is_owner_only_on_posix() {
        use std::os::unix::fs::PermissionsExt;
        let (_t, nb) = tmp_notebook("a.py");
        write_draft(&nb, None, &cells(), &[], 1).unwrap();
        let mode = fs::metadata(drafts_dir(&nb).join(&own_files(&nb)[0])).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}
