//! macOS host wake detection — follows [krunkit `timesync.rs`](https://github.com/containers/krunkit/blob/main/src/timesync.rs).

use std::ffi::c_void;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Weak};
use std::thread;
use std::time::Duration;

use core_foundation::runloop::{
    __CFRunLoopSource, kCFRunLoopCommonModes, CFRunLoopAddSource, CFRunLoopGetCurrent,
    CFRunLoopRef, CFRunLoopRun, CFRunLoopStop,
};
use objc2_io_kit::{io_object_t, io_service_t, IONotificationPort, IORegisterForSystemPower};
use tokio_util::sync::CancellationToken;

use super::{map_iokit_power_message, HostPowerActivity};
use crate::runtime::rt_impl::{RuntimeImpl, SharedRuntimeImpl};

pub fn spawn(runtime: SharedRuntimeImpl, shutdown_token: CancellationToken) {
    let runtime = Arc::downgrade(&runtime);
    let run_loop_addr = Arc::new(AtomicUsize::new(0));
    let activity_rx = start_power_monitor(Arc::clone(&run_loop_addr));

    if let Err(e) = thread::Builder::new()
        .name("boxlite-host-sleep-watcher".into())
        .spawn(move || timesync_listener(runtime, activity_rx, shutdown_token, run_loop_addr))
    {
        tracing::error!(error = %e, "Failed to spawn host sleep watcher thread");
    }
}

/// Mirrors krunkit `timesync_listener`: block on power events, sync on wake.
fn timesync_listener(
    runtime: Weak<RuntimeImpl>,
    activity_rx: Receiver<HostPowerActivity>,
    shutdown_token: CancellationToken,
    run_loop_addr: Arc<AtomicUsize>,
) {
    let rt = match tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            tracing::error!(error = %e, "Failed to start host sleep watcher runtime");
            stop_power_monitor(&run_loop_addr);
            return;
        }
    };

    loop {
        if shutdown_token.is_cancelled() {
            break;
        }

        match activity_rx.recv_timeout(Duration::from_secs(1)) {
            Ok(HostPowerActivity::Sleep) => {
                tracing::debug!("System is going to sleep");
            }
            Ok(HostPowerActivity::Wake) => {
                tracing::info!("System is waking up; syncing guest clocks");
                if let Some(runtime) = runtime.upgrade() {
                    rt.block_on(runtime.sync_running_box_clocks("host_wake"));
                }
            }
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => {
                tracing::warn!("Host power monitor channel closed");
                break;
            }
        }
    }

    tracing::debug!("Host sleep watcher stopped");
    stop_power_monitor(&run_loop_addr);
}

fn stop_power_monitor(run_loop_addr: &Arc<AtomicUsize>) {
    let addr = run_loop_addr.load(Ordering::Acquire);
    if addr != 0 {
        unsafe {
            CFRunLoopStop(addr as CFRunLoopRef);
        }
    }
}

/// Mirrors krunkit `start_power_monitor`.
fn start_power_monitor(run_loop_addr: Arc<AtomicUsize>) -> Receiver<HostPowerActivity> {
    let (tx, rx) = mpsc::channel();
    if let Err(e) = thread::Builder::new()
        .name("boxlite-host-power-monitor".into())
        .spawn(move || unsafe {
            let tx_ptr = Box::into_raw(Box::new(tx));
            let mut notifier_port: *mut IONotificationPort = std::ptr::null_mut();
            let mut notifier_object: io_object_t = 0;

            let root_port = IORegisterForSystemPower(
                tx_ptr.cast(),
                &mut notifier_port,
                Some(power_callback),
                &mut notifier_object,
            );
            if root_port == 0 {
                tracing::error!("Failed to register for system power notifications");
                drop(Box::from_raw(tx_ptr));
                return;
            }

            let run_loop = CFRunLoopGetCurrent();
            run_loop_addr.store(run_loop as usize, Ordering::Release);

            let run_loop_source = IONotificationPort::run_loop_source(notifier_port).unwrap();
            CFRunLoopAddSource(
                run_loop,
                std::ptr::from_ref(&*run_loop_source) as *mut __CFRunLoopSource,
                kCFRunLoopCommonModes,
            );
            CFRunLoopRun();

            run_loop_addr.store(0, Ordering::Release);
            drop(Box::from_raw(tx_ptr));
        })
    {
        tracing::error!(error = %e, "Failed to spawn host power monitor thread");
    }
    rx
}

/// Mirrors krunkit `power_callback`.
#[allow(non_upper_case_globals)]
extern "C-unwind" fn power_callback(
    refcon: *mut c_void,
    _service: io_service_t,
    message_type: u32,
    _message_argument: *mut c_void,
) {
    let tx = unsafe { &*refcon.cast::<mpsc::Sender<HostPowerActivity>>() };
    tracing::debug!(message_type = format_args!("{message_type:#X}"), "Power callback called");
    let activity = map_iokit_power_message(message_type);
    if activity.is_none() {
        tracing::debug!(message_type = format_args!("{message_type:#X}"), "Unknown message type");
    }
    if let Some(activity) = activity
        && let Err(e) = tx.send(activity)
    {
        tracing::error!(error = %e, "Failed to send power activity");
    }
}
