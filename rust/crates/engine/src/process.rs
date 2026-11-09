//! The engine process: the host served over stdin/stdout.
//!
//! Frames are `[u32 length, little-endian][u8 kind][payload]`.
//! Requests: kind 1 exec, 2 query (payload: SQL), 3 interrupt (empty).
//! Replies: kind 0 done, 1 Arrow IPC stream, 2 error (payload: message).
//! Requests are answered in order; interrupt is handled on the reader thread, so it
//! reaches a statement that is still running (and gets no reply of its own).

use std::io::{BufReader, BufWriter, Read, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Mutex;
use std::sync::mpsc;

use crate::{Config, Host, Result, SqlEngine};
use geomarmot_sql::arrow::array::RecordBatch;
use geomarmot_sql::{from_ipc, to_ipc};

const EXEC: u8 = 1;
const QUERY: u8 = 2;
const INTERRUPT: u8 = 3;
const DONE: u8 = 0;
const BATCHES: u8 = 1;
const ERROR: u8 = 2;

fn write_frame(w: &mut impl Write, kind: u8, payload: &[u8]) -> std::io::Result<()> {
    w.write_all(&(payload.len() as u32).to_le_bytes())?;
    w.write_all(&[kind])?;
    w.write_all(payload)?;
    w.flush()
}

fn read_frame(r: &mut impl Read) -> std::io::Result<(u8, Vec<u8>)> {
    let mut head = [0u8; 5];
    r.read_exact(&mut head)?;
    let len = u32::from_le_bytes(head[..4].try_into().unwrap()) as usize;
    let mut payload = vec![0; len];
    r.read_exact(&mut payload)?;
    Ok((head[4], payload))
}

/// Serve `host` until stdin closes. Called by the `geomarmot-engine` binary.
pub fn serve(host: Host) -> std::io::Result<()> {
    let interrupt = host.interrupt_handle();
    let (tx, rx) = mpsc::channel::<(u8, String)>();
    std::thread::spawn(move || {
        let mut input = BufReader::new(std::io::stdin().lock());
        while let Ok((kind, payload)) = read_frame(&mut input) {
            if kind == INTERRUPT {
                interrupt.interrupt();
            } else if tx.send((kind, String::from_utf8_lossy(&payload).into_owned())).is_err() {
                break;
            }
        }
    });
    let mut out = BufWriter::new(std::io::stdout().lock());
    for (kind, sql) in rx {
        let reply = match kind {
            EXEC => host.exec_now(&sql).map(|_| (DONE, vec![])),
            QUERY => host
                .query_now(&sql)
                .and_then(|b| to_ipc(&b))
                .map(|bytes| (BATCHES, bytes)),
            other => Err(format!("unknown request kind {other}")),
        };
        match reply {
            Ok((k, bytes)) => write_frame(&mut out, k, &bytes)?,
            Err(e) => write_frame(&mut out, ERROR, e.as_bytes())?,
        }
    }
    Ok(())
}

/// The app-side client of an engine process.
pub struct ProcessEngine {
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    stdout: Mutex<BufReader<ChildStdout>>,
}

impl ProcessEngine {
    /// Start `binary` with the engine configuration.
    pub fn spawn(binary: &Path, config: &Config) -> Result<Self> {
        let mut cmd = Command::new(binary);
        cmd.arg("--extensions").arg(&config.extension_dir);
        if let Some(dir) = &config.staging_dir {
            cmd.arg("--staging").arg(dir);
        }
        if let Some(limit) = &config.memory_limit {
            cmd.arg("--memory").arg(limit);
        }
        for path in &config.allowed_paths {
            cmd.arg("--allow").arg(path);
        }
        let mut child = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .map_err(|e| format!("could not start the engine process {}: {e}", binary.display()))?;
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = BufReader::new(child.stdout.take().ok_or("no stdout")?);
        Ok(Self {
            child: Mutex::new(child),
            stdin: Mutex::new(stdin),
            stdout: Mutex::new(stdout),
        })
    }

    fn request(&self, kind: u8, sql: &str) -> Result<(u8, Vec<u8>)> {
        // Hold the reader for the whole round trip, so replies match requests.
        let mut stdout = self.stdout.lock().map_err(|_| "engine client poisoned")?;
        {
            let mut stdin = self.stdin.lock().map_err(|_| "engine client poisoned")?;
            write_frame(&mut *stdin, kind, sql.as_bytes()).map_err(|e| format!("engine process gone: {e}"))?;
        }
        let (k, payload) = read_frame(&mut *stdout).map_err(|e| format!("engine process gone: {e}"))?;
        if k == ERROR {
            return Err(String::from_utf8_lossy(&payload).into_owned());
        }
        Ok((k, payload))
    }

    /// Ask the running statement to stop (cooperative cancel).
    pub fn interrupt(&self) -> Result<()> {
        let mut stdin = self.stdin.lock().map_err(|_| "engine client poisoned")?;
        write_frame(&mut *stdin, INTERRUPT, &[]).map_err(|e| e.to_string())
    }

    /// Kill the process (escalation).
    pub fn kill(&self) -> Result<()> {
        let mut child = self.child.lock().map_err(|_| "engine client poisoned")?;
        child.kill().map_err(|e| e.to_string())?;
        child.wait().map(|_| ()).map_err(|e| e.to_string())
    }
}

impl Drop for ProcessEngine {
    fn drop(&mut self) {
        let _ = self.kill();
    }
}

impl SqlEngine for ProcessEngine {
    async fn exec(&self, sql: &str) -> Result<()> {
        self.request(EXEC, sql).map(|_| ())
    }

    async fn query_arrow(&self, sql: &str) -> Result<Vec<RecordBatch>> {
        let (_, bytes) = self.request(QUERY, sql)?;
        from_ipc(&bytes)
    }
}
