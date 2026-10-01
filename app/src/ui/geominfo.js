/*
 * What one feature's geometry actually is — a feature inspector, for the
 * row you clicked.
 *
 * The geometry arrives with the table page rather than being looked up: the
 * view has no stable key to look a row up by, and re-querying by offset would
 * trust an ordering DuckDB never promised. That is the same reason the map's
 * zoom-to-feature works the way it does, and it means this panel costs one
 * round trip on click and nothing at all before that.
 *
 * The bytes go back to DuckDB as a registered buffer, read with read_blob:
 * inlined into the SQL as a hex literal, an administrative boundary's
 * megabytes of WKB ran the Wasm parser out of memory.
 *
 * The panel also lists every attribute of the row, since a wide table shows
 * only the first few columns at a time.
 */

import { guardedRead } from "./read-guard.js";
import { db, readQuery, qlit } from "../core/duck.js";
import { cellToWkb } from "../engines/h3/index.js";
import { decodeWKB, toBytes } from "../core/wkb.js";
import { isLonLatCode, LONLAT } from "../core/schema.js";

/** Past this the WKT is cut for display; the copy button still gets it whole. */
const WKT_PREVIEW_CHARS = 4000;

/**
 * Winding of the outer ring, by the shoelace sign.
 *
 * DuckDB's spatial build has no ST_IsCCW, and this is the one fact in the
 * panel that has to be computed here rather than asked for. It is worded as a
 * hand rule as well as a direction, since people look for either.
 */
function orientationOf(shape) {
  const ring =
    shape?.type === "Polygon"
      ? shape.coordinates?.[0]
      : shape?.type === "MultiPolygon"
        ? shape.coordinates?.[0]?.[0]
        : null;
  if (!ring || ring.length < 4) return null;
  let twiceArea = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    twiceArea += x1 * y2 - x2 * y1;
  }
  if (twiceArea === 0) return null;
  return twiceArea > 0 ? "Counter-clockwise (right hand rule)" : "Clockwise (left hand rule)";
}

/** The WKB for a picked row, whichever way its geometry travelled. */
function pickedBytes(pick) {
  if (pick?.kind === "h3") return toBytes(cellToWkb(pick.value));
  return toBytes(pick?.value);
}

/**
 * Everything the panel shows, for one feature.
 *
 * Area and length are measured in EPSG:6933 rather than in the stream's own
 * units, the same way AddGeometryAttributes does it — square degrees is not an
 * area, and a projected CRS's own square metres are not equal-area either. The
 * extents stay in the stream's units, because those are the numbers that match
 * what a Reader or a Writer would show.
 */
let featureSeq = 0;

export async function describeFeature(pick, crs = LONLAT) {
  const bytes = pickedBytes(pick);
  if (!bytes?.length) throw new Error("This row carries no geometry.");
  const file = `__feature_${++featureSeq}.wkb`;
  await db().registerFileBuffer(file, bytes.slice());
  const from = `(SELECT ST_GeomFromWKB(content) AS g FROM read_blob(${qlit(file)})) AS feature`;
  let base;
  let rings = null;
  try {
    base = (
      await guardedRead(() =>
        readQuery(
          `SELECT ST_GeometryType(g)::VARCHAR AS type,
              ST_Dimension(g) AS dimension,
              ST_NPoints(g) AS vertices,
              ST_NumGeometries(g) AS parts,
              ST_IsEmpty(g) AS is_empty,
              ST_IsValid(g) AS is_valid,
              ST_IsSimple(g) AS is_simple,
              ST_HasZ(g) AS has_z,
              ST_HasM(g) AS has_m,
              ST_XMin(g) AS xmin, ST_YMin(g) AS ymin,
              ST_XMax(g) AS xmax, ST_YMax(g) AS ymax,
              ST_Area(ST_Transform(g, ${qlit(crs)}, 'EPSG:6933', always_xy := true)) AS area_m2,
              ST_Length(ST_Transform(g, ${qlit(crs)}, 'EPSG:6933', always_xy := true)) AS length_m,
              ST_Perimeter(ST_Transform(g, ${qlit(crs)}, 'EPSG:6933', always_xy := true)) AS perimeter_m,
              ST_AsText(g) AS wkt
           FROM ${from}`,
        ),
      )
    )[0];

    // ST_ExteriorRing and ST_NInteriorRings are polygon-only and raise on
    // anything else, so they are asked for separately rather than guarded with a
    // CASE that DuckDB would evaluate regardless.
    if (base.type === "POLYGON") {
      rings = (
        await guardedRead(() =>
          readQuery(
            `SELECT ST_NInteriorRings(g) AS holes,
                ST_IsClosed(ST_ExteriorRing(g)) AS closed,
                ST_IsRing(ST_ExteriorRing(g)) AS is_ring,
                ST_Equals(g, ST_ConvexHull(g)) AS convex
             FROM ${from}`,
          ),
        )
      )[0];
    }
  } finally {
    await db()
      .dropFile(file)
      .catch(() => {});
  }

  let shape = null;
  try {
    shape = decodeWKB(bytes);
  } catch (err) {
    console.warn("Could not decode the picked geometry for its winding", err);
  }

  return {
    crs,
    lonLat: isLonLatCode(crs),
    cell: pick?.kind === "h3" ? String(pick.value) : null,
    ...base,
    rings,
    orientation: orientationOf(shape),
    wkt: base.wkt || "",
    attributes: pick?.attributes || [],
  };
}

