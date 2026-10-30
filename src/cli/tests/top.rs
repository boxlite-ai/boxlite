//! `boxlite top`: the live-execution inventory, and the ids it hands back.

mod common;

use predicates::prelude::*;

fn start_box(ctx: &mut common::TestContext) -> String {
    ctx.cmd.args(["run", "-d", "alpine:latest", "sleep", "300"]);
    let output = ctx.cmd.assert().success().get_output().clone();
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn inventory(ctx: &common::TestContext, box_id: &str) -> Vec<serde_json::Value> {
    let output = ctx
        .new_cmd()
        .args(["top", "--format", "json", box_id])
        .assert()
        .success()
        .get_output()
        .clone();
    serde_json::from_slice(&output.stdout).expect("top --format json must emit a JSON array")
}

#[test]
fn test_top_lists_live_executions_including_the_main_session() {
    let mut ctx = common::boxlite();
    let box_id = start_box(&mut ctx);

    ctx.new_cmd()
        .args(["exec", "-d", &box_id, "--", "sleep", "300"])
        .assert()
        .success();

    let rows = inventory(&ctx, &box_id);
    let mains: Vec<_> = rows.iter().filter(|row| row["is_main"] == true).collect();
    assert_eq!(mains.len(), 1, "exactly one main session: {rows:?}");
    // The main session is registered under the container id, not the short id
    // `run -d` prints.
    assert_eq!(
        mains[0]["argv"],
        serde_json::json!(["sleep", "300"]),
        "main session must report the box's own command: {rows:?}"
    );

    let execs: Vec<_> = rows
        .iter()
        .filter(|row| row["is_main"] == false && row["argv"] == serde_json::json!(["sleep", "300"]))
        .collect();
    assert_eq!(execs.len(), 1, "the detached exec must be listed: {rows:?}");
    assert!(execs[0]["pid"].as_u64().unwrap() > 0, "{rows:?}");
    assert_eq!(execs[0]["tty"], false, "{rows:?}");

    ctx.cleanup_box(&box_id);
}

#[test]
fn test_top_id_kills_only_that_session() {
    let mut ctx = common::boxlite();
    let box_id = start_box(&mut ctx);

    for _ in 0..2 {
        ctx.new_cmd()
            .args(["exec", "-d", &box_id, "--", "sleep", "300"])
            .assert()
            .success();
    }

    let rows = inventory(&ctx, &box_id);
    let mut ids: Vec<String> = rows
        .iter()
        .filter(|row| row["is_main"] == false)
        .map(|row| row["execution_id"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(ids.len(), 2, "both detached execs must be listed: {rows:?}");
    let victim = ids.pop().unwrap();
    let survivor = ids.pop().unwrap();

    ctx.new_cmd()
        .args(["kill", &box_id, &victim])
        .assert()
        .success();

    let remaining = inventory(&ctx, &box_id);
    let remaining_ids: Vec<&str> = remaining
        .iter()
        .map(|row| row["execution_id"].as_str().unwrap())
        .collect();
    assert!(
        !remaining_ids.contains(&victim.as_str()),
        "killed session must leave the inventory: {remaining:?}"
    );
    assert!(
        remaining_ids.contains(&survivor.as_str()),
        "the other session must survive: {remaining:?}"
    );

    ctx.cleanup_box(&box_id);
}

#[test]
fn test_top_does_not_start_a_stopped_box() {
    let mut ctx = common::boxlite();
    let box_id = start_box(&mut ctx);

    ctx.new_cmd().args(["stop", &box_id]).assert().success();

    ctx.new_cmd()
        .args(["top", "--format", "json", &box_id])
        .assert()
        .success()
        .stdout(predicate::str::contains("[]"));

    ctx.new_cmd()
        .args(["ps", "-a", "--format", "json"])
        .assert()
        .success()
        .stdout(predicate::str::contains("\"running\"").not());

    ctx.cleanup_box(&box_id);
}
