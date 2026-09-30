/*
 * WKB → GeoJSON decoder.
 *
 * Geometry travels from DuckDB to the map as WKB bytes rather than as
 * ST_AsGeoJSON text: the bytes are roughly half the size and skip a JSON parse
 * per feature, which matters when a leaf tile holds tens of thousands of
 * polygons.
 *
 * Handles the seven basic ISO WKB types. Z/M coordinates are recognised (the
 * type code carries 1000/2000/3000) and their extra ordinates are read and
 * dropped, because MapLibre draws in 2D and a stray third ordinate silently
 * shifts nothing but wastes memory.
 */

const TYPE_POINT = 1;
const TYPE_LINESTRING = 2;
const TYPE_POLYGON = 3;
const TYPE_MULTIPOINT = 4;
const TYPE_MULTILINESTRING = 5;
const TYPE_MULTIPOLYGON = 6;
const TYPE_GEOMETRYCOLLECTION = 7;

const GEOJSON_TYPE = {
  [TYPE_POINT]: "Point",
  [TYPE_LINESTRING]: "LineString",
  [TYPE_POLYGON]: "Polygon",
  [TYPE_MULTIPOINT]: "MultiPoint",
  [TYPE_MULTILINESTRING]: "MultiLineString",
  [TYPE_MULTIPOLYGON]: "MultiPolygon",
};

/**
 * Coerce whatever DuckDB handed back into bytes.
 *
 * A BLOB can arrive as a Uint8Array, as an ArrayBuffer, or — when it has come
 * through a JSON round-trip — as a binary string, one byte per char code.
 */
export function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value === "string") {
    const out = new Uint8Array(value.length);
    for (let i = 0; i < value.length; i++) out[i] = value.charCodeAt(i) & 0xff;
    return out;
  }
  return new Uint8Array(value);
}

export function decodeWKB(input) {
  const bytes = toBytes(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;

  function readGeometry() {
    const little = view.getUint8(pos) === 1;
    pos += 1;
    const rawType = view.getUint32(pos, little);
    pos += 4;
    // 1000 = Z, 2000 = M, 3000 = ZM. The base type is the remainder; the extra
    // ordinates change how many floats each coordinate carries.
    const baseType = rawType % 1000;
    const flavour = Math.floor(rawType / 1000);
    const extraOrdinates = flavour === 3 ? 2 : flavour === 1 || flavour === 2 ? 1 : 0;

    if (baseType === TYPE_POINT) {
      return { type: "Point", coordinates: readCoordinate(little, extraOrdinates) };
    }
    if (baseType === TYPE_LINESTRING) {
      return { type: "LineString", coordinates: readCoordinateArray(little, extraOrdinates) };
    }
    if (baseType === TYPE_POLYGON) {
      return { type: "Polygon", coordinates: readRings(little, extraOrdinates) };
    }
    if (baseType === TYPE_MULTIPOINT || baseType === TYPE_MULTILINESTRING || baseType === TYPE_MULTIPOLYGON) {
      const count = view.getUint32(pos, little);
      pos += 4;
      const parts = new Array(count);
      // Each part carries its own byte order and type header, so recurse rather
      // than assuming the parent's endianness.
      for (let i = 0; i < count; i++) parts[i] = readGeometry().coordinates;
      return { type: GEOJSON_TYPE[baseType], coordinates: parts };
    }
    if (baseType === TYPE_GEOMETRYCOLLECTION) {
      const count = view.getUint32(pos, little);
      pos += 4;
      const geometries = new Array(count);
      for (let i = 0; i < count; i++) geometries[i] = readGeometry();
      return { type: "GeometryCollection", geometries };
    }
    throw new Error(`Unsupported WKB geometry type ${rawType}`);
  }

  function readCoordinate(little, extraOrdinates) {
    const x = view.getFloat64(pos, little);
    const y = view.getFloat64(pos + 8, little);
    pos += 16 + extraOrdinates * 8;
    return [x, y];
  }

  function readCoordinateArray(little, extraOrdinates) {
    const count = view.getUint32(pos, little);
    pos += 4;
    const coordinates = new Array(count);
    for (let i = 0; i < count; i++) coordinates[i] = readCoordinate(little, extraOrdinates);
    return coordinates;
  }

  function readRings(little, extraOrdinates) {
    const count = view.getUint32(pos, little);
    pos += 4;
    const rings = new Array(count);
    for (let i = 0; i < count; i++) rings[i] = readCoordinateArray(little, extraOrdinates);
    return rings;
  }

  return readGeometry();
}
