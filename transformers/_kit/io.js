// @ts-check
/* The writers, for sink transformers. */

import { runWriter } from "../../app/src/io/writers/index.js";

/**
 * Write one relation to a file in the browser's downloads.
 * @param {string} relation @param {string} format @param {string} fileName @param {string} crs
 */
export function writeView(relation, format, fileName, crs) {
  return runWriter(relation, format, fileName, { crs });
}
