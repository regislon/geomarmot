# Taking formats and transformers from Ographis — analysis and plan

Status: **revision 2** (2026-11-10), after review. The owner asked to implement the plan; work
starts with the raster spike R1, whose outcome (go, no-go or inconclusive) decides the rest.
SQL Server is out of scope. It extends
[rust-migration-plan.md](rust-migration-plan.md), whose first release is "today's features only";
rasters and new formats were listed there as *after the first release*. Taking them now is a scope
change the owner has to make (decision 1 below).

## Spike R1: where it stands (2026-11-10)

**Desktop: go. Browser: go.** Measured on the reference Mac, release builds; browser in Chromium
(Playwright, `rust/web/raster.spec.js`). The raster code is in `crates/raster`, built for both
targets; the browser build carries no database code.

| Check | Result |
|---|---|
| Raster contract | A Reader of a `.tif`/`.tiff` opens it lazily (`LazyRaster::open_tiff`, headers only) under the source's id; its footprint row is the source table (`raster`, `width`, `height`, `bands`, `data_type`, `nodata`, `crs`, `transform DOUBLE[6]`, `pixel_x`, `pixel_y`, `geometry`), with the CRS on the Reader. Kernels find the raster through `SELECT raster FROM <input>` (`crates/engine/src/rasters.rs`). |
| Restart recovery | Rasters are opened again under the same id after a restart; sampling and polygonizing give the same results (`engine/tests/rasters.rs`). |
| PointOnRasterValueExtractor | Point-local: points grouped by block, one block read at a time; NULL outside or on nodata; lines and areas sampled at their point on surface. |
| RasterToPolygonCoercer | Global: refused above 64 Mi cells from the header alone (1 ms on an 8,200 × 8,200 COG); nodata left out; areas checked. |
| Bounded processing | Sampling 20,000 points on the 67 M-cell COG: 122 ms, peak resident set 182 MB including DuckDB, against 269 MB for the decoded band. |
| COG over HTTP | A 48 MB COG served with range requests: opening it and sampling two points fetched 213 KB. An unapproved URL is refused before any request. |
| File boundary | Opened as a TIFF only, so VRT and STAC pointer files cannot redirect reads. terrio also reads `x.tif.ovr`, `x.tif.aux.xml` and `x.tif.msk` beside a local file; approving a raster approves exactly those three names (`io::Approvals::authorize`). |
| Cancellation | Sampling checks the cancel flag between blocks (tested); polygonize is one terrio call, stopped by the supervisor's escalation. |
| In the window | Opening a GeoTIFF adds a Reader with the raster's CRS; Reader → RasterToPolygonCoercer shows its areas (`app/tests/raster.rs`). |
| Browser: dropped GeoTIFF | Read from memory in the page's wasm; its footprint goes to DuckDB-Wasm through `gmBridge.addSource`, so a restarted DuckDB worker gets it back (tested: polygonize after `gmBridge.restart()`). |
| Browser: COG by URL | `terrio::sparse`: a read that misses bytes fails, the page fetches the ranges (`gmBridge.fetchRange`) and runs it again. A 61 MB COG: opening it and sampling three points fetched 537 KB; values exact, NULL outside. |
| Browser: assets | `geomarmot_app_bg.wasm` is 4.37 MB Brotli with the raster code inside; a standalone wasm of terrio's GeoTIFF reader, window reads and polygonize is 1.49 MB Brotli, so the initial bundle grows by about that (12.3 → about 13.8 MB of 30). It is not yet loaded on first use as the optional-assets rule wants. |
| Browser: limits | The kernels run on the page's main thread (as the per-feature kernels already do); a long polygonize blocks the UI until the kernel worker exists. |

## What Ographis is, and what can be taken

`/Users/regislon/Documents/Projects/Ographis` (v0.95.3) is a desktop spatial ETL in Rust: egui 0.36
and egui-snarl 0.12 like ours, 160 node types, MIT OR Apache-2.0, so its code may be copied into
GeoMarmot (Apache-2.0) with its copyright notice kept and a line in `NOTICE`.

