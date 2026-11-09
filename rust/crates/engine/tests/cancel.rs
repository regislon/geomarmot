//! Spike gate 4, desktop side: cancellation limits, escalation, restart recovery,
//! staged exports under a kill, and preview isolation. Timings are printed for the report.

mod support;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use geomarmot_engine::supervisor::{Reader, STOP_GRACE, SourceRecord, SourceState, Supervisor};
use geomarmot_engine::{Config, io};
use support::runner::extension_dir;

fn root(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("gm-cancel-{name}-{}", std::process::id()));
    io::clean_staging(&dir).unwrap();
    dir
}

fn supervisor(dir: &Path) -> Arc<Supervisor> {
    let config = Config {
        extension_dir: extension_dir(),
        staging_dir: Some(dir.join("staging")),
        memory_limit: Some("2GB".into()),
        ..Config::default()
    };
    Arc::new(Supervisor::start(Path::new(env!("CARGO_BIN_EXE_geomarmot-engine")), config, true).unwrap())
}

/// Start `work` on a thread, cancel after `after` (the engine is warmed up first, so `after` measures
/// time inside the work, not process start-up); returns (escalated, stop latency, work error).
fn cancel_during(
    s: &Arc<Supervisor>,
    after: Duration,
    work: impl FnOnce(&Supervisor) -> Result<(), String> + Send + 'static,
) -> (bool, Duration, Option<String>) {
    s.query("SELECT 1").value.unwrap();
    let worker = s.clone();
    let handle = thread::spawn(move || work(&worker));
    thread::sleep(after);
    let t0 = Instant::now();
    let escalated = s.cancel(STOP_GRACE).unwrap();
    let result = handle.join().unwrap();
    (escalated, t0.elapsed(), result.err())
}

#[test]
fn long_scan_stops_cooperatively() {
    let s = supervisor(&root("scan"));
    let (escalated, took, err) = cancel_during(&s, Duration::from_millis(300), |s| {
        s.query("SELECT sum(hash(i)) FROM range(100000000000) t(i)")
            .value
            .map(|_| ())
    });
    eprintln!("long scan: escalated={escalated}, stopped in {took:?}, error={err:?}");
    assert!(!escalated && took < STOP_GRACE && err.is_some());
    assert!(s.query("SELECT 1").value.is_ok(), "engine usable after cancel");
}

#[test]
fn nested_loop_join_stops_one_way_or_the_other() {
    let s = supervisor(&root("join"));
    let (escalated, took, err) = cancel_during(&s, Duration::from_millis(300), |s| {
        s.query("SELECT count(*) FROM range(3000000) a(x), range(3000000) b(y) WHERE (a.x * b.y) % 7 = 3")
            .value
            .map(|_| ())
    });
    eprintln!("nested-loop join: escalated={escalated}, stopped in {took:?}, error={err:?}");
    assert!(err.is_some());
    assert!(took < STOP_GRACE + Duration::from_secs(5));
    assert!(s.query("SELECT 1").value.is_ok());
}

#[test]
fn stuck_kernel_escalates_and_engine_recovers() {
    let dir = root("stuck");
    let csv = dir.join("source.csv");
    std::fs::write(&csv, "id,v\n1,a\n2,b\n").unwrap();
    let s = supervisor(&dir);
    s.approve_source(SourceRecord {
        name: "src".into(),
        location: csv.to_string_lossy().into(),
        reader: Reader::Csv,
        fingerprint: None,
    })
    .unwrap();
    let before = s.epoch();
    let (escalated, took, err) = cancel_during(&s, Duration::from_millis(200), |s| s.stuck(60).value);
    let usable = Instant::now();
    let rows = s.query("SELECT count(*) FROM src");
    eprintln!(
        "stuck kernel: escalated={escalated}, restarted in {took:?}, usable again {:?} later, error={err:?}",
        usable.elapsed()
    );
    assert!(escalated && err.is_some());
    assert!(took < STOP_GRACE + Duration::from_secs(3), "usable again within 5 s");
    assert_eq!(rows.epoch, before + 1, "results carry the new epoch");
    assert!(
        rows.value.is_ok(),
        "the source was registered again: {:?}",
        rows.value.err()
    );
}

#[test]
fn recovery_reports_changed_and_missing_sources() {
    let dir = root("recover");
    let csv = dir.join("source.csv");
    std::fs::write(&csv, "id\n1\n").unwrap();
    let s = supervisor(&dir);
    let t0 = Instant::now();
    let states = s
        .approve_source(SourceRecord {
            name: "src".into(),
            location: csv.to_string_lossy().into(),
            reader: Reader::Csv,
            fingerprint: None,
        })
        .unwrap();
    eprintln!("approve a source (restart + register): {:?}", t0.elapsed());
    assert_eq!(states, vec![("src".into(), SourceState::Ready)]);
    thread::sleep(Duration::from_millis(20));
    std::fs::write(&csv, "id\n1\n2\n").unwrap();
    assert_eq!(
        s.restart().unwrap(),
        vec![("src".into(), SourceState::ChangedSinceLoaded)]
    );
    std::fs::remove_file(&csv).unwrap();
    assert!(matches!(s.restart().unwrap()[0].1, SourceState::Missing(_)));
}

#[test]
fn killed_export_leaves_no_file() {
    let dir = root("export");
    let s = supervisor(&dir);
    let staged = dir.join("staging/big.csv");
    let target = staged.clone();
    let (escalated, _, _) = cancel_during(&s, Duration::from_millis(200), move |s| {
        s.exec(&format!(
            "COPY (SELECT i, hash(i) FROM range(2000000000) t(i)) TO '{}'",
            target.display()
        ))
        .value
    });
    eprintln!("export cancelled: escalated={escalated}");
    let destination = dir.join("final.csv");
    assert!(!destination.exists() && !dir.join("final.csv.partial").exists());
    if escalated {
        assert!(!staged.exists(), "staging is cleaned on restart");
    }
}

#[test]
fn killing_a_preview_engine_leaves_the_main_one_alone() {
    let main = supervisor(&root("main"));
    let preview = supervisor(&root("preview"));
    let (escalated, _, _) = cancel_during(&preview, Duration::from_millis(100), |s| s.stuck(30).value);
    assert!(escalated);
    assert_eq!(main.epoch(), 1);
    assert!(main.query("SELECT 42").value.is_ok());
}
