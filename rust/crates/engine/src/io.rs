//! Application-level I/O authorisation (docs/rust-migration-plan.md, Security).
//!
//! DuckDB's settings restrict DuckDB only. Every other file or network access in the
//! engine goes through `Approvals::authorize`, and exports are staged then finalised
//! so that a killed engine never leaves a half-written file at the destination.
//! `tests/io_calls.rs` fails if engine code touches `std::fs` outside this module.

use std::path::{Path, PathBuf};

use crate::Result;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    Read,
    Write,
}

/// What the user approved: exact sources, plus the engine's own staging directory.
#[derive(Debug, Clone, Default)]
pub struct Approvals {
    pub sources: Vec<String>,
    pub staging_dir: Option<PathBuf>,
}

impl Approvals {
    pub fn authorize(&self, path_or_url: &str, access: Access) -> Result<()> {
        if access == Access::Read && self.sources.iter().any(|s| s == path_or_url) {
            return Ok(());
        }
        if let Some(dir) = &self.staging_dir
            && Path::new(path_or_url).starts_with(dir)
            && !path_or_url.contains("..")
        {
            return Ok(());
        }
        Err(format!("{path_or_url} was not approved for {access:?}"))
    }
}

/// Move a finished export from staging to its destination: copy to `<dest>.partial`, then rename.
pub fn finalize_export(approvals: &Approvals, staged: &Path, destination: &Path) -> Result<()> {
    approvals.authorize(&staged.to_string_lossy(), Access::Read)?;
    let partial = destination.with_extension(match destination.extension() {
        Some(ext) => format!("{}.partial", ext.to_string_lossy()),
        None => "partial".into(),
    });
    std::fs::copy(staged, &partial).map_err(|e| e.to_string())?;
    std::fs::rename(&partial, destination).map_err(|e| e.to_string())?;
    std::fs::remove_file(staged).map_err(|e| e.to_string())
}

/// Delete staging leftovers and `.partial` files from an earlier engine (at start).
pub fn clean_staging(dir: &Path) -> Result<()> {
    if dir.exists() {
        std::fs::remove_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())
}

/// Create a directory the engine owns (extensions, staging).
pub fn ensure_dir(dir: &Path) -> Result<()> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())
}

/// What a local file looked like when it was loaded: size and modification time.
pub fn fingerprint(path: &str) -> Option<(u64, std::time::SystemTime)> {
    let meta = std::fs::metadata(path).ok()?;
    Some((meta.len(), meta.modified().ok()?))
}

/// The canonical form of an approved local path (no `..`, no symlinks), so the allow list and
/// what DuckDB and GDAL actually open agree. URLs are returned unchanged.
pub fn canonical(location: &str) -> Result<String> {
    if location.contains("://") {
        return Ok(location.to_string());
    }
    std::fs::canonicalize(location)
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| format!("{location}: {e}"))
}