| Ographis crate | What | Usable? |
|---|---|---|
| `og-engine` (~29k lines of nodes) | every tool, on its own in-memory model: `Feature` (attributes + `geo` geometry) and `Grid` (f32 cells, geotransform, EPSG, bands) | **yes, as algorithms**: pure Rust on `geo`, `spade`, `rstar`, `rayon` |
| `og-gdal` | file reading and writing, coordinate transforms, `make_valid`, contours, SQL, PDF, PostGIS writing, all through GDAL, behind one `Backend` trait | **no**: GDAL is ruled out. Replaced by terrio, DuckDB and our engine |
| `og-gui`, `og-cli` | their window and command line | no: we have our own |

**It is a port, not a paste.** Ographis runs tools over in-memory feature lists. GeoMarmot compiles
a graph to one DuckDB view per port and runs Rust kernels only where DuckDB cannot
(rust-migration-plan.md, "who does what"). So:

- attribute and most geometry tools become **SQL in DuckDB** (vectorised, parallel, spilling); copying
  Ographis's row loops would be slower than what we have;
- geometry algorithms DuckDB lacks (snapping, offsetting, topology checks, networks, TINs) are
  **copied from `og-engine` into `crates/kernels`**, adapted from `Feature` to Arrow batches, as the
  overlay and per-feature kernels already are;
- formats and raster work come from **terrio**, which we already pin (0.8.0, pure Rust, no GDAL),
  not from Ographis, whose versions of these call GDAL.

## The pure-Rust stack, checked

**terrio 0.8.0** (already a dependency of `geomarmot-io`; only some features are switched on today):

| Need | terrio |
|---|---|
| GeoTIFF read/write | `geotiff`, `GeoTiffWriter`, `drivers/gtiff_write.rs` |
| Cloud Optimized GeoTIFF | `cog.rs` (`open_raster_lazy`, `LazyRaster`, `Window`, overviews, HTTP range reads), `cog_validate.rs`, writing with overviews (`ops/overview.rs`) |
| Zarr | `zarr` feature (v2/v3 store, multidimensional reads, writes in `multidim/write.rs`) |
| NetCDF, HDF5, GRIB, JPEG 2000, LERC, PNG, WebP, ASCII grid, HGT, ENVI, … | `netcdf-hdf5`, `grib`, `jp2`, `lerc`, drivers |
| Raster operations | `ops/`: `warp` (reproject, resample), `window` (clip), `mosaic`, `calc` (band maths), `polygonize`, `rasterize`, `contour`, `dem` (slope, aspect, hillshade, colour relief), `viewshed`, `proximity`, `fill_nodata`, `sieve`, `zonal*`, `sample`, `translate`, `overview` |
| Vector formats | Shapefile, KML/KMZ, GPX, GML, CityGML, CityJSON, TopoJSON, Esri JSON/PBF, FeatureServer, WFS, OGC API Features, OSM PBF, MapInfo TAB, DXF/DWG (`cad`, acadrust), GeoParquet, GeoPackage, FlatGeobuf, CSV, XLSX |
| Other | LAS/LAZ point clouds, MBTiles/PMTiles tiles, STAC search, S3 and HTTP stores |

**DuckDB spatial 1.5.4 (native, locked)**, listed from the engine: besides what we use, it has
`ST_ConcaveHull`, `ST_VoronoiDiagram`, `ST_Polygonize`, `ST_BuildArea`, `ST_Node`, `ST_LineMerge`,
`ST_LineSubstring`, `ST_LineLocatePoint`, `ST_LineInterpolatePoint(s)`, `ST_ClosestPoint`,
`ST_ShortestLine`, `ST_MakeValid`, `ST_ReducePrecision`, `ST_Rotate`, `ST_Scale`, `ST_Translate`,
`ST_Affine`, `ST_FlipCoordinates`, `ST_Force2D/3DZ`, `ST_Dump`, `ST_MinimumRotatedRectangle`,
`ST_MaximumInscribedCircle`, `ST_Coverage{Clean,Simplify,Union}`, `ST_GeneratePoints`, `ST_AsMVT`.
It lacks an offset curve, snapping and line splitting: those are kernels.

Not verified yet: terrio's raster and COG paths **in the browser build** (wasm32). terrio has wasm
targets in its manifest, but our web build has never compiled `geomarmot-io`. This is spike R1.

## Decisions for the owner

1. **Scope.** Add rasters and new formats before the first release (this plan), or keep the
   migration plan's order: today's features first, then these?
