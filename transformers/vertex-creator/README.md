# VertexCreator

Adds, inserts or replaces one vertex in every feature — or turns coordinate columns into points.

## What it does

A new vertex is made from **X**, **Y** and an optional **Z** value, each a constant, an attribute,
a formula or SQL. What happens to it depends on the mode and on each feature's geometry:

| Mode | Null | Point | Line | Polygon | Multi / collection |
|---|---|---|---|---|---|
| Add Point | point | line | longer line — or a polygon if it now closes | rejected | rejected |
| Replace with Point | point | point | point | point | point |
| Insert / Replace Point at Index | point | line / point | line | polygon, ring re-closed | rejected |

**Replace with Point** is how a spreadsheet of coordinates becomes a layer: X = `lon`, Y = `lat`,
and with **Remove Attributes** on, the two columns fold into the geometry. It works on a table with
no geometry at all, adding a `geometry` column. Its **Coordinate System** labels the stream below.

**Indexes** count from 0 at the first vertex; −1 is the last and other negatives count back from it;
out-of-range values clamp to the nearest end, so inserting at −1 appends. On a polygon they count the
exterior ring's corners (not its repeated closing vertex), and the ring is closed again afterwards.
A polygon with holes is rejected: "vertex 3" stops meaning one thing once there is more than one ring.

**Z**: when a 2D feature gets a vertex with a Z, *Compute* gives every vertex that Z, *Custom Value*
gives the old vertices the custom value, *None* drops Z. When a 3D feature gets a vertex without Z,
*Compute* interpolates it from the neighbours by planar distance (or takes the one neighbour's at an
end). Add Point on a 3D feature at either endpoint takes that endpoint's Z.

Rejected features keep every attribute plus `rejection_code`: `MISSING_COORDINATE`, `MISSING_INDEX`,
`UNSUPPORTED_GEOMETRY_TYPE` or `POLYGON_WITH_HOLES`.

## When to use it

- Turn `lon`/`lat` columns into points; turn Swiss `E`/`N` into points labelled EPSG:2056.
- Close a line into a polygon by adding its first point.
- Move or insert one vertex of every feature.

## When not to use it

- Any other geometry from attributes — an expression in **AttributeCreator**.
- Multi-part features — split them first; they are rejected here.

## Parameters

| Parameter | |
|---|---|
| Mode | Add Point, Replace with Point, Insert Point at Index, Replace Point at Index |
| X Value, Y Value | the new vertex's coordinates |
| Z Value (optional) | its Z; empty for 2D |
| Index | for the index modes: the position, from 0; negatives count from the end |
| Coordinate System | Replace with Point: the CRS of the new points, which labels the stream |
| Remove Attributes | drop the attributes X, Y and Z were read from |
| Measures/Z Conflict Value | Compute, None (Drop Values) or Custom Value |
| Custom Z | the Z for vertices without one, with Custom Value |
| Ignore Duplicated Coordinates | Add Point: skip a vertex equal to the last one |
| Closed Line Handling | Create Polygon or Create Line, for a line whose ends now meet |

## Output ports

| Port | |
|---|---|
| Output | the edited features |
| &lt;Rejected&gt; | features the mode cannot handle, untouched, with `rejection_code` |

## Examples

- `Bern, 7.44, 46.95` with Replace with Point, X = `lon`, Y = `lat`, Remove Attributes → a point
  with only `city`.
- `LINESTRING (0 0, 1 0, 1 1)` + Add Point (0 0) → `POLYGON ((0 0, 1 0, 1 1, 0 0))`.
- `LINESTRING Z (0 0 10, 2 0 20)` + insert (1 0) at index 1 with Compute → Z 15 in the middle.

## Limitations

- Measures (M values) are not supported and are dropped.
- Geometry is rebuilt as WKT, because this engine's `ST_MakeLine` is 2D only.

## Credits

Pure SQL: vertices are unpacked into a list, edited with list slicing, and written back as WKT.
