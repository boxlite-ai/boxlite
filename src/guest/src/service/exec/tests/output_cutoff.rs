use super::*;
use nix::unistd::{pipe, write};

#[tokio::test]
async fn output_cutoff_freezes_bytes_and_preserves_terminal_offsets() {
    let (stdout, stdout_peer) = pipe().unwrap();
    let (stderr, stderr_peer) = pipe().unwrap();
    let manager = OutputManager::new(
        Some(ExecStdout::new(stdout).unwrap()),
        Some(ExecStderr::new(stderr).unwrap()),
    );
    write(&stdout_peer, b"out").unwrap();
    write(&stderr_peer, b"err").unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(1), async {
        while manager.retained_bytes().await != 6 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("readers must buffer the real pipe bytes");
    tokio::join!(manager.cut_off(), manager.cut_off());
    manager.push(OutputSource::Stdout, b"late".to_vec()).await;
    manager
        .reader_failed(OutputSource::Stderr, std::io::Error::other("late error"))
        .await;
    let summary = manager.wait_terminal_summary().await;
    assert!(summary.truncated);
    assert!(summary.reader_failure.is_none());
    assert_eq!(summary.stdout.total_bytes, 3);
    assert_eq!(summary.stderr.total_bytes, 3);
    assert!(manager.drain_tasks.lock().unwrap().is_empty());
    assert_eq!(write(&stdout_peer, b"late"), Err(nix::errno::Errno::EPIPE));
    assert_eq!(write(&stderr_peer, b"late"), Err(nix::errno::Errno::EPIPE));
    assert!(manager.seal().await);
    assert_eq!(manager.sealed_terminal_summary().await, Some(summary));
    let events: Vec<_> = manager.attach_retained().await.unwrap().collect().await;
    assert_eq!(events.len(), 4);
    assert!(events.into_iter().all(|event| event.is_ok()));
}

#[tokio::test]
async fn output_cutoff_after_natural_eof_keeps_untruncated_summary() {
    let (stdout, peer) = pipe().unwrap();
    let manager = OutputManager::new(Some(ExecStdout::new(stdout).unwrap()), None);
    write(&peer, b"complete").unwrap();
    drop(peer);
    let summary = manager.wait_terminal_summary().await;
    manager.cut_off().await;
    assert!(!summary.truncated);
    assert_eq!(summary.stdout.total_bytes, 8);
    assert_eq!(manager.terminal_summary().await, Some(summary));
}

#[tokio::test]
async fn output_cutoff_preserves_a_reader_failure_before_the_deadline() {
    let (stderr, _peer) = pipe().unwrap();
    let manager = OutputManager::new(None, Some(ExecStderr::new(stderr).unwrap()));
    manager
        .reader_failed(OutputSource::Stdout, std::io::Error::other("read failed"))
        .await;
    manager.cut_off().await;
    let summary = manager.wait_terminal_summary().await;
    assert!(summary.truncated);
    assert_eq!(
        summary.reader_failure.as_deref(),
        Some("failed to read Stdout: read failed")
    );
    let mut output = manager.attach().await.unwrap();
    assert_eq!(
        output.next().await.unwrap().unwrap_err().code(),
        tonic::Code::Internal
    );
}
