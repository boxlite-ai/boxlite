//! Regression: repeated `boxlite exec` into a long-lived box must not grow the
//! container's mount table.
//!
//! Each `boxlite exec` is a libcontainer *tenant* join. In libcontainer 0.5.x,
//! `adapt_spec_for_tenant` rebuilt the Linux block from `LinuxBuilder::default()`
//! and the init process applied `readonly_paths`/`masked_paths` *ungated* — so
//! every tenant exec re-bind-mounted ~9 paths (/proc/bus,/proc/fs,/proc/irq,
//! /proc/sys + /proc/asound,/proc/kcore,/proc/keys,/proc/timer_list,/sys/firmware)
//! into the **shared** container mount namespace. A long-lived box that is
//! frequently exec'd accumulated those mounts without bound (observed: +9 lines
//! in /proc/mounts per exec). The youki bump in this branch gates that
//! application behind `ContainerType::InitContainer`, so a tenant exec adds none.
//!
//! This test pins the fixed behavior: the /proc/mounts line count seen by a
//! tenant exec stays constant across repeated execs. On the pre-fix libcontainer
//! it grows monotonically and this fails.

use predicates::prelude::*;

mod common;

/// Read `/proc/mounts` line count from inside the box via a tenant exec.
fn mount_line_count(ctx: &common::TestContext, box_id: &str) -> usize {
    let output = ctx
        .new_cmd()
        .args(["exec", box_id, "--", "sh", "-c", "wc -l < /proc/mounts"])
        .assert()
        .success()
        .get_output()
        .clone();
    String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse::<usize>()
        .expect("wc -l should print an integer")
}

#[test]
fn exec_does_not_grow_proc_mounts() {
    let mut ctx = common::boxlite();

    ctx.cmd.args(["run", "-d", "alpine:latest", "sleep", "300"]);
    let output = ctx.cmd.assert().success().get_output().clone();
    let box_id = String::from_utf8_lossy(&output.stdout).trim().to_string();

    // Sanity: the box really is exec-able (and gives us the baseline).
    let baseline = mount_line_count(&ctx, &box_id);
    assert!(
        baseline > 0,
        "baseline /proc/mounts line count should be positive, got {baseline}"
    );

    // Each iteration is itself a tenant exec. Pre-fix, every one re-applies the
    // ro/masked path set, so the count read by the next exec is strictly larger.
    let mut counts = vec![baseline];
    for _ in 0..5 {
        counts.push(mount_line_count(&ctx, &box_id));
    }

    let max = *counts.iter().max().unwrap();
    let min = *counts.iter().min().unwrap();
    assert_eq!(
        max, min,
        "tenant exec must not change the container mount count; \
         /proc/mounts line counts across execs were {counts:?} \
         (growth here means libcontainer is re-applying ro/masked paths per exec)"
    );

    ctx.new_cmd()
        .args(["rm", "--force", &box_id])
        .assert()
        .success()
        .stdout(predicate::str::is_empty().or(predicate::str::contains(&box_id)));
}
