/*
 * The inspection colour scheme.
 *
 * One palette, read by three places at once — the eye on a node, that node's
 * sheet tab in the attribute table, and its features on the map. Their sharing
 * a colour is the whole point: with several nodes inspected together, colour is
 * the only thing tying a shape on the map back to the node that produced it.
 *
 * Ordered so that the first few are as far apart as possible, since two or
 * three inspected nodes is the common case. Chosen against the light basemap
 * and the app's own greens, and kept distinguishable for the most common form
 * of colour blindness by varying lightness as well as hue.
 */

export const INSPECT_COLOURS = [
  "#318150", // sea green — the app's own
  "#c0563f", // brick
  "#316681", // payne's blue
  "#eca72c", // hunyadi yellow
  "#7b5aa6", // violet
  "#0f8b8d", // teal
  "#a4552f", // ochre
  "#5c7f1f", // olive
];

/** The colour for the nth inspected node; wraps rather than running out. */
export function inspectColour(index) {
  return INSPECT_COLOURS[index % INSPECT_COLOURS.length];
}