export { WKT_PREVIEW_CHARS };

/* ---------- rendering ---------- */

function row(label, value) {
  const line = document.createElement("div");
  line.className = "geo-row";
  const key = document.createElement("span");
  key.className = "geo-key";
  key.textContent = label;
  const val = document.createElement("span");
  val.className = "geo-value";
  val.textContent = value;
  line.append(key, val);
  return line;
}

function section(title) {
  const heading = document.createElement("h3");
  heading.className = "geo-section";
  heading.textContent = title;
  return heading;
}

const yesNo = (value) => (value ? "Yes" : "No");

/** Enough places to keep metres honest without printing float noise. */
function coordinate(value) {
  if (value === null || value === undefined) return "—";
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: 6, useGrouping: false });
}

function measurement(value, unit, divisor) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return `${(value / divisor).toLocaleString(undefined, { maximumFractionDigits: 4 })} ${unit}`;
}

/**
 * Fill the panel for one feature.
 *
 * The order: what the geometry is, then where it is, then the per-shape
 * questions.
 */
/** An attribute value as text: numbers and dates readable, nulls as null, nested values as JSON. */
function attributeText(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number")
    return Number.isInteger(value) ? String(value) : value.toLocaleString(undefined, { maximumFractionDigits: 10 });
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v));
  return String(value);
}

export function renderFeature(container, info) {
  container.replaceChildren();

  if (info.attributes?.length) {
    container.appendChild(section(`Attributes (${info.attributes.length})`));
    for (const [name, value] of info.attributes) {
      const line = row(name, attributeText(value));
      if (value === null || value === undefined) line.classList.add("null");
      container.appendChild(line);
    }
  }

  container.appendChild(section("Geometry"));
  container.appendChild(row("Coordinate system", info.lonLat ? `${info.crs} (longitude/latitude)` : info.crs));
  if (info.cell) container.appendChild(row("H3 cell", info.cell));
  container.appendChild(row("Type", info.type || "unknown"));
  container.appendChild(row("Dimension", info.has_z ? "3D" : "2D"));
  if (info.has_m) container.appendChild(row("Measures", "Yes (M values present)"));
  container.appendChild(row("Number of vertices", Number(info.vertices ?? 0).toLocaleString()));
  if (Number(info.parts) > 1) container.appendChild(row("Parts", Number(info.parts).toLocaleString()));
  container.appendChild(row("Empty", yesNo(info.is_empty)));

  container.appendChild(section("Extents"));
  const units = info.lonLat ? "degrees" : `${info.crs} units`;
  container.appendChild(row("Min extents", `${coordinate(info.xmin)}, ${coordinate(info.ymin)}`));
  container.appendChild(row("Max extents", `${coordinate(info.xmax)}, ${coordinate(info.ymax)}`));
  container.appendChild(row("Extent units", units));

  // Measured in EPSG:6933, so the numbers mean the same thing whatever the
  // stream is in. Only shown where the dimension makes them meaningful.
  const area = Number(info.dimension) >= 2 ? measurement(info.area_m2, "ha", 10_000) : null;
  const perimeter = Number(info.dimension) >= 2 ? measurement(info.perimeter_m, "km", 1000) : null;
  const length = Number(info.dimension) === 1 ? measurement(info.length_m, "km", 1000) : null;
  if (area || perimeter || length) {
    container.appendChild(section("Measured (equal-area, EPSG:6933)"));
    if (area) container.appendChild(row("Area", area));
    if (perimeter) container.appendChild(row("Perimeter", perimeter));
    if (length) container.appendChild(row("Length", length));
  }

  container.appendChild(section("Shape"));
  container.appendChild(row("Valid", yesNo(info.is_valid)));
  container.appendChild(row("Simple", yesNo(info.is_simple)));
  if (info.rings) {
    container.appendChild(row("Closed", info.rings.closed ? "Closed in 2D" : "Not closed"));
    container.appendChild(row("Linear boundary", yesNo(info.rings.is_ring)));
    container.appendChild(row("Convex", yesNo(info.rings.convex)));
    container.appendChild(row("Holes", Number(info.rings.holes ?? 0).toLocaleString()));
  }
  if (info.orientation) container.appendChild(row("Orientation", info.orientation));

  const head = section("Coordinates");
  const copy = document.createElement("button");
  copy.className = "geo-copy";
  copy.textContent = "⧉";
  copy.title = "Copy the full WKT";
  copy.addEventListener("click", () => {
    navigator.clipboard.writeText(info.wkt).catch((err) => console.warn("Clipboard write refused", err));
  });
  head.appendChild(copy);
  container.appendChild(head);

  const wkt = document.createElement("pre");
  wkt.className = "geo-wkt";
  // Cut for display only: a hundred-thousand-vertex polygon would otherwise
  // lock the panel up, and the copy button still hands over the whole thing.
  wkt.textContent =
    info.wkt.length > WKT_PREVIEW_CHARS
      ? `${info.wkt.slice(0, WKT_PREVIEW_CHARS)}\n… ${(info.wkt.length - WKT_PREVIEW_CHARS).toLocaleString()} more characters — use the copy button for all of it`
      : info.wkt;
  container.appendChild(wkt);
}
