//! Work DuckDB cannot do, next to the data: the overlay (GEOS, native) and per-feature
//! kernels (pure Rust, on every target).

pub mod features;
#[cfg(feature = "geos")]
pub mod overlay;