2. **How a raster lives in the graph.** Taken: see [the raster contract](#the-raster-contract).
   Rasters as tables of cells were rejected: they lose windowed and overview reads of COGs.
3. **Names.** Ographis already names node types in files the way GeoMarmot does
   (`AreaOnAreaOverlayer`, `Bufferer`, `Dissolver`, …), with plain-language labels on top. Proposed:
   keep that pattern; where Ographis's type name differs from the industry-standard name (column
   "proposed id" below), use the standard one and accept Ographis's as an alias when a model is
   imported. The names come from memory and the owner should confirm them. Per AGENTS.md, no file,
   comment or commit may name the commercial product they come from.
4. **The browser.** Full parity is the rule. R1 reports go, no-go or inconclusive for the browser
   separately; a desktop-only raster release needs its own scope decision by the owner, never an
   automatic fallback. Raster code is an *optional* asset, loaded on first use, and is measured
   against the optional-assets budget (15 MB in total), not only the initial 30 MB.

## The raster contract

**A raster port is a relation with one row per raster** (a footprint table), so the compiler keeps
one DuckDB view per port, and the table, the map, caching and saved graphs work unchanged. Its
columns:

| Column | Meaning |
|---|---|
| `raster` | the id of a raster the engine owns (its registry key) |
| `width`, `height`, `bands` | pixels and bands |
| `data_type` | the band type as terrio reports it (`u8`, `i16`, `f32`, …) |
| `nodata` | the nodata value of band 1, NULL if none; masks are honoured where terrio reads them |
| `crs` | `EPSG:<code>` or NULL |
| `transform` | the affine transform, GDAL order, as a list of six doubles |
| `pixel_x`, `pixel_y` | pixel size in CRS units |
| `geometry` | the footprint polygon, in `crs` |

The pixels never enter DuckDB. The registry maps `raster` to what the engine reads: an approved
GeoTIFF/COG opened lazily (terrio `LazyRaster`), or later a COG the engine wrote to staging. A
transformer that takes a raster finds its id through SQL (`SELECT raster FROM <input>`), so the id
flows through views and caches like any value.

**Graph files and restarts.** A Reader of a raster keeps its `path`, as any Reader; a graph never
holds a raster id or pixels. On a restart the supervisor opens every approved raster again under
the same id (opening is lazy: headers only). Rasters written to staging belong to their generation
and are recomputed, like `prepare` tables.

**When work runs.** Raster transformers run as `prepare` steps during Run, as kernels do today;
outputs are tables, cached like other results. Nothing raster-sized is computed when only compiling
for the parameter pickers.

**Operation classes and limits** (checked before reading pixels; the error names the node):

| Class | Examples | Bound |
|---|---|---|
| point-local | sampling at points | reads one block at a time; at most `MAX_SAMPLE_POINTS` (5,000,000) points |
| tile-local | band maths, reclassify | one window at a time (future waves) |
| neighbourhood | slope, hillshade, focal statistics | windows with a halo (future waves) |
| global | polygonize, proximity, fill nodata, viewshed | the whole band in memory: at most `MAX_RASTER_CELLS` (64 Mi cells) and `MAX_POLYGONIZE_FEATURES` (2,000,000) output features |

Kernels check the engine's cancel flag between blocks and between output batches; a single long
terrio call is stopped by the supervisor's escalation (kill and restart), as today.

## Formats

Status per row: **done** (implemented and tested natively), **R1** (in the spike), **proposed**.

