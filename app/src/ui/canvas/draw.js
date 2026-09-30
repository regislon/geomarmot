/*
 * Drawing the canvas: layout constants, the shared canvas state, nodes, ports,
 * edges and the inspection eyes.
 */

import { transformerFor } from "../../../../transformers/legacy.js";
import { graph, incomingEdge, inputPorts, nodeById, outputPorts, removeEdge } from "../../core/graph.js";

const SVG_NS = "http://www.w3.org/2000/svg";

export const NODE_WIDTH = 190;
const HEADER_HEIGHT = 28;
const PORT_ROW_HEIGHT = 18;
const PORT_TOP_OFFSET = 14;
/** How far left of a port's dot its eye sits. */
const EYE_PORT_GAP = 16;
const NODE_BOTTOM_PADDING = 10;
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 2.5;
export const ARRANGE_COLUMN_GAP = 240;
export const ARRANGE_ROW_GAP = 110;
/**
 * How near a port a dropped link has to land, in screen pixels.
 *
 * A port dot is 10px across, which is a small target to hit while dragging.
 * Divided by the zoom on use, so the pull feels the same however far out you
 * are zoomed.
 */
const SNAP_RADIUS_PX = 44;

/** Everything the canvas remembers between events, shared by drawing and interaction. */
export const state = {
  svg: null,
  root: null,
  callbacks: {},
  view: { x: 40, y: 40, k: 1 },
  selectedId: null,
  issuesByNode: new Map(),
  drag: null,
  // "nodeId:portId" -> row count, shown beside each output port.
  portCounts: new Map(),
  // nodeId -> its palette colour, for every node currently inspected. Empty means
  // the bottom panels are following the selection instead.
  inspectedColours: new Map(),
};

export function el(tag, attrs = {}, children = []) {
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

export function portPosition(node, portId, side) {
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
  const rect = state.svg.getBoundingClientRect();
  return {
    x: (clientX - rect.left - state.view.x) / state.view.k,
    y: (clientY - rect.top - state.view.y) / state.view.k,
  };
}

export function toWorld(event) {
  return screenToWorld(event.clientX, event.clientY);
}

/**
 * The nearest port of the given side to a point, within the snap radius.
 *
 * Computed from the model rather than by hit-testing the DOM, so the pull
 * starts well before the pointer is over the dot itself.
 */
export function nearestPort(world, side) {
  const limit = SNAP_RADIUS_PX / state.view.k;
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
export function highlightSnap(target) {
  const key = target ? `${target.nodeId}:${target.portId}` : null;
  if (state.drag && state.drag.snapKey === key) return;
  state.root.querySelectorAll(".port.snap").forEach((element) => element.classList.remove("snap"));
  if (target) {
    const selector = `[data-node="${target.nodeId}"][data-port="${target.portId}"]`;
    state.root.querySelector(selector)?.classList.add("snap");
  }
  if (state.drag) state.drag.snapKey = key;
}

export function edgePath(from, to) {
  // Horizontal control points: the curve leaves an output port going right and
  // enters an input port coming from the left, so a backwards edge still reads
  // as a connection instead of a straight line through the node.
  const dx = Math.max(40, Math.abs(to.x - from.x) * 0.5);
  return `M ${from.x} ${from.y} C ${from.x + dx} ${from.y}, ${to.x - dx} ${to.y}, ${to.x} ${to.y}`;
}

function renderEdges() {
  const group = el("g", { class: "edges" });
  for (const edge of graph.edges) {
    // The edge being rewired is represented by the state.drag preview instead.
    if (state.drag?.rewiring === edge.id) continue;
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
      state.callbacks.onChange?.();
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
    const count = state.portCounts.get(`${node.id}:${port.id}`);
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
  const hasIssue = state.issuesByNode.has(node.id);
  const classes = ["node"];
  if (node.id === state.selectedId) classes.push("selected");
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
  const colour = state.inspectedColours.get(key);
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
  if (!state.svg) return;
  state.root.replaceChildren();
  state.root.setAttribute("transform", `translate(${state.view.x} ${state.view.y}) scale(${state.view.k})`);
  state.root.appendChild(renderEdges());
  const nodes = el("g", { class: "nodes" });
  for (const node of graph.nodes) nodes.appendChild(renderNode(node));
  state.root.appendChild(nodes);
  if (state.drag?.kind === "edge" && state.drag.preview) state.root.appendChild(state.drag.preview);
}
