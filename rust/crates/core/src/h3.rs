//! Dense positional H3 tiles (app/src/engines/h3/index.js, transformers/_kit/h3.js): a file named
//! after its parent cell holding all 7^n children in ascending order, so row i is child i.

use crate::{Ctx, Result, js_number, qid, thousands};
use h3o::CellIndex;

/// The canonical index column: an H3 cell id as lowercase hex.
pub const H3_INDEX_COLUMN: &str = "h3_index";
/// The Reader's physical row number, which positional indexing needs.
pub const ROW_NUMBER_COLUMN: &str = "file_row_number";

const MAX_RESOLUTION: u8 = 15;

/// The H3 cell a file is named after (`0001_866500cdfffffff.parquet` too), lowercase, or None.
pub fn parse_parent_cell(file_name: &str) -> Option<String> {
    let lower = file_name.to_lowercase();
    let stem = [".parquet", ".pq"]
        .iter()
        .find_map(|ext| lower.ends_with(ext).then(|| &file_name[..file_name.len() - ext.len()]))
        .unwrap_or(file_name);
    let candidate = stem.rsplit(['_', '/', '\\']).next()?;
    let hex = (15..=16).contains(&candidate.len()) && candidate.chars().all(|c| c.is_ascii_hexdigit());
    let hex = hex.then(|| candidate.to_lowercase())?;
    hex.parse::<CellIndex>().is_ok().then_some(hex)
}

/// The child resolution whose child count equals `rows`, or None (pentagons never qualify).
pub fn child_resolution_for(parent: &str, rows: u64) -> Option<u8> {
    let cell: CellIndex = parent.parse().ok()?;
    let res = u8::from(cell.resolution());
    if rows == 1 {
        return Some(res);
    }
    if cell.is_pentagon() {
        return None;
    }
    (1..=MAX_RESOLUTION - res)
        .find(|d| 7u64.pow(u32::from(*d)) == rows)
        .map(|d| res + d)
}

/// SQL for the H3 index of the row at `row` within a dense tile: the parent with its resolution
/// set and the row number's base-7 digits written into the new 3-bit digit fields.
pub fn positional_index_expr(parent: &str, child_res: u8, row: &str) -> Result<String> {
    let cell: CellIndex = parent
        .parse()
        .map_err(|_| format!("\"{parent}\" is not a valid H3 cell."))?;
    let parent_res = u8::from(cell.resolution());
    let digits = child_res
        .checked_sub(parent_res)
        .ok_or_else(|| format!("Resolution {child_res} is coarser than the parent cell's ({parent_res})."))?;
    let shift = 45 - 3 * u32::from(child_res);
    let digit_mask = ((1u64 << (3 * u32::from(digits))) - 1) << shift;
    let base = (u64::from(cell) & !digit_mask & !(0xf << 52)) | (u64::from(child_res) << 52);
    if digits == 0 {
        return Ok(format!("lpad(lower(hex({base}::UBIGINT)), 15, '0')"));
    }
    let terms: Vec<String> = (0..u32::from(digits))
        .map(|k| format!("(({row} // {}) % 7) * {}", 7u64.pow(k), 8u64.pow(k)))
        .collect();
    Ok(format!(
        "lpad(lower(hex({base}::UBIGINT | (({})::UBIGINT << {shift}))), 15, '0')",
        terms.join(" + ")
    ))
}

/// The parent cell: what the user typed, else the one the upstream file is named after.
pub fn resolve_parent(ctx: &Ctx) -> Result<String> {
    let typed = ctx.str("parent").trim();
    if !typed.is_empty() {
        return parse_parent_cell(typed).ok_or_else(|| format!("\"{typed}\" is not a valid H3 cell."));
    }
    ctx.source
        .as_deref()
        .and_then(parse_parent_cell)
        .ok_or_else(|| "No parent cell — the file is not named after one, so type it in.".into())
}

/// The child resolution: what the user typed, else the one whose child count is the row count.
pub fn resolve_child_resolution(ctx: &Ctx, parent: &str) -> Result<u8> {
    let typed = ctx.str("resolution").trim();
    if !typed.is_empty() {
        return js_number(&typed.into())
            .filter(|n| n.fract() == 0.0 && (0.0..=15.0).contains(n))
            .map(|n| n as u8)
            .ok_or_else(|| format!("\"{typed}\" is not an H3 resolution (0-15)."));
    }
    let rows = ctx.row_count.unwrap_or(0);
    child_resolution_for(parent, rows).ok_or_else(|| {
        format!(
            "{} rows is not a whole number of children of {parent} — set the child resolution by hand.",
            thousands(rows)
        )
    })
}

/// The positional index expression for this node's rows; `qualifier` prefixes the row column.
pub fn positional_expr_for(ctx: &Ctx, qualifier: &str) -> Result<String> {
    let parent = resolve_parent(ctx)?;
    let resolution = resolve_child_resolution(ctx, &parent)?;
    let row = if qualifier.is_empty() {
        qid(ROW_NUMBER_COLUMN)
    } else {
        format!("{qualifier}.{}", qid(ROW_NUMBER_COLUMN))
    };
    positional_index_expr(&parent, resolution, &row)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_tiles_named_after_their_cell() {
        assert_eq!(
            parse_parent_cell("0001_891F8D7A49BFFFF.parquet").as_deref(),
            Some("891f8d7a49bffff")
        );
        assert_eq!(parse_parent_cell("nope"), None);
        assert_eq!(child_resolution_for("891f8d7a49bffff", 7), Some(10));
        assert_eq!(child_resolution_for("891f8d7a49bffff", 5), None);
    }
}
