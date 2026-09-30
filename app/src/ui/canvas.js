/*
 * The node canvas: SVG, pointer events, no library.
 *
 * The whole scene is re-rendered on every change. That sounds wasteful and is
 * not: a graph is tens of nodes, and a full rebuild removes an entire class of
 * bug where the DOM and the model drift apart after an edit. Dragging is the
 * one exception — it moves a single transform per frame rather than rebuilding,
 * because that path runs at pointer rate.
 */

import {
  graph,
  addEdge,
  removeEdge,
  removeNode,
  nodeById,
  inputPorts,
  outputPorts,
  incomingEdge,
} from "../core/graph.js";
import { transformerFor } from "../../../transformers/legacy.js";

const SVG_NS = "http://www.w3.org/2000/svg";

export const NODE_WIDTH = 190;
const HEADER_HEIGHT = 28;
const PORT_ROW_HEIGHT = 18;
const PORT_TOP_OFFSET = 14;
/** How far left of a port's dot its eye sits. */
const EYE_PORT_GAP = 16;
const NODE_BOTTOM_PADDING = 10;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2.5;
const ARRANGE_COLUMN_GAP = 240;
const ARRANGE_ROW_GAP = 110;
/**
 * How near a port a dropped link has to land, in screen pixels.
 *
 * A port dot is 10px across, which is a small target to hit while dragging.
 * Divided by the zoom on use, so the pull feels the same however far out you
 * are zoomed.
 */
const SNAP_RADIUS_PX = 44;

let svg = null;
let root = null;
let callbacks = {};
let view = { x: 40, y: 40, k: 1 };
let selectedId = null;
let issuesByNode = new Map();
let drag = null;
// "nodeId:portId" -> row count, shown beside each output port.
let portCounts = new Map();
// nodeId -> its palette colour, for every node currently inspected. Empty means
// the bottom panels are following the selection instead.
let inspectedColours = new Map();

function el(tag, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== null && value !== undefined) node.setAttribute(key, String(value));
  }
  for (const child of children) node.appendChild(child);
  return node;
}

function text(content, attrs) {
  const node = el("text", attrs);
  node.textContent = content;
  return node;
}

export function nodeHeight(node) {
  const rows = Math.max(inputPorts(node).length, outputPorts(node).length, 1);
  return HEADER_HEIGHT + rows * PORT_ROW_HEIGHT + NODE_BOTTOM_PADDING;
}

function portPosition(node, portId, side) {
  const ports = side === "in" ? inputPorts(node) : outputPorts(node);
  const index = Math.max(
    0,
    ports.findIndex((port) => port.id === portId),
  );
  return {
    x: node.x + (side === "in" ? 0 : NODE_WIDTH),
    y: node.y + HEADER_HEIGHT + PORT_TOP_OFFSET + index * PORT_ROW_HEIGHT,
  };
}

/** Screen coordinates to graph coordinates. */
export function screenToWorld(clientX, clientY) {
  const rect = svg.getBoundingClientRect();
  return {
    x: (clientX - rect.left - view.x) / view.k,
    y: (clientY - rect.top - view.y) / view.k,
  };
}

function toWorld(event) {
  return screenToWorld(event.clientX, event.clientY);
}

/**
 * The nearest port of the given side to a point, within the snap radius.
 *
 * Computed from the model rather than by hit-testing the DOM, so the pull
 * starts well before the pointer is over the dot itself.
 */
function nearestPort(world, side) {
  const limit = SNAP_RADIUS_PX / view.k;
  let best = null;
  let bestDistance = limit;
  for (const node of graph.nodes) {
    for (const port of side === "in" ? inputPorts(node) : outputPorts(node)) {
      const position = portPosition(node, port.id, side);
      const distance = Math.hypot(world.x - position.x, world.y - position.y);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = { nodeId: node.id, portId: port.id, position };
      }
    }
  }
  return best;
}

/** Light up the port a drop would land on, so the snap is visible before it happens. */
function highlightSnap(target) {
  const key = target ? `${target.nodeId}:${target.portId}` : null;
  if (drag && drag.snapKey === key) return;
  root.querySelectorAll(".port.snap").forEach((element) => element.classList.remove("snap"));
  if (target) {
    const selector = `[data-node="${target.nodeId}"][data-port="${target.portId}"]`;
    root.querySelector(selector)?.classList.add("snap");
  }
  if (drag) drag.snapKey = key;
}

