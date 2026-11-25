use super::*;

#[test]
fn checkpoint_rejects_paths_resolving_to_the_same_output_before_pausing() {
    let dir = tempfile::tempdir().unwrap();
    let output = dir.path().join("output");
    let alias = dir.path().join("alias");
    std::os::unix::fs::symlink(dir.path(), &alias).unwrap();
    // SAFETY: this creates an unstarted context; no VM is entered.
    let ctx = unsafe { KrunContext::create() }.unwrap();
    let result = capture_checkpoint(&ctx, dir.path(), None, None, &output, &alias.join("output"));
    assert!(
        matches!(result, Err(ControlError::InvalidInput(_))),
        "{result:?}"
    );
}

#[test]
fn ensure_within_tmp_accepts_subpaths_and_rejects_escapes() {
    let dir = tempfile::tempdir().unwrap();
    let tmp_dir = dir.path().join("tmp");
    let ckpt_dir = tmp_dir.join("ckpt-1");
    std::fs::create_dir_all(&ckpt_dir).unwrap();

    let valid = ckpt_dir.join("vmstate.krun");
    assert!(ensure_within_tmp(&valid, &tmp_dir).is_ok());

    // Relative path rejected.
    assert!(matches!(
        ensure_within_tmp(Path::new("vmstate.krun"), &tmp_dir),
        Err(ControlError::InvalidInput(_))
    ));

    // Escape outside tmp_dir rejected.
    let outside = dir.path().join("outside.krun");
    assert!(matches!(
        ensure_within_tmp(&outside, &tmp_dir),
        Err(ControlError::InvalidInput(_))
    ));

    // Parent traversal rejected.
    let traversal = ckpt_dir.join("../../escape.krun");
    assert!(matches!(
        ensure_within_tmp(&traversal, &tmp_dir),
        Err(ControlError::InvalidInput(_))
    ));

    // Symlink target inside tmp_dir rejected.
    let link = ckpt_dir.join("sym.krun");
    std::os::unix::fs::symlink(&outside, &link).unwrap();
    assert!(matches!(
        ensure_within_tmp(&link, &tmp_dir),
        Err(ControlError::InvalidInput(_))
    ));
}
