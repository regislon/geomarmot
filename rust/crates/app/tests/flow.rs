//! Spike gate 5, desktop: one usable flow driven through the real window, headless —
//! open a file, chain Bufferer → Dissolver, read the table, export, and render a screenshot
//! to `rust/target/gate5-flow.png`. Needs the engine binary built first:
//! `cargo build --release -p geomarmot-engine`.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use egui_kittest::Harness;
use egui_kittest::kittest::Queryable;
use egui_snarl::{InPinId, NodeId, OutPinId};
use geomarmot_app::app::App;
use geomarmot_app::canvas::NodeData;
use geomarmot_app::worker::Worker;
use geomarmot_engine::Config;
use geomarmot_engine::supervisor::Supervisor;
use serde_json::json;

fn target() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target")
}

fn wait(h: &mut Harness<'_, App>, what: &str, done: impl Fn(&App) -> bool) {
    let t0 = Instant::now();
    while !done(h.state()) {
        assert!(
            t0.elapsed() < Duration::from_secs(60),
            "timed out waiting for {what}; status: {}",
            h.state().status()
        );
        h.step();
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn open_chain_read_export() {
    let extensions = target().join("duckdb-extensions");
    if !extensions.exists() {
        geomarmot_engine::install_extensions(&extensions).unwrap();
    }
    let staging = std::env::temp_dir().join(format!("gm-flow-{}", std::process::id()));
    let config = Config {
        extension_dir: extensions,
        staging_dir: Some(staging.clone()),
        ..Config::default()
    };
    let supervisor = Supervisor::start(&target().join("release/geomarmot-engine"), config, false).unwrap();
    let mut h = Harness::builder()
        .with_size(egui::vec2(1280.0, 800.0))
        .with_step_dt(1.0 / 60.0)
        .wgpu()
        .build_eframe(|_cc| App::new(Worker::start(supervisor, staging, || {})));

    let file = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/areas.geojson");
    h.state_mut().open(file);
    wait(&mut h, "the Reader", |a| {
        a.snarl.node_ids().count() == 1 && a.status() == "Ready."
    });

    let app = h.state_mut();
    let reader = NodeId(0);
    let buffer = app.snarl.insert_node(
        egui::pos2(640.0, 80.0),
        NodeData::new("Bufferer", json!({"distance": "200"}), String::new()),
    );
    let dissolve = app.snarl.insert_node(
        egui::pos2(1200.0, 80.0),
        NodeData::new("Dissolver", json!({"groupBy": []}), String::new()),
    );
    app.snarl.connect(
        OutPinId {
            node: reader,
            output: 0,
        },
        InPinId { node: buffer, input: 0 },
    );
    app.snarl.connect(
        OutPinId {
            node: buffer,
            output: 0,
        },
        InPinId {
            node: dissolve,
            input: 0,
        },
    );
    app.viewer.selected = Some((buffer.0, 0));
    app.run(None);
    wait(&mut h, "the table", |a| a.shown_rows().is_some_and(|n| n > 0));

    // Editing a node clears its result and everything downstream.
    let before = h.state().viewer.to_global;
    h.state_mut().viewer.stale.push(buffer.0);
    h.run_steps(2);
    assert_eq!(
        h.state().shown_rows(),
        None,
        "an edited node shows no data until it runs"
    );
    h.state_mut().run(Some(vec![dissolve.0]));
    wait(&mut h, "the run to Dissolver", |a| a.status() == "Ready.");

    // A double-click with the wheel fits the canvas to the nodes.
    let at = egui::pos2(680.0, 300.0);
    h.event(egui::Event::PointerMoved(at));
    for pressed in [true, false, true, false] {
        h.event(egui::Event::PointerButton {
            pos: at,
            button: egui::PointerButton::Middle,
            pressed,
            modifiers: egui::Modifiers::NONE,
        });
        h.step();
    }
    h.run_steps(2);
    assert_ne!(h.state().viewer.to_global, before, "the view moved to fit the nodes");

    h.state_mut().viewer.selected = Some((buffer.0, 0));
    wait(&mut h, "the table again", |a| a.shown_rows().is_some_and(|n| n > 0));

    let out = std::env::temp_dir().join(format!("gm-flow-{}.parquet", std::process::id()));
    h.state_mut().export(out.clone());
    wait(&mut h, "the export", |a| a.status().starts_with("Export"));
    assert!(h.state().status().starts_with("Exported"), "{}", h.state().status());
    assert!(out.exists());

    // Double-clicking a node opens its parameters in a pop-up.
    // A double-click on the node's body (not its title) opens its parameters.
    let rect = h
        .state()
        .viewer
        .node_rects
        .iter()
        .find(|(n, _)| *n == dissolve.0)
        .unwrap()
        .1;
    let body = h.state().viewer.to_global * egui::pos2(rect.center().x, rect.bottom() - 8.0);
    h.event(egui::Event::PointerMoved(body));
    for pressed in [true, false, true, false] {
        h.event(egui::Event::PointerButton {
            pos: body,
            button: egui::PointerButton::Primary,
            pressed,
            modifiers: egui::Modifiers::NONE,
        });
        h.step();
    }
    assert_eq!(
        h.state().editing(),
        Some(dissolve.0),
        "double-click on the body opens the pop-up"
    );
    for _ in 0..30 {
        h.step();
        std::thread::sleep(Duration::from_millis(20));
    }
    h.render()
        .expect("render")
        .save(target().join("gate5-form.png"))
        .unwrap();
    h.event(egui::Event::Key {
        key: egui::Key::Escape,
        physical_key: None,
        pressed: true,
        repeat: false,
        modifiers: egui::Modifiers::NONE,
    });
    h.step();
    h.step();
    assert_eq!(h.state().editing(), None, "Esc closes the pop-up");
    // Two outputs open as tabs (Alt-click on their eyes), Bufferer the active one.
    h.state_mut().viewer.tabs = vec![(dissolve.0, 0), (buffer.0, 0)];
    h.state_mut().viewer.selected = Some((buffer.0, 0));
    for _ in 0..30 {
        h.step();
        std::thread::sleep(Duration::from_millis(20));
    }
    wait(&mut h, "the Bufferer table", |a| a.shown_rows().is_some_and(|n| n > 1));
    let image = h.render().expect("render");
    image.save(target().join("gate5-flow.png")).unwrap();
    h.state_mut().tab_map = true;
    h.run_steps(3);
    h.render()
        .expect("render")
        .save(target().join("gate5-map.png"))
        .unwrap();
    assert_eq!(h.state().viewer.tabs.len(), 2, "tabs survive while their nodes do");
    // Removing the active tab's node falls back to the other tab.
    h.state_mut().snarl.remove_node(buffer);
    h.run_steps(2);
    assert_eq!(h.state().viewer.tabs, vec![(dissolve.0, 0)]);
    assert_eq!(h.state().viewer.selected, Some((dissolve.0, 0)));

    // Typing a transformer's name with an output selected adds it, already linked to that output.
    let wires = h.state().snarl.wires().count();
    h.event(egui::Event::PointerMoved(egui::pos2(900.0, 440.0)));
    h.event(egui::Event::Text("Sorter".into()));
    h.run_steps(2);
    h.event(egui::Event::Key {
        key: egui::Key::Enter,
        physical_key: None,
        pressed: true,
        repeat: false,
        modifiers: egui::Modifiers::NONE,
    });
    h.run_steps(2);
    let app = h.state();
    let sorter = app
        .snarl
        .node_ids()
        .find(|(_, d)| d.node.kind == "Sorter")
        .expect("a Sorter")
        .0;
    assert_eq!(app.snarl.wires().count(), wires + 1);
    assert!(app.snarl.wires().any(|(o, i)| o.node == dissolve && i.node == sorter));

    // AttributeManager lists its input's attributes before anything runs: compiled, not run.
    let app = h.state_mut();
    let manager = app.snarl.insert_node(
        egui::pos2(0.0, 600.0),
        NodeData::new("AttributeManager", json!({"actions": []}), String::new()),
    );
    app.snarl.connect(
        OutPinId {
            node: reader,
            output: 0,
        },
        InPinId {
            node: manager,
            input: 0,
        },
    );
    app.viewer.selected = Some((manager.0, 0));
    for _ in 0..200 {
        h.step();
        if h.query_by_label("attr_29").is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(h.query_by_label("Input attribute").is_some(), "the attribute table");
    assert!(h.query_by_label("attr_29").is_some(), "the input's attributes, before any run");
}