| Format | Read | Write | How | Wave |
|---|---|---|---|---|
| **GeoTIFF** | yes | yes | terrio `geotiff`, `GeoTiffWriter` | 1 |
| **Cloud Optimized GeoTIFF** | yes, windowed, overviews, over HTTP range | yes, with overviews, validated | terrio `cog`, `cog_validate`, `ops/overview` | 1 |
| **Zarr** (v2/v3) | yes, a window of one array, as raster or as table | proposed, wave 2 | terrio `zarr` (already enabled) | 1 (read) |
| Shapefile (+ `.shx`, `.dbf`, `.prj` beside it; zipped) | yes | yes | terrio `shapefile` | 2 |
| KML/KMZ, GPX, GML, TopoJSON, Esri JSON | yes | KML, GPX | terrio vector drivers | 2 |
| NetCDF, HDF5, GRIB, JPEG 2000 | yes | NetCDF | terrio | 2 |
| WFS, OGC API Features, ArcGIS FeatureServer, STAC | yes | — | terrio (`wfs`, `oapif`, `featureservice`, `stac`); approvals per URL | 3 |
| OpenStreetMap PBF | yes | — | terrio `osm` | 3 |
| DXF, DWG | yes | DXF | terrio `cad` (acadrust) | 3 |
| LAS/LAZ point clouds | yes, thinned or within a rectangle | — | terrio `pointcloud` | 4 |
| MBTiles, PMTiles | — | yes | terrio `tiles`, DuckDB `ST_AsMVT` | 4 |
| **PostGIS** | done: desktop, macOS-tested, keychain on macOS verified (ADR 0012) | proposed (see below) | `postgres` crate | read 0, write 3 |
| SpatiaLite | yes | — | terrio `sqlite` | 3 |

Not taken: SQL Server (not needed), S-57, layered GeoPDF, ODS (GDAL or no pure-Rust equivalent worth it), CityGML/IFC/OBJ/glTF/3D Tiles
(3D, out of scope for now), QGIS projects, slides and reports.

## Transformers

Key: **SQL** = written as DuckDB SQL (fixtures first, as every transformer); **kernel** = algorithm
copied from `og-engine` into `crates/kernels`; **terrio** = a kernel around a terrio op. "Have"
means GeoMarmot already has the function under the name shown.

### Rasters (wave 1, the core of the request)

| Ographis | Proposed id | How | Ographis source |
|---|---|---|---|
| Reader (GeoTIFF/COG/Zarr) | Reader with a raster output | terrio | `nodes/input.rs` (GDAL) → terrio |
| Writer (GeoTIFF/COG) | Writer: GeoTIFF, COG | terrio | — |
| RasterSampler | PointOnRasterValueExtractor | terrio `sample` | `nodes/raster.rs` |
| ZonalStatistics | ZonalStatisticsCalculator | terrio `zonal` | `nodes/raster089.rs` |
| RasterPolygonizer | RasterToPolygonCoercer | terrio `polygonize` | `nodes/raster089.rs` |
| Rasterizer | NumericRasterizer | terrio `rasterize` | `nodes/raster089.rs` |
| RasterClipper | Clipper (raster input) | terrio `window` + mask | `nodes/raster089.rs` |
| RasterResampler | RasterResampler | terrio `warp` | `nodes/raster090.rs` |
| Reprojector (rasters) | Reprojector / RasterReprojector | terrio `warp` | — |
| RasterMosaicker | RasterMosaicker | terrio `mosaic` | `nodes/tools095.rs` |
| RasterCalculator | RasterExpressionEvaluator | terrio `calc` | `nodes/tools095.rs` |
| RasterReclassifier | RasterCellValueReplacer | terrio `calc` | `nodes/raster089.rs` |
| RasterFiller | RasterFiller (fill nodata) | terrio `fill_nodata` | `nodes/raster090.rs` |
| RasterGeneralizer | RasterGeneralizer (sieve) | terrio `sieve` | `nodes/tools095.rs` |
| RasterCreator | RasterCreator | terrio `create` | `nodes/raster.rs` |
| ContourGenerator | ContourGenerator | terrio `contour` | GDAL backend → terrio |
| TerrainAnalyzer | RasterSlopeCalculator, RasterAspectCalculator | terrio `dem` | `terrain.rs` |
| TerrainShader | RasterHillshader | terrio `dem` hillshade | `nodes/terrain.rs` |
| DistanceRaster | RasterProximityCalculator | terrio `proximity` | `nodes/raster089.rs` |
| Viewshed | Viewshed | terrio `viewshed` | `nodes/raster089.rs` |
| FocalStatistics | RasterConvolver | kernel | `nodes/raster.rs` |
| PointInterpolator | SurfaceModeller (IDW) | kernel | `nodes/raster089.rs` |
| TinGenerator, TinRasterizer | SurfaceModeller (TIN) | kernel (`spade`) | `nodes/scene.rs`, `terrain.rs` |
| CostDistance, Watershed | CostDistance, Watershed | kernel | `nodes/raster.rs`, `nodes/terrain.rs` |
| ProfileMaker, VolumeCalculator | ProfileMaker, VolumeCalculator | kernel | `nodes/tools094.rs` |
| SceneReader, CloudMasker, SpectralIndex, TemporalComposite | (satellite: wave 4, with STAC) | terrio + kernel | `nodes/raster090.rs` |

