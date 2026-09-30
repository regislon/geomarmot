# AreaOnAreaOverlayer

Splits overlapping polygons into non-overlapping faces, counting and merging what covers each.

## What it does

All the input polygons are overlaid **at once**. Each output row is one atomic face — the smallest
pieces the boundaries cut the plane into — with:

- `_overlaps` (or the name you choose): how many input polygons cover the face;
- for each attribute you accumulate, the distinct values of the covering polygons, sorted and
  joined by the separator (`A;B`).

The partition: every boundary is noded (unioned), the result polygonized into faces, and each face's
covering polygons found by testing its interior point — an interior point, not a centroid, which can
lie outside a crescent. Noding and polygonizing run in JavaScript with JSTS, because DuckDB-Wasm has
neither `ST_Node` nor `ST_Polygonize`; the rest is SQL.

## When to use it

- Find where plots overlap, and how deeply.
- Partition overlapping buffers into non-overlapping pieces.
- List which zones cover each piece of land.

## When not to use it

- Merging touching polygons into one — **Dissolver**.
- Only the shared area of two layers — `ST_Intersection` in an **SQLTransformer**.

## Parameters

| Parameter | |
|---|---|
| Overlap count | name of the count attribute; default `_overlaps` |
| Accumulate attributes | attributes whose covering values are joined onto each face |
| List separator | text between accumulated values; default `;` |

## Output ports

| Port | |
|---|---|
| Output | one row per face: geometry, overlap count, accumulated attributes |

## Examples

- Two 2×2 squares overlapping in a 1×1 corner, accumulating `cat` → three faces: the corner with
  `_overlaps` 2 and `cat` `A;B`, and the two remainders with 1.
- Three squares with a common region → a face with depth 3 and `A;B;C`.

## Limitations

- Longitude/latitude input only: reproject a projected stream first.
- At most 20,000 input features: noding is superlinear and runs on the main thread, so the node
  refuses early rather than freezing the tab.
- Input attributes other than the accumulated ones do not reach the faces.

## Credits

JSTS (the JavaScript port of JTS) for noding and polygonizing.