function edgePath(from, to) {
  // Horizontal control points: the curve leaves an output port going right and
  // enters an input port coming from the left, so a backwards edge still reads
  // as a connection instead of a straight line through the node.
  const dx = Math.max(40, Math.abs(to.x - from.x) * 0.5);
  return `M ${from.x} ${from.y} C ${from.x + dx} ${from.y}, ${to.x - dx} ${to.y}, ${to.x} ${to.y}`;
}

function renderEdges() {
  const group = el("g", { class: "edges" });
  for (const edge of graph.edges) {
    // The edge being rewired is represented by the drag preview instead.
    if (drag?.rewiring === edge.id) continue;
    const fromNode = nodeById(edge.from);
    const toNode = nodeById(edge.to);
    if (!fromNode || !toNode) continue;
    const d = edgePath(portPosition(fromNode, edge.fromPort, "out"), portPosition(toNode, edge.toPort, "in"));

    // An invisible fat path underneath: a 2px stroke is far too thin to grab,
    // and the whole point of picking a link up is that you can hit it.
    const hit = el("path", { d, class: "edge-hit", "data-edge": edge.id });
    const path = el("path", { d, class: "edge", "data-edge": edge.id });
    const remove = (event) => {
      event.stopPropagation();
      removeEdge(edge.id);
      callbacks.onChange?.();
    };
    hit.addEventListener("dblclick", remove);
    path.addEventListener("dblclick", remove);
    group.appendChild(hit);
    group.appendChild(path);
  }
  return group;
}

function renderPorts(node, group) {
  for (const port of inputPorts(node)) {
    const position = portPosition(node, port.id, "in");
    const connected = Boolean(incomingEdge(node.id, port.id));
    const circle = el("circle", {
      cx: position.x,
      cy: position.y,
      r: 5,
      class: `port port-in${connected ? " connected" : ""}`,
      "data-node": node.id,
      "data-port": port.id,
      "data-side": "in",
    });
    group.appendChild(circle);
    group.appendChild(text(port.label, { x: position.x + 10, y: position.y + 4, class: "port-label" }));
  }
  for (const port of outputPorts(node)) {
    const position = portPosition(node, port.id, "out");
    group.appendChild(
      el("circle", {
        cx: position.x,
        cy: position.y,
        r: 5,
        class: "port port-out",
        "data-node": node.id,
        "data-port": port.id,
        "data-side": "out",
      }),
    );
    renderEye(node, port, position.x - EYE_PORT_GAP, position.y, group);
    // Right-aligned, so its end has to clear the eye rather than the dot.
    const label = text(port.label, {
      x: position.x - EYE_PORT_GAP - 10,
      y: position.y + 4,
      class: "port-label port-label-out",
    });
    // How many features leave this port. A tspan rather than a
    // second text element so the pair stays right-aligned as one string,
    // whatever the label and the number happen to be.
    const count = portCounts.get(`${node.id}:${port.id}`);
    if (count !== undefined) {
      const badge = el("tspan", { class: "port-count" });
      badge.textContent = `  ${count.toLocaleString()}`;
      label.appendChild(badge);
    }
    group.appendChild(label);
  }
}

function renderNode(node) {
  const height = nodeHeight(node);
  const hasIssue = issuesByNode.has(node.id);
  const classes = ["node"];
  if (node.id === selectedId) classes.push("selected");
  if (hasIssue) classes.push("invalid");

  const group = el("g", { class: classes.join(" "), "data-node": node.id });
  group.appendChild(el("rect", { x: node.x, y: node.y, width: NODE_WIDTH, height, rx: 8, class: "node-body" }));
  group.appendChild(
    el("rect", {
      x: node.x,
      y: node.y,
      width: NODE_WIDTH,
      height: HEADER_HEIGHT,
      rx: 8,
      class: `node-header group-${transformerFor(node.type).group.toLowerCase()}`,
    }),
  );
  group.appendChild(text(node.type, { x: node.x + 10, y: node.y + 19, class: "node-title" }));
  if (hasIssue) {
    group.appendChild(text("!", { x: node.x + NODE_WIDTH - 34, y: node.y + 19, class: "node-warn" }));
  }
  // A Writer has no output port to hang an eye off, and what you want to see
  // there is what reaches it — so it keeps an eye in the header.
  if (!outputPorts(node).length) {
    renderEye(node, { id: "input", label: "Input" }, node.x + NODE_WIDTH - 16, node.y + HEADER_HEIGHT / 2, group, true);
  }
  renderPorts(node, group);
  return group;
}