### Attributes (wave 2; all SQL)

Have: Tester, DuplicateFilter, ValueFilter (=AttributeFilter), Sampler, AttributeCreator,
AttributeManager, FeatureMerger (=FeatureJoiner), Sorter, StatisticsCalculator, AttributeKeeper.

To add: Counter, Rounder → AttributeRounder, RangeMapper → AttributeRangeMapper, ValueMapper →
AttributeValueMapper, SubstringExtractor, StringConcatenator, CaseChanger → StringCaseChanger,
StringReplacer, AttributeSplitter, DateTimeStamper, RandomNumber → RandomNumberGenerator,
Duplicator → Cloner, AttributeValidator, Pivoter, Unpivoter. JSON: JsonFlattener → JSONFlattener,
JsonExploder → JSONFragmenter, JsonExtractor → JSONExtractor, JsonBuilder → JSONTemplater.

### Geometry

Have: AreaOnAreaOverlayer, Dissolver, Bufferer, CenterPointReplacer (=CentroidVector,
RepresentativePointVector), Generalizer (=SimplifyFeatures, SmoothVectors), ConvexHuller
(=MinimumConvexHull), Aggregator, PointCreator (=VertexCreator), BoundingBoxReplacer, CrsSetter
(=CoordinateSystemSetter), Reprojector, AreaCalculator and LengthCalculator (=AddGeometryAttributes),
LineMerger (=MergeLineSegments).

**SQL (wave 2):** Clipper (`ST_Intersection`), SpatialJoiner → SpatialRelator, PointOnAreaOverlayer,
PointCounter (SpatialRelator with a count), NeighborFinder (`ST_Distance` with a spatial join),
Deaggregator (`ST_Dump`), BoundingBoxAccumulator (`ST_Extent_Agg`), ConcaveHuller → HullReplacer
(`ST_ConcaveHull`), VoronoiDiagrammer (`ST_VoronoiDiagram`), PolygonToLine → GeometryCoercer
(`ST_Boundary`), LineToPolygon → AreaBuilder (`ST_Polygonize`/`ST_BuildArea`), PointsToLines →
LineBuilder (`ST_MakeLine` aggregate), LineExploder → Chopper, Intersector (`ST_Node`),
GeometryValidator (`ST_IsValid`, `ST_MakeValid`), ShapeRounder (`ST_ReducePrecision`), GeometryFilter,
DimensionFilter, Force2D → 2DForcer, HeightSetter → 3DForcer, Scaler, Offsetter, Rotator, XySwapper →
CoordinateSwapper, LineReverser → Reverser, CoordinateExtractor, BoundsExtractor, LineEndsExtractor,
GeometryToText → GeometryExtractor, GeometryFromText → GeometryReplacer, GeometryRemover,
GridCreator → 2DGridCreator, FeatureCreator → Creator, PairMaker, PointsAlongLines, LineLocator,
EventPlacer (`ST_LineInterpolatePoints`, `ST_LineLocatePoint`, `ST_LineSubstring`), CoordinateParser.

**Kernels copied from `og-engine` (wave 3):** Snapper, LineSplitter (lines at points or crossings),
LineExtender → Extender, LineOffsetter, HoleRemover → DonutHoleExtractor, TopologyChecker,
SliverEliminator (with `ST_CoverageClean`), CoordinateReprojector. Networks: NetworkBuilder →
NetworkTopologyCalculator, ShortestRoute → ShortestPathFinder, ServiceAreas, NetworkAllocation
(`network.rs`, `nodes/network*.rs`).

### Web and databases (wave 3)

HttpCaller → HTTPCaller, StacSearch, OsmDownloader, OvertureDownloader (GeoParquet over HTTP, which
DuckDB already reads), PostgisWriter, SqlExecutor.

**Before any of these is built**, each gets its own decision record:

