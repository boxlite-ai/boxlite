//! Capture `tracing` output so a test can assert what was — and was not — logged.
//!
//! For code whose only observable effect is a log line: a warning that must
//! fire when something was hidden from a sweep, and must stay quiet when
//! nothing was. Asserting the return value alone cannot tell those apart.

use std::sync::{Arc, Mutex};

/// A [`MakeWriter`](tracing_subscriber::fmt::MakeWriter) that appends every
/// byte the subscriber writes into a shared buffer.
#[derive(Clone)]
struct BufWriter(Arc<Mutex<Vec<u8>>>);

impl std::io::Write for BufWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for BufWriter {
    type Writer = BufWriter;
    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

/// Run `f` with a subscriber of its own and return its value alongside
/// everything that subscriber wrote.
///
/// The subscriber is scoped to the closure via
/// `tracing::subscriber::with_default`, so a test that captures does not
/// disturb one that does not. ANSI is off, so assertions match plain text.
pub fn capture<T>(f: impl FnOnce() -> T) -> (T, String) {
    let buf = Arc::new(Mutex::new(Vec::<u8>::new()));
    let subscriber = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::TRACE)
        .with_writer(BufWriter(buf.clone()))
        .with_ansi(false)
        .finish();

    let value = tracing::subscriber::with_default(subscriber, f);

    let logged = String::from_utf8(buf.lock().unwrap().clone()).expect("utf8 trace output");
    (value, logged)
}