/**
 * The inspect eye: pins the attribute and geometry panels to one output.
 *
 * One per output port, sitting just left of the port's dot, because a node can
 * have more than one thing leaving it and "inspect this node" was ambiguous the
 * moment a Tester was on the canvas. Both of a Tester's ports can now be lit at
 * once, which is the whole point of having passed and failed side by side.
 *
 * Separate from selection on purpose — selecting a node opens its parameters,
 * and the common move while tuning a filter is to watch what comes out of a
 * node further down. Without this the two are the same gesture and you cannot
 * do both at once.
 */
function renderEye(node, port, cx, cy, group, onHeader = false) {
  const key = `${node.id}:${port.id}`;
  const colour = inspectedColours.get(key);
  const eye = el("g", {
    class: `eye${colour ? " on" : ""}${onHeader ? " eye-header" : ""}`,
    "data-eye": key,
    transform: `translate(${cx} ${cy})`,
  });
  // SVG has no title attribute; a <title> child is how a tooltip is spelled.
  const tip = el("title");
  tip.textContent = colour
    ? `Inspecting ${port.label}: click to unpin, shift-click to drop from the comparison`
    : `Inspect ${port.label}. Shift-click (or alt-click) to compare several at once.`;
  eye.appendChild(tip);
  // An invisible box behind the glyph: 12px of eye is too small to click. Kept
  // shorter than PORT_ROW_HEIGHT so two stacked eyes cannot overlap each other.
  eye.appendChild(el("rect", { x: -9, y: -8, width: 18, height: 16, fill: "transparent" }));
  // A lit eye wears the node's own palette colour — the same one its features
  // get on the map and its tab gets in the attribute table.
  //
  // Set as inline style, not as a stroke/fill attribute: a stylesheet rule
  // beats a presentation attribute, so `.eye.on` would repaint every lit eye
  // the same colour and quietly break the whole point of the palette.
  const outline = el("path", { d: "M -6 0 Q 0 -4.5 6 0 Q 0 4.5 -6 0 Z", class: "eye-outline" });
  const pupil = el("circle", { cx: 0, cy: 0, r: 1.8, class: "eye-pupil" });
  if (colour) {
    outline.style.stroke = colour;
    pupil.style.fill = colour;
  }
  eye.appendChild(outline);
  eye.appendChild(pupil);
  group.appendChild(eye);
}

export function render() {
  if (!svg) return;
  root.replaceChildren();
  root.setAttribute("transform", `translate(${view.x} ${view.y}) scale(${view.k})`);
  root.appendChild(renderEdges());
  const nodes = el("g", { class: "nodes" });
  for (const node of graph.nodes) nodes.appendChild(renderNode(node));
  root.appendChild(nodes);
  if (drag?.kind === "edge" && drag.preview) root.appendChild(drag.preview);
}

function startEdgeDrag(event, nodeId, portId) {
  const node = nodeById(nodeId);
  const origin = portPosition(node, portId, "out");
  const preview = el("path", { class: "edge edge-preview", d: edgePath(origin, origin) });
  drag = { kind: "edge", from: nodeId, fromPort: portId, origin, preview };
  root.appendChild(preview);
}

/**
 * Pick an existing link up and move one of its ends.
 *
 * Which end moves is decided by which one you grabbed nearer to, so the gesture
 * matches the intent without a modifier key. The edge is not deleted up front:
 * it is only replaced once the drop lands on a valid port, so letting go over
 * empty canvas puts it back rather than destroying it.
 */