- *Database writes.* A saved connection identifies a server; it does not authorise writing.
  PostgisWriter needs modes (create, append, replace), one transaction per write with rollback on
  error or cancel, a confirmation naming the table and mode at Run, and rollback tests. SqlExecutor
  (arbitrary SQL on a server) gets a separate policy. Neither is available to the assistant or to
  generated transformers.
- *Services.* Approving a URL approves that URL. Resources it leads to (paging, redirects, STAC
  asset links, sidecar files, archive members) are authorised by a rule written per service:
  same host, scheme `https`, no credentials forwarded to another host, archive extraction bounded
  in size and file count and never outside staging.
- *Raster expressions* (RasterExpressionEvaluator) use a restricted grammar of band references,
  numbers, arithmetic, comparisons and a fixed list of functions; never SQL.
- *Privacy.* Raster metadata, statistics, previews and errors reach the assistant only through new
  payload schemas in the privacy gate.

### Not taken for now

Maps, charts, slides, reports, PDF, web maps, QGIS projects (output and presentation, not ETL);
3D scenes, dioramas, LoD2 buildings, terrain models, Extruder (3D); point cloud processing beyond
reading (wave 4 at the earliest); ModelRunner (a later "sub-graph" feature).

## Waves

Each wave ends when its fixtures pass on both engines (or on the desktop, if decision 4 says so),
`npm run check` and the Rust suites are green, and `formats.md` and the catalogue are updated.

| Wave | Content | Done when |
|---|---|---|
| R1 spike | the raster contract above; GeoTIFF/COG Reader (local, then HTTP range); `PointOnRasterValueExtractor` and `RasterToPolygonCoercer`; limits and cancellation tested on a generated raster larger than the budget; in the browser, a COG window read over HTTP and both transformers through the worker bridge, with native database code kept out of the browser build | go / no-go / inconclusive, separately for desktop and browser |
| 1. Rasters | GeoTIFF/COG/Zarr read and write, PostGIS write, the raster table above down to ContourGenerator and the DEM tools | fixtures per transformer; COG written is valid (`cog_validate`) and reads back equal |
| 2. Vectors | Shapefile, KML/KMZ, GPX, GML, TopoJSON, NetCDF/HDF5; the SQL attribute, JSON and geometry transformers | as above |
| 3. Kernels and services | copied kernels, networks; WFS/OAPIF/FeatureServer/STAC/OSM/Overture, SpatiaLite, DXF/DWG | kernel parity tests against Ographis's own test cases, ported |
| 4. Later | point clouds, tiles, satellite composites, interpolation and surface modelling extras | owner's call |

**Names are chosen last.** Each transformer gets a behaviour spec first (inputs, outputs,
defaults, refusals, edge cases); its id follows. Two different behaviours never share a name (a
hole *remover* is not a hole *extractor*; smoothing is not simplifying). Opening Ographis models
is a separate conversion task: aliases cannot translate parameters, ports or semantics.

**Provenance.** Code copied from Ographis records the source file and the revision (`3d61df5`,
v0.95.3) in a header comment; fixtures are generated (`tests/fixtures/build.js` or test code), never
copied binaries. SQL functions are checked on both pinned DuckDB builds (native and Wasm) before a
transformer relies on them.

**How a transformer is taken over:** write `tests.json` from the Ographis node's tests
(`crates/og-engine/tests`) and its documented behaviour, then the code: SQL in a new
`transformers/<id>/`, or the kernel with Ographis's code copied, the `Feature` loops replaced by
Arrow batches, and the copyright header kept. The schema, README headings and descriptions follow
`docs/transformer-api.md` and pass `check:docs`.

## Risks

| Risk | What we do |
|---|---|
| terrio is pre-1.0 and large; enabling `geotiff`, `zarr`, `remote`, `netcdf-hdf5` adds build time and size | enable features per wave; measure the desktop binary and web assets at R1 |
| Ographis code assumes in-memory features and f32 grids | port the algorithm, not the data model; f32 grids become terrio rasters of the source type |
| Raster handles break "one DuckDB view per port" | decision 2; generation ownership and retirement tests as for `prepare` tables |
| Network services and SqlExecutor widen what a graph can reach | approvals per URL/host, the saved-connection model of ADR 0012, confirmation for SqlExecutor |
| Names from memory may be wrong | owner confirms the id column before wave 2 |
