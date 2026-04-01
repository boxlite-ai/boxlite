use libcontainer::container::Container as LibContainer;
use libcontainer::signal::Signal;

/// Kill the container if running
pub(crate) fn kill_container(container: &mut LibContainer) {
    if !container.can_kill() {
        return;
    }

    let sigkill = Signal::try_from(9) // SIGKILL = 9
        .expect("SIGKILL (9) is a valid signal");

    let _ = container.kill(sigkill, true);
}

/// Delete the container
pub(crate) fn delete_container(container: &mut LibContainer) {
    let force = !container.can_delete();
    let _ = container.delete(force);
}
