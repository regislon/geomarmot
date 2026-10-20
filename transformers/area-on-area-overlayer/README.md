# AreaOnAreaOverlayer

Splits overlapping polygons into non-overlapping faces, counting and listing what covers each.

## What it does

All the input polygons are overlaid **at once**. Each output row is one atomic face (one of the
smallest pieces the boundaries cut the plane into), with:

- `_overlaps` (or the name you choose): how many input polygons cover the face;
- for each attribute you accumulate, the distinct values of the covering polygons, sorted and
  joined by the separator (`A;B`);
- with an **ID attribute**, `face_id`. **Memberships** then has one row per face and covering
  feature: `face_id`, `layer` (from the **Layer attribute**, when several layers were combined
  upstream with Unioner) and `feature_id`.

**How it works:**

1. Every boundary is noded and the result polygonized into faces. This runs with GEOS, compiled to
   WebAssembly and running in background workers, so the page stays responsive.
2. A face's covering polygons are found from an interior point, which is **certified** to lie clear
   of the face's boundary.
3. A face too thin for any such point is never guessed. It goes to **Rejected** as
   `ambiguous_face`, or stops the run with **Fail**. Such faces are typically slivers between nearly
   coincident boundaries.

The rest is SQL.

## When to use it

- Find where plots overlap, and how deeply.
- Partition overlapping buffers into non-overlapping pieces.
- List which zones cover each piece of land.
- Cross-reference two boundary layers: which unit of one covers which unit of the other.

## When not to use it

- Merging touching polygons into one: use **Dissolver**.
- Only the shared area of two layers: use `ST_Intersection` in an **SQLTransformer**.

## Parameters

| Parameter | |
|---|---|
| Overlap count | name of the count attribute; default `_overlaps` |
| Accumulate attributes | attributes whose covering values are joined onto each face |
| List separator | text between accumulated values; default `;` |
| ID attribute | identifies each feature; when set, Memberships is filled and Output gains `face_id` |
| Layer attribute | which layer a feature belongs to; IDs need only be unique within a layer |
| Uncertain faces | `Drop and report` (default) lists them in Rejected; `Fail` stops with an error |
| Invalid polygons | `Reject` (default) sends them to Rejected; `Repair` fixes them with ST_MakeValid first |

## Output ports

| Port | |
|---|---|
| Output | one row per face: geometry, overlap count, accumulated attributes, and `face_id` with an ID attribute |
| Memberships | with an ID attribute: `face_id`, `layer`, `feature_id` for every covering feature; empty without one |
| &lt;Rejected&gt; | features not overlaid, untouched, plus uncertain faces, each with `rejection_code` |

`rejection_code` values:

- `no_geometry`, `no_polygon`, `invalid_geometry`: about the feature's geometry;
- `missing_id`, `duplicate_id`: only with an ID attribute;
- `ambiguous_face`: a face too thin to certify.

## Examples

- Two 2×2 squares overlapping in a 1×1 corner, accumulating `cat`, give three faces: the corner with
  `_overlaps` 2 and `cat` `A;B`, and the two remainders with 1.
- Districts and parishes combined with Unioner, with Layer attribute `layer` and ID attribute `code`:
  Memberships says, for every face, which district and which parish cover it.

## Limitations

- Longitude/latitude input only: reproject a projected stream first.
- At most 200,000 input features. Detail matters more than the count: each background worker has at
  most 4 GB, and very detailed polygons that all touch reach it sooner.
- Input attributes other than the accumulated ones do not reach the faces. Join Memberships back to
  the input by ID instead.

## Credits

GEOS (`geos-wasm`) for noding, polygonizing and the interior-point checks.