function startEdgeRewire(event, edgeId, forceEnd) {
  const edge = graph.edges.find((candidate) => candidate.id === edgeId);
  if (!edge) return;
  const fromNode = nodeById(edge.from);
  const toNode = nodeById(edge.to);
  if (!fromNode || !toNode) return;

  const sourceEnd = portPosition(fromNode, edge.fromPort, "out");
  const targetEnd = portPosition(toNode, edge.toPort, "in");
  const cursor = toWorld(event);
  const nearTarget =
    forceEnd === "target" ||
    (forceEnd !== "source" &&
      Math.hypot(cursor.x - targetEnd.x, cursor.y - targetEnd.y) <=
        Math.hypot(cursor.x - sourceEnd.x, cursor.y - sourceEnd.y));

  const preview = el("path", { class: "edge edge-preview" });
  drag = nearTarget
    ? // The input end follows the pointer; the output end stays anchored.
      { kind: "edge", from: edge.from, fromPort: edge.fromPort, origin: sourceEnd, preview, rewiring: edgeId }
    : // The output end follows the pointer instead, so we are hunting an output.
      { kind: "edge", to: edge.to, toPort: edge.toPort, origin: targetEnd, preview, rewiring: edgeId, reverse: true };
  preview.setAttribute("d", nearTarget ? edgePath(sourceEnd, cursor) : edgePath(cursor, targetEnd));
  render();
}

function startNodeDrag(event, nodeId) {
  const node = nodeById(nodeId);
  const world = toWorld(event);
  drag = { kind: "node", nodeId, offsetX: world.x - node.x, offsetY: world.y - node.y, moved: false };
  select(nodeId);
}

function onPointerDown(event) {
  // Touching the canvas gives it the keyboard, which is what makes the Delete
  // gate above meaningful.
  svg.focus({ preventScroll: true });
  const target = event.target;
  const portNode = target.closest?.("[data-side]");
  if (portNode) {
    event.preventDefault();
    const side = portNode.getAttribute("data-side");
    const nodeId = portNode.getAttribute("data-node");
    const portId = portNode.getAttribute("data-port");
    if (side === "out") {
      startEdgeDrag(event, nodeId, portId);
    } else {
      // Grabbing a connected input port picks that link up, same as grabbing
      // the link itself near this end.
      const edge = incomingEdge(nodeId, portId);
      if (edge) startEdgeRewire(event, edge.id, "target");
    }
    return;
  }

  const eyeEl = target.closest?.("[data-eye]");
  if (eyeEl) {
    event.preventDefault();
    // Any modifier adds to the inspected set instead of replacing it. Alt alone
    // would be neater, but window managers and browsers claim Option/Alt-click
    // often enough that a single modifier is a bad thing to depend on — and
    // Shift is the conventional "extend the selection" gesture anyway.
    const add = event.altKey || event.shiftKey || event.metaKey || event.ctrlKey;
    callbacks.onInspect?.(eyeEl.getAttribute("data-eye"), { add });
    return;
  }

  const edgeEl = target.closest?.("[data-edge]");
  if (edgeEl) {
    event.preventDefault();
    startEdgeRewire(event, edgeEl.getAttribute("data-edge"));
    return;
  }

  const nodeEl = target.closest?.("[data-node]");
  if (nodeEl) {
    event.preventDefault();
    startNodeDrag(event, nodeEl.getAttribute("data-node"));
    return;
  }

  drag = { kind: "pan", startX: event.clientX - view.x, startY: event.clientY - view.y };
  select(null);
}

function onPointerMove(event) {
  if (!drag) return;
  if (drag.kind === "pan") {
    view.x = event.clientX - drag.startX;
    view.y = event.clientY - drag.startY;
    root.setAttribute("transform", `translate(${view.x} ${view.y}) scale(${view.k})`);
    return;
  }
  if (drag.kind === "node") {
    const world = toWorld(event);
    const node = nodeById(drag.nodeId);
    if (!node) return;
    node.x = Math.round(world.x - drag.offsetX);
    node.y = Math.round(world.y - drag.offsetY);
    drag.moved = true;
    render();
    return;
  }
  if (drag.kind === "edge") {
    const cursor = toWorld(event);
    const target = nearestPort(cursor, drag.reverse ? "out" : "in");
    highlightSnap(target);
    // Draw to the port it would snap to, not to the pointer — the line itself
    // tells you where letting go will put it.
    const end = target ? target.position : cursor;
    drag.preview.setAttribute("d", drag.reverse ? edgePath(end, drag.origin) : edgePath(drag.origin, end));
  }
}

