/* GeoPackage, GeoJSON and FlatGeobuf through GDAL: one source per layer. */

import { qlit, query } from "../../core/duck.js";
import { introspect, sources } from "../sources.js";

/** CRS of a layer as GDAL reports it, which beats guessing from a WKT string. */
function crsFromOgrLayer(layer) {
  const crs = layer?.geometry_fields?.[0]?.crs;
  if (crs?.auth_name && crs?.auth_code) {
    return { code: `${crs.auth_name}:${crs.auth_code}`, assumed: false };
  }
  return { code: crs?.name || "unknown", assumed: !crs };
}

/**
 * Split an OGR file into one source per layer.
 *
 * A GeoPackage is a container, and its layers are what people actually think
 * of as datasets — so each becomes its own row in the Layers rail rather than
 * hiding behind a picker on the Reader.
 */
export async function ogrLayerSources(base) {
  let layers = [];
  try {
    const meta = await query(`SELECT layers FROM st_read_meta(${qlit(base.fileName)})`);
    layers = meta[0]?.layers || [];
  } catch (err) {
    console.warn(`Could not list layers in ${base.name}`, err);
  }
  if (layers.length <= 1) {
    const only = layers[0];
    const source = { ...base, layer: only?.name || null, crs: crsFromOgrLayer(only) };
    await introspect(source);
    sources.set(source.id, source);
    return [source];
  }

  const made = [];
  for (const layer of layers) {
    const source = {
      ...base,
      id: `${base.id}#${layer.name}`,
      name: `${base.name} › ${layer.name}`,
      layer: layer.name,
      crs: crsFromOgrLayer(layer),
    };
    await introspect(source);
    sources.set(source.id, source);
    made.push(source);
  }
  return made;
}

/*
 * Report a failed OGR open in terms of the format the name promised.
 *
 * Only `.json` needs the translation: it is the one extension the app accepts
 * on spec rather than on evidence, so the file that lands here is as likely to
 * be a config file or a saved graph as a broken GeoJSON, and GDAL's own
 * wording explains neither.
 */
export function ogrOpenError(base, err) {
  if (!/\.json$/i.test(base.name)) return err;
  // GDAL quotes the registered name, which carries the uniquifying prefix and
  // reads like a second, unfamiliar file in the same sentence.
  const detail = (err?.message || String(err)).split(base.fileName).join(base.name);
  return new Error(`${base.name} is not GeoJSON — GDAL could not read it (${detail})`);
}
