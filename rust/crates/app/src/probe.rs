//! `GEOMARMOT_PROBE=1`: measure start-up and frame times while the engine works, then quit.
//!
//! Prints the time from `main` to the first frame, then keeps repainting for `SECONDS` while a
//! heavy query runs in the engine, and prints p50/p95/p99 and the longest frame (spike budgets:
//! start ≤ 2 s, p95 ≤ 33 ms, p99 ≤ 50 ms, longest stall ≤ 100 ms).

use std::time::{Duration, Instant};

use crate::worker::{Job, Worker};

const SECONDS: u64 = 10;
/// Long enough to keep the engine busy for the whole probe.
const WORKLOAD: &str = "SELECT sum(hash(i)) FROM range(400000000000) t(i)";

pub struct Probe {
    started: Instant,
    first_frame: Option<Duration>,
    last: Option<Instant>,
    frames: Vec<Duration>,
    until: Option<Instant>,
}

impl Probe {
    pub fn from_env(started: Instant) -> Option<Self> {
        (std::env::var("GEOMARMOT_PROBE").as_deref() == Ok("1")).then(|| Self {
            started,
            first_frame: None,
            last: None,
            frames: Vec::new(),
            until: None,
        })
    }

    pub fn frame(&mut self, ctx: &egui::Context, worker: &Worker) {
        let now = Instant::now();
        if self.first_frame.is_none() {
            self.first_frame = Some(now - self.started);
            println!("probe: first frame {} ms after main", (now - self.started).as_millis());
            worker.send(Job::Exec(WORKLOAD.into()));
            self.until = Some(now + Duration::from_secs(SECONDS));
        } else if let Some(last) = self.last {
            self.frames.push(now - last);
        }
        self.last = Some(now);
        ctx.request_repaint();
        if self.until.is_some_and(|u| now >= u) {
            let mut f = self.frames.clone();
            f.sort();
            let pct = |p: f64| f[((f.len() as f64 * p) as usize).min(f.len() - 1)].as_secs_f64() * 1000.0;
            println!(
                "probe: {} frames in {SECONDS} s with the engine busy: p50 {:.1} ms, p95 {:.1} ms, p99 {:.1} ms, longest {:.1} ms",
                f.len(),
                pct(0.5),
                pct(0.95),
                pct(0.99),
                f.last().map_or(0.0, |d| d.as_secs_f64() * 1000.0)
            );
            println!("probe: cancel → {}", worker.cancel());
            std::process::exit(0);
        }
    }
}