function onPointerUp(event) {
  if (!drag) return;
  if (drag.kind === "edge") {
    // Snap by proximity rather than by what is under the pointer: the same
    // rule that drew the preview decides the drop, so what you saw is what
    // you get. A reversed drag is looking for an output to feed its input.
    const target = nearestPort(toWorld(event), drag.reverse ? "out" : "in");
    if (target) {
      // Only now is the original link given up, so a missed drop costs nothing.
      if (drag.rewiring) removeEdge(drag.rewiring);
      if (drag.reverse) addEdge(target.nodeId, target.portId, drag.to, drag.toPort);
      else addEdge(drag.from, drag.fromPort, target.nodeId, target.portId);
      drag = null;
      highlightSnap(null);
      callbacks.onChange?.();
      return;
    }
  }
  highlightSnap(null);
  const wasNodeMove = drag.kind === "node" && drag.moved;
  drag = null;
  render();
  if (wasNodeMove) callbacks.onLayoutChange?.();
}

function onWheel(event) {
  event.preventDefault();
  const rect = svg.getBoundingClientRect();
  const pointerX = event.clientX - rect.left;
  const pointerY = event.clientY - rect.top;
  const factor = Math.exp(-event.deltaY * 0.0015);
  const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.k * factor));
  // Keep the point under the cursor fixed while zooming.
  view.x = pointerX - ((pointerX - view.x) * next) / view.k;
  view.y = pointerY - ((pointerY - view.y) * next) / view.k;
  view.k = next;
  render();
}

function onKeyDown(event) {
  if (event.key !== "Delete" && event.key !== "Backspace") return;
  // Positive check, not "is the focus in a text field": when the inspector
  // rebuilds under you the field you were typing in is destroyed and focus
  // falls back to the body, where a tagName test sees nothing to veto and a
  // Backspace meant for a character deletes the node instead. Deleting a node
  // is a canvas action, so require the canvas to actually hold focus.
  if (!svg.contains(document.activeElement)) return;
  if (!selectedId) return;
  event.preventDefault();
  removeNode(selectedId);
  select(null);
  callbacks.onChange?.();
}

export function select(nodeId) {
  if (selectedId === nodeId) return;
  selectedId = nodeId;
  render();
  callbacks.onSelect?.(nodeId);
}

export function selected() {
  return selectedId;
}

/** Light the eye on each inspected node, in its palette colour. */
/** Colours keyed "nodeId:portId" — one entry per inspected output. */
export function setInspected(colourByKey) {
  inspectedColours = colourByKey || new Map();
  render();
}

/** Row counts to show on output ports, keyed "nodeId:portId". */
export function setPortCounts(counts) {
  portCounts = counts;
  render();
}

export function setIssues(issues) {
  issuesByNode = new Map();
  for (const issue of issues) {
    if (!issue.nodeId) continue;
    const existing = issuesByNode.get(issue.nodeId) || [];
    existing.push(issue);
    issuesByNode.set(issue.nodeId, existing);
  }
  render();
}

/**
 * Lay the graph out left to right by dependency depth.
 *
 * Depth is the longest path from a source, not the shortest: with the shortest,
 * a node fed by both a Reader and a long branch would sit on top of its own
 * upstream.
 */
export function arrange() {
  const depth = new Map();
  const resolve = (nodeId, seen = new Set()) => {
    if (depth.has(nodeId)) return depth.get(nodeId);
    if (seen.has(nodeId)) return 0;
    seen.add(nodeId);
    const parents = graph.edges.filter((edge) => edge.to === nodeId);
    const value = parents.length ? Math.max(...parents.map((edge) => resolve(edge.from, seen) + 1)) : 0;
    depth.set(nodeId, value);
    return value;
  };
  for (const node of graph.nodes) resolve(node.id);

  const perColumn = new Map();
  for (const node of graph.nodes) {
    const column = depth.get(node.id) || 0;
    const row = perColumn.get(column) || 0;
    node.x = 40 + column * ARRANGE_COLUMN_GAP;
    node.y = 40 + row * ARRANGE_ROW_GAP;
    perColumn.set(column, row + 1);
  }
  render();
  callbacks.onLayoutChange?.();
}

export function initCanvas(svgElement, handlers) {
  svg = svgElement;
  callbacks = handlers || {};
  // Focusable so it can own the keyboard; an SVG is not focusable by default.
  svg.setAttribute("tabindex", "0");
  root = el("g", { class: "viewport" });
  svg.replaceChildren(root);
  svg.addEventListener("pointerdown", onPointerDown);
  svg.addEventListener("wheel", onWheel, { passive: false });
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("keydown", onKeyDown);
  render();
}
