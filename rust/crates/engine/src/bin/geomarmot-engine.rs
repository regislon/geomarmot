//! The engine process. Usage: `geomarmot-engine --extensions <dir>`; speaks the
//! protocol in `geomarmot_engine::process` on stdin/stdout.

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let Some(dir) = args
        .iter()
        .position(|a| a == "--extensions")
        .and_then(|k| args.get(k + 1))
    else {
        eprintln!("usage: geomarmot-engine --extensions <dir>");
        std::process::exit(2);
    };
    let host = match geomarmot_engine::Host::open(std::path::Path::new(dir)) {
        Ok(h) => h,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    };
    if let Err(e) = geomarmot_engine::process::serve(host) {
        eprintln!("engine process: {e}");
        std::process::exit(1);
    }
}
