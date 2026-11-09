//! The engine process. Usage:
//! `geomarmot-engine --extensions <dir> [--staging <dir>] [--memory <limit>] [--allow <path>]...`;
//! speaks the protocol in `geomarmot_engine::process` on stdin/stdout. The allow list is
//! fixed for the life of the process: approving a new source means a new process.

use geomarmot_engine::{Config, Host, process};

fn main() {
    let mut config = Config::default();
    let mut args = std::env::args().skip(1);
    while let Some(flag) = args.next() {
        let value = args.next().unwrap_or_default();
        match flag.as_str() {
            "--extensions" => config.extension_dir = value.into(),
            "--staging" => config.staging_dir = Some(value.into()),
            "--memory" => config.memory_limit = Some(value),
            "--allow" => config.allowed_paths.push(value),
            other => {
                eprintln!("unknown argument {other}");
                std::process::exit(2);
            }
        }
    }
    let host = Host::open(&config).unwrap_or_else(|e| {
        eprintln!("{e}");
        std::process::exit(1);
    });
    if let Err(e) = process::serve(host) {
        eprintln!("engine process: {e}");
        std::process::exit(1);
    }
}
