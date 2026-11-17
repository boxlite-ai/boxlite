//! Probe: does the logind subscription survive the VMM seccomp filter?
//!
//! Runs in its own binary because `apply_vmm_filter` TSYNCs every thread of
//! the process and must not leak into other tests. Requires a host whose
//! system bus runs logind (a real Linux desktop or server, not CI).
#![cfg(target_os = "linux")]

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires a host with logind on the system bus; run on a real Linux machine"]
async fn logind_subscription_survives_the_vmm_seccomp_filter() {
    use boxlite::jailer::seccomp::apply_vmm_filter;

    apply_vmm_filter("resume-seccomp-probe").expect("the VMM seccomp filter must apply");

    let connection = zbus::Connection::system()
        .await
        .expect("the system bus must connect under the filter");
    let logind = zbus::Proxy::new(
        &connection,
        "org.freedesktop.login1",
        "/org/freedesktop/login1",
        "org.freedesktop.login1.Manager",
    )
    .await
    .expect("logind must be reachable under the filter");
    // Subscribing must succeed under the filter; the shim itself drives
    // signal delivery, so the stream only needs to stay alive here.
    let _subscription = logind
        .receive_signal("PrepareForSleep")
        .await
        .expect("subscribing to PrepareForSleep must work under the filter");
    println!("logind subscription works under the VMM seccomp filter");
}
