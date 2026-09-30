/*
 * Pointer and keyboard interaction on the canvas: panning, zooming, dragging
 * nodes, and drawing or re-aiming links.
 */

import { addEdge, graph, incomingEdge, nodeById, removeEdge, removeNode } from "../../core/graph/index.js";
import {
  MAX_ZOOM,
  MIN_ZOOM,
  edgePath,
  el,
  highlightSnap,
  nearestPort,
  portPosition,
  render,
  state,
  toWorld,
} from "./draw.js";
import { select } from "./index.js";

function startEdgeDrag(event, nodeId, portId) {
  const node = nodeById(nodeId);
  const origin = portPosition(node, portId, "out");
  const preview = el("path", { class: "edge edge-preview", d: edgePath(origin, origin) });
  state.drag = { kind: "edge", from: nodeId, fromPort: portId, origin, preview };
  state.root.appendChild(preview);
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
  state.drag = nearTarget
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
  state.drag = { kind: "node", nodeId, offsetX: world.x - node.x, offsetY: world.y - node.y, moved: false };
  select(nodeId);
}

export function onPointerDown(event) {
  // Touching the canvas gives it the keyboard, which is what makes the Delete
  // gate above meaningful.
  state.svg.focus({ preventScroll: true });
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
    state.callbacks.onInspect?.(eyeEl.getAttribute("data-eye"), { add });
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

  state.drag = { kind: "pan", startX: event.clientX - state.view.x, startY: event.clientY - state.view.y };
  select(null);
}

export function onPointerMove(event) {
  if (!state.drag) return;
  if (state.drag.kind === "pan") {
    state.view.x = event.clientX - state.drag.startX;
    state.view.y = event.clientY - state.drag.startY;
    state.root.setAttribute("transform", `translate(${state.view.x} ${state.view.y}) scale(${state.view.k})`);
    return;
  }
  if (state.drag.kind === "node") {
    const world = toWorld(event);
    const node = nodeById(state.drag.nodeId);
    if (!node) return;
    node.x = Math.round(world.x - state.drag.offsetX);
    node.y = Math.round(world.y - state.drag.offsetY);
    state.drag.moved = true;
    render();
    return;
  }
  if (state.drag.kind === "edge") {
    const cursor = toWorld(event);
    const target = nearestPort(cursor, state.drag.reverse ? "out" : "in");
    highlightSnap(target);
    // Draw to the port it would snap to, not to the pointer — the line itself
    // tells you where letting go will put it.
    const end = target ? target.position : cursor;
    state.drag.preview.setAttribute(
      "d",
      state.drag.reverse ? edgePath(end, state.drag.origin) : edgePath(state.drag.origin, end),
    );
  }
}

export function onPointerUp(event) {
  if (!state.drag) return;
  if (state.drag.kind === "edge") {
    // Snap by proximity rather than by what is under the pointer: the same
    // rule that drew the preview decides the drop, so what you saw is what
    // you get. A reversed state.drag is looking for an output to feed its input.
    const target = nearestPort(toWorld(event), state.drag.reverse ? "out" : "in");
    if (target) {
      // Only now is the original link given up, so a missed drop costs nothing.
      if (state.drag.rewiring) removeEdge(state.drag.rewiring);
      if (state.drag.reverse) addEdge(target.nodeId, target.portId, state.drag.to, state.drag.toPort);
      else addEdge(state.drag.from, state.drag.fromPort, target.nodeId, target.portId);
      state.drag = null;
      highlightSnap(null);
      state.callbacks.onChange?.();
      return;
    }
  }
  highlightSnap(null);
  const wasNodeMove = state.drag.kind === "node" && state.drag.moved;
  state.drag = null;
  render();
  if (wasNodeMove) state.callbacks.onLayoutChange?.();
}

export function onWheel(event) {
  event.preventDefault();
  const rect = state.svg.getBoundingClientRect();
  const pointerX = event.clientX - rect.left;
  const pointerY = event.clientY - rect.top;
  const factor = Math.exp(-event.deltaY * 0.0015);
  const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, state.view.k * factor));
  // Keep the point under the cursor fixed while zooming.
  state.view.x = pointerX - ((pointerX - state.view.x) * next) / state.view.k;
  state.view.y = pointerY - ((pointerY - state.view.y) * next) / state.view.k;
  state.view.k = next;
  render();
}

export function onKeyDown(event) {
  if (event.key !== "Delete" && event.key !== "Backspace") return;
  // Positive check, not "is the focus in a text field": when the inspector
  // rebuilds under you the field you were typing in is destroyed and focus
  // falls back to the body, where a tagName test sees nothing to veto and a
  // Backspace meant for a character deletes the node instead. Deleting a node
  // is a canvas action, so require the canvas to actually hold focus.
  if (!state.svg.contains(document.activeElement)) return;
  if (!state.selectedId) return;
  event.preventDefault();
  removeNode(state.selectedId);
  select(null);
  state.callbacks.onChange?.();
}
