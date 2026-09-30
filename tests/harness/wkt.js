/*
 * A small WKT reader for exact geometry comparison.
 *
 * JSTS parses WKT too, but it forgets whether a geometry was written with Z and
 * normalises some forms; the exact comparison needs the geometry exactly as the
 * engine wrote it. Returns { type, z, parts } where parts nest like GeoJSON
 * coordinates, or { type, empty: true }.
 */

export function parseWkt(text) {
  const src = String(text).trim();
  let i = 0;
  const peek = () => src[i];
  const skip = () => {
    while (i < src.length && /\s/.test(src[i])) i++;
  };
  const word = () => {
    skip();
    const start = i;
    while (i < src.length && /[A-Za-z]/.test(src[i])) i++;
    return src.slice(start, i).toUpperCase();
  };
  const expect = (ch) => {
    skip();
    if (src[i] !== ch) throw new Error(`WKT: expected "${ch}" at ${i} in ${src}`);
    i++;
  };
  const number = () => {
    skip();
    const start = i;
    while (i < src.length && /[-+0-9.eE]/.test(src[i])) i++;
    if (start === i) throw new Error(`WKT: expected a number at ${i} in ${src}`);
    return Number(src.slice(start, i));
  };
  const point = () => {
    const coords = [number(), number()];
    skip();
    while (peek() && /[-+0-9.]/.test(peek())) {
      coords.push(number());
      skip();
    }
    return coords;
  };
  const list = (item) => {
    expect("(");
    const out = [item()];
    skip();
    while (peek() === ",") {
      i++;
      out.push(item());
      skip();
    }
    expect(")");
    return out;
  };
  const maybeParenPoint = () => {
    skip();
    if (peek() === "(") {
      i++;
      const p = point();
      expect(")");
      return p;
    }
    return point();
  };

  function geometry() {
    const type = word();
    let modifier = word();
    let z = false;
    if (modifier === "Z" || modifier === "ZM") z = true;
    else if (modifier === "M") z = false;
    else if (modifier === "EMPTY") return { type, z, empty: true };
    else if (modifier) throw new Error(`WKT: unexpected "${modifier}"`);
    skip();
    if (src.slice(i, i + 5).toUpperCase() === "EMPTY") {
      i += 5;
      return { type, z, empty: true };
    }
    let parts;
    switch (type) {
      case "POINT":
        expect("(");
        parts = point();
        expect(")");
        break;
      case "LINESTRING":
        parts = list(point);
        break;
      case "POLYGON":
        parts = list(() => list(point));
        break;
      case "MULTIPOINT":
        parts = list(maybeParenPoint);
        break;
      case "MULTILINESTRING":
        parts = list(() => list(point));
        break;
      case "MULTIPOLYGON":
        parts = list(() => list(() => list(point)));
        break;
      case "GEOMETRYCOLLECTION":
        parts = list(geometry);
        break;
      default:
        throw new Error(`WKT: unsupported type ${type}`);
    }
    return { type, z, parts };
  }

  const out = geometry();
  skip();
  if (i !== src.length) throw new Error(`WKT: trailing text in ${src}`);
  return out;
}
