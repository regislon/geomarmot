# Using GeoMarmot

GeoMarmot is a canvas of transformers: data comes in through **Readers**, flows from node to node,
and leaves through **Writers**. Nothing is computed until you look at it — select a node and its
rows appear in the table and its geometry on the map. The **ⓘ** at the start of a row opens that feature: all its
attributes, and its geometry described (type, vertices, extents, area, validity, WKT).

Anything that takes more than a moment — the engine starting, a file opening or downloading, the
graph running its slower steps (hexagons, overlays, Zarr chunks), Run writing files — shows a
progress card in the middle of the canvas, with a percentage when it is known. You can keep working
while it shows.

## The toolbar

| Tool | What it does |
|---|---|
| **New** | Starts an empty workspace. It asks first; the previous graph stays in Undo. |
| **Open ▾** | *From this computer…* opens a graph file (`.flow.json`). *From this browser…* (⌘O / Ctrl+O) lists the workspaces saved in this browser. |
| **Save ▾** | *To this computer* downloads the graph as `graph.flow.json`. *To this browser* (⌘S / Ctrl+S) saves it as a named workspace in this browser; *To this browser as…* (⇧⌘S / Ctrl+Shift+S) saves it under a new name. |
| **Run** | Writes every connected **Writer** to its file. It is greyed out until a Writer has something connected. A **Cancel** button appears while it runs. |
| **Undo**, **Redo** | Step back and forward through your edits (⌘Z / Ctrl+Z, ⇧⌘Z / Ctrl+Shift+Z). |
| **Arrange** | Lays the nodes out in columns, each one right of what feeds it. |
| **Assistant** | Opens the assistant beside the canvas ([below](#the-assistant)). |

## Getting data in

Drop files on the **Layers** panel, or paste a URL. Each file becomes a source; **+ Reader** adds a
Reader node for it. Files you drop are read in your browser and never uploaded; remote files are
read in parts, as queries need them. Which formats are supported, and how, is in
[Formats](formats.md).

## Building a graph

Add transformers from the **Transformers** list, or, with the pointer over the canvas, start typing
part of a name (Quick Add): the transformer lands where the pointer is. Drag from an output port to an input port to connect them. Select a node to edit
its settings in the inspector on the right; the **?** button explains what it does. Wherever a
setting asks for an attribute, type part of its name to find it; a list of attributes has a filter
box above it, and *Select all* then picks the ones it shows. A node in error
says why, and the nodes after it wait.

## Saving and opening

There are two places to keep your work:

- **On your computer**, as a file: *Save ▸ To this computer* downloads `graph.flow.json`, and *Open ▸
  From this computer…* opens one. Use a file to share a graph, keep it with a project, or move it to
  another computer. A graph opened from a file always comes back with its SQL restricted
  ([security](security.md#sql)).
- **In this browser**, as named workspaces: *Save ▸ To this browser* (⌘S) asks for a name the first
  time, then saves under it. *Open ▸ From this browser…* (⌘O) lists them, newest first, to open or
  delete. They stay in this browser profile on this computer, and go if you clear the site's data.

Either way, what is saved is the **graph** — its nodes, their settings and any transformers the
assistant generated — not your data. After opening, load the files its Readers need again. The
current graph is also saved automatically in the browser as you work, and comes back when you
reload the page.

## Writing results

Add a **Writer**, connect it, choose a format and a file name, then press **Run**. Every connected
Writer writes its file; the browser saves it to your downloads. A Writer's own **Write this file**
writes just that one.

## The assistant

**Assistant** opens a chat beside the canvas. Describe what you want — "make points from the E and
N columns" — and it proposes the nodes as a **draft**: it can preview the draft on a sample, and
nothing changes in your graph until you press **Apply** (one Undo step) or **Discard**. Its settings
(the gear) choose the provider, the model, your API key and, most importantly, **what it may see of
your data** — by default only column names and types. See [security and privacy](security.md#the-assistant).
