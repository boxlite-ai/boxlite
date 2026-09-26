//! Parsing for `-v`/`--volume` mount specs.
//!
//! One token has to say which of three things the caller meant, so the rule is
//! Docker's, character for character
//! (`docker/cli/internal/volumespec/volumespec.go:33-49` for the scanner,
//! `:96-124` for the classification):
//!
//! - The spec is split by scanning, not by `split(':')`. A colon preceded by
//!   exactly one letter is a Windows drive letter and is absorbed into the
//!   field rather than ending it, so `C:\data:/app` splits into two fields and
//!   not three.
//! - The source field is then classified by its **first character**: `.`, `/`,
//!   `~`, a `\\` prefix, or `X:` mean a host path. Anything else is a managed
//!   volume, addressed by id or by name.
//!
//! Docker's own failure mode does not carry over. There, a mistyped source
//! silently creates an empty volume and the caller's data appears to vanish;
//! boxlite never auto-creates, so an unknown reference is a loud "not found"
//! from the server (`VolumeService.validateVolumes`).
//!
//! Unlike Docker this classification happens exactly once. Docker re-derives it
//! daemon-side from an untyped string (`moby/daemon/volume/mounts/linux_parser.go`,
//! `ParseMountRaw` re-testing `path.IsAbs`); `VolumeSpec` carries
//! `managed_volume` and `host_path` as separate fields, so the decision made
//! here survives all the way to the wire.

/// Where a parsed mount's contents come from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MountOrigin {
    /// A managed volume, by server-assigned id or by name.
    ManagedVolume(String),
    /// A host directory or file. Relative paths are resolved by the caller.
    BindMount(String),
    /// No source given — the caller wants scratch space at `guest_path`.
    Anonymous,
}

/// One `-v` spec, resolved into an origin plus its mount point.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedMount {
    pub origin: MountOrigin,
    pub guest_path: String,
    pub read_only: bool,
    /// Prefix inside a managed volume to mount instead of the whole volume.
    /// Empty means the whole volume, matching `VolumeSpec::sub_path`.
    pub sub_path: String,
}

/// The comma-separated `OPTIONS` field, once parsed.
#[derive(Debug, Default)]
struct MountOptions {
    read_only: bool,
    sub_path: String,
}

/// Parse one `-v` value.
///
/// Grammar, after the drive-aware split:
/// - `BOX_PATH` / `BOX_PATH:OPTIONS` — anonymous volume
/// - `SOURCE:BOX_PATH[:OPTIONS]` — managed volume or host bind, per `classify`
///
/// `OPTIONS` is a comma-separated list of `ro`, `rw` and `subpath=PREFIX`;
/// anything else is an error rather than silently ignored, because a
/// misspelt `subpath` would otherwise mount the whole volume unnoticed.
pub fn parse(spec: &str) -> anyhow::Result<ParsedMount> {
    let spec = spec.trim();
    if spec.is_empty() {
        anyhow::bail!("empty volume spec");
    }

    let fields = split_fields(spec);
    let fields: Vec<&str> = fields.iter().map(|f| f.trim()).collect();

    match fields.as_slice() {
        [guest] => Ok(ParsedMount {
            origin: MountOrigin::Anonymous,
            guest_path: absolute_box_path(guest)?,
            read_only: false,
            sub_path: String::new(),
        }),

        // `BOX_PATH:ro` is an anonymous volume with options, not a source named
        // "ro". The second field is an options list when it is not itself a
        // path and holds at least one recognisable option (`ro`, `rw`, or a
        // `key=value`). `/host:data` has no such item and stays a bind mount
        // with a non-absolute box path; `/host/data:/opt/key=value` is a path,
        // so its `=`-bearing box path survives. A non-absolute first field
        // still reaches this arm so the error names it rather than the option.
        [guest, options] if !options.starts_with('/') && looks_like_options(options) => {
            // Box path first: a spec that gets both wrong should name the field
            // the caller has to fix, and `subpath=` on what the caller meant as a
            // volume reference would otherwise report an anonymous-volume error.
            //
            // A second field holding `key=value` is read as options even when the
            // first field is a source, because a box path is always absolute and
            // `relative=path` could never be one. Both readings reject the spec;
            // this one names the option.
            let guest_path = absolute_box_path(guest)?;
            let options = parse_options(options, &MountOrigin::Anonymous)?;
            Ok(ParsedMount {
                origin: MountOrigin::Anonymous,
                guest_path,
                read_only: options.read_only,
                sub_path: options.sub_path,
            })
        }

        [source, guest] => Ok(ParsedMount {
            origin: classify(source)?,
            guest_path: absolute_box_path(guest)?,
            read_only: false,
            sub_path: String::new(),
        }),

        [source, guest, options] => {
            let origin = classify(source)?;
            // Box path before options, as in the two-field arm: a spec that gets
            // both wrong should name the same field either way.
            let guest_path = absolute_box_path(guest)?;
            let options = parse_options(options, &origin)?;
            Ok(ParsedMount {
                origin,
                guest_path,
                read_only: options.read_only,
                sub_path: options.sub_path,
            })
        }

        _ => anyhow::bail!(
            "invalid volume spec {spec:?}; use VOLUME:BOX_PATH, HOST_PATH:BOX_PATH[:OPTIONS], \
             or BOX_PATH[:OPTIONS] for an anonymous volume"
        ),
    }
}

/// Split on `:`, except where the colon is a Windows drive separator.
///
/// Mirrors the scanner in `volumespec.go`: a colon terminates a field unless
/// the field so far is exactly one letter, in which case it belongs to the
/// field. That is what keeps `C:\data` whole without counting colons.
///
/// Upstream: `docker/cli/internal/volumespec/volumespec.go:33-49`.
fn split_fields(spec: &str) -> Vec<String> {
    let mut fields = Vec::new();
    let mut buffer = String::new();

    for ch in spec.chars() {
        if ch == ':' && !is_drive_letter(&buffer) {
            fields.push(std::mem::take(&mut buffer));
        } else {
            buffer.push(ch);
        }
    }
    fields.push(buffer);

    fields
}

/// A field holding exactly one ASCII letter — the left half of `C:`.
fn is_drive_letter(buffer: &str) -> bool {
    let mut chars = buffer.chars();
    matches!((chars.next(), chars.next()), (Some(c), None) if c.is_ascii_alphabetic())
}

/// Decide whether a source names a host path or a managed volume.
///
/// First character only, as `isFilePath` does
/// (`docker/cli/internal/volumespec/volumespec.go:108-124`). Nothing here
/// inspects the filesystem:
/// a spec must mean the same thing on every machine, whether or not the path
/// happens to exist.
fn classify(source: &str) -> anyhow::Result<MountOrigin> {
    if source.is_empty() {
        anyhow::bail!("volume source must be non-empty");
    }

    let host_path = match source.chars().next() {
        Some('.') | Some('/') | Some('~') => true,
        // UNC path or Windows named pipe.
        _ if source.starts_with(r"\\") => true,
        _ => is_windows_drive_prefix(source),
    };

    Ok(if host_path {
        MountOrigin::BindMount(source.to_string())
    } else {
        MountOrigin::ManagedVolume(source.to_string())
    })
}

/// `C:\data` or `C:/data` — a drive letter, a colon, then a separator.
///
/// Public to the crate so the host-path resolver shares this one definition:
/// on Unix `Path::is_relative` calls `C:\data` relative and would canonicalize
/// it against the working directory.
pub fn is_windows_drive_prefix(source: &str) -> bool {
    let bytes = source.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
}

fn is_mode(field: &str) -> bool {
    field.eq_ignore_ascii_case("ro") || field.eq_ignore_ascii_case("rw")
}

/// Whether a field holds at least one item that can only be an option:
/// `ro`/`rw` or a `key=value`. A box path or a host path never does.
fn looks_like_options(field: &str) -> bool {
    field
        .split(',')
        .map(str::trim)
        .any(|item| is_mode(item) || item.contains('='))
}

/// Parse the OPTIONS list: `ro` | `rw` | `subpath=PREFIX`, comma-separated.
///
/// Unknown options are an error. The old behaviour silently ignored them, which
/// was harmless while `ro` was the only option; with `subpath` a typo would
/// silently expose the whole volume instead of one prefix.
///
/// `subpath` is only meaningful for a managed volume: the server resolves the
/// prefix inside the volume and binds just that directory. A host bind can
/// name the sub-directory directly, and an anonymous volume is empty.
fn parse_options(options: &str, origin: &MountOrigin) -> anyhow::Result<MountOptions> {
    let mut parsed = MountOptions::default();
    let mut mode: Option<&str> = None;
    for item in options.split(',').map(str::trim) {
        if item.is_empty() {
            anyhow::bail!("empty volume option in {options:?}");
        }
        if is_mode(item) {
            if let Some(previous) = mode
                && !previous.eq_ignore_ascii_case(item)
            {
                anyhow::bail!("volume options {options:?} set both ro and rw");
            }
            mode = Some(item);
            parsed.read_only = item.eq_ignore_ascii_case("ro");
            continue;
        }
        if let Some(prefix) = item.strip_prefix("subpath=") {
            if !parsed.sub_path.is_empty() {
                anyhow::bail!("volume options {options:?} set subpath twice");
            }
            parsed.sub_path = validate_sub_path(prefix, origin)?;
            continue;
        }
        anyhow::bail!(
            "unknown volume option {item:?} in {options:?}; supported: ro, rw, subpath=PREFIX"
        );
    }
    Ok(parsed)
}

/// Reject a prefix the server would reject, giving the server's reason.
///
/// Rule for rule from `validateSubpaths`
/// (`apps/api/src/box/utils/volume-mount-path-validation.util.ts`): no leading
/// `/`, no `..` **anywhere** in the string, no `//`. The `..` test is a
/// substring and not a path-component test there, so `a..b` is refused even
/// though it traverses nothing; matching that exactly is the point, since a
/// local rule that is merely similar sends the caller the 400 this check
/// exists to prevent.
///
/// Each reason below is the server's parenthetical copied exactly; only the
/// leading word is lower-cased, since a Rust error does not start a sentence.
///
/// One deliberate difference: the server treats an absent subpath as the whole
/// volume, while an explicitly empty `subpath=` here is a typo rather than a
/// request — the option can simply be left out.
fn validate_sub_path(prefix: &str, origin: &MountOrigin) -> anyhow::Result<String> {
    match origin {
        MountOrigin::ManagedVolume(_) => {}
        MountOrigin::BindMount(path) => anyhow::bail!(
            "subpath applies to managed volumes only; bind mount the sub-directory of \
             {path:?} directly instead"
        ),
        MountOrigin::Anonymous => {
            anyhow::bail!("subpath applies to managed volumes only; an anonymous volume is empty")
        }
    }
    if prefix.is_empty() {
        anyhow::bail!("subpath must not be empty; omit the option to mount the whole volume");
    }
    if prefix.starts_with('/') {
        anyhow::bail!("invalid subpath {prefix:?} (S3 key prefixes cannot start with /)");
    }
    if prefix.contains("..") {
        anyhow::bail!("invalid subpath {prefix:?} (cannot contain .. for security)");
    }
    if prefix.contains("//") {
        anyhow::bail!("invalid subpath {prefix:?} (cannot contain consecutive slashes)");
    }
    Ok(prefix.to_string())
}

/// The mount point inside the box. Always POSIX-absolute: guests are Linux, so
/// unlike Docker there is no Windows-destination case to allow for.
fn absolute_box_path(guest: &str) -> anyhow::Result<String> {
    if guest.is_empty() {
        anyhow::bail!("volume box path must be non-empty");
    }
    if !guest.starts_with('/') {
        anyhow::bail!("volume box path must be absolute (e.g. /data), got {guest:?}");
    }
    Ok(guest.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn managed(spec: &str) -> String {
        match parse(spec).unwrap().origin {
            MountOrigin::ManagedVolume(volume) => volume,
            other => panic!("{spec:?} should be a managed volume, got {other:?}"),
        }
    }

    fn host(spec: &str) -> String {
        match parse(spec).unwrap().origin {
            MountOrigin::BindMount(path) => path,
            other => panic!("{spec:?} should be a host path, got {other:?}"),
        }
    }

    #[test]
    fn bare_source_is_a_managed_volume() {
        assert_eq!(managed("my-data:/data"), "my-data");
        assert_eq!(managed("vol_01K2EXAMPLE:/data"), "vol_01K2EXAMPLE");
        assert_eq!(managed("data:/data"), "data");
    }

    /// A one-letter source is unreachable, and deliberately so: the scanner
    /// cannot tell `a:` from a drive letter, so it absorbs the colon and the
    /// whole spec becomes a single field — which then fails as a non-absolute
    /// box path. Docker's scanner behaves identically (`isWindowsDrive` tests
    /// only that the buffer is one letter). Single-character volume names are
    /// therefore not addressable via `-v`; Docker rejects them outright with
    /// "volume name is too short".
    #[test]
    fn single_letter_source_is_swallowed_as_a_drive_letter() {
        let error = parse("a:/data").unwrap_err().to_string();
        assert!(error.contains("must be absolute"), "{error}");
    }

    #[test]
    fn leading_dot_slash_or_tilde_is_a_host_path() {
        assert_eq!(host("/host/data:/data"), "/host/data");
        assert_eq!(host("./data:/data"), "./data");
        assert_eq!(host("../data:/data"), "../data");
        assert_eq!(host("~/data:/data"), "~/data");
    }

    /// The case that broke an earlier attempt at this: the drive colon must not
    /// end the field, or `C` is read as a volume named "C".
    #[test]
    fn windows_drive_paths_survive_the_split() {
        assert_eq!(host(r"C:\data:/data"), r"C:\data");
        assert_eq!(host(r"D:/host/path:/data"), r"D:/host/path");
        assert_eq!(host(r"\\server\share:/data"), r"\\server\share");
    }

    #[test]
    fn windows_drive_path_still_takes_options() {
        let mount = parse(r"C:\data:/data:ro").unwrap();
        assert_eq!(mount.origin, MountOrigin::BindMount(r"C:\data".to_string()));
        assert_eq!(mount.guest_path, "/data");
        assert!(mount.read_only);
    }

    #[test]
    fn anonymous_forms() {
        assert_eq!(parse("/data").unwrap().origin, MountOrigin::Anonymous);
        let read_only = parse("/data:ro").unwrap();
        assert_eq!(read_only.origin, MountOrigin::Anonymous);
        assert!(read_only.read_only);
        assert!(!parse("/data:rw").unwrap().read_only);
    }

    #[test]
    fn read_only_option_is_parsed_for_both_origins() {
        assert!(parse("my-data:/data:ro").unwrap().read_only);
        assert!(parse("/host:/data:ro").unwrap().read_only);
        assert!(!parse("/host:/data:rw").unwrap().read_only);
        assert!(!parse("/host:/data:RW").unwrap().read_only);
    }

    /// A typo in `subpath` must not fall through to "mount the whole volume",
    /// so the old ignore-unknown behaviour is gone for every origin.
    #[test]
    fn unknown_options_are_rejected() {
        for spec in [
            "/host:/data:rw,nocopy",
            "my-data:/data:subpth=a",
            "/data:ro,z",
        ] {
            let error = parse(spec).unwrap_err().to_string();
            assert!(error.contains("unknown volume option"), "{spec}: {error}");
            assert!(error.contains("subpath=PREFIX"), "{spec}: {error}");
        }
        let error = parse("my-data:/data:ro,rw").unwrap_err().to_string();
        assert!(error.contains("both ro and rw"), "{error}");
        let error = parse("my-data:/data:ro,").unwrap_err().to_string();
        assert!(error.contains("empty volume option"), "{error}");
    }

    #[test]
    fn subpath_option_is_parsed_for_managed_volumes() {
        let mount = parse("run42:/work:subpath=agents/extract/").unwrap();
        assert_eq!(
            mount.origin,
            MountOrigin::ManagedVolume("run42".to_string())
        );
        assert_eq!(mount.guest_path, "/work");
        assert_eq!(mount.sub_path, "agents/extract/");
        assert!(!mount.read_only);

        let mount = parse("run42:/work:ro,subpath=agents/extract").unwrap();
        assert!(mount.read_only);
        assert_eq!(mount.sub_path, "agents/extract");
        // Order does not matter.
        let mount = parse("run42:/work:subpath=agents/extract,ro").unwrap();
        assert!(mount.read_only);
        assert_eq!(mount.sub_path, "agents/extract");
        // No option leaves the whole volume mounted.
        assert_eq!(parse("run42:/work").unwrap().sub_path, "");
    }

    /// Every prefix the server's `validateSubpaths` refuses must be refused
    /// here, and for the reason it gives — a rule that is only close would
    /// send the caller the 400 this check exists to prevent.
    #[test]
    fn subpath_is_rejected_exactly_where_the_server_rejects_it() {
        let error = parse("run42:/work:subpath=/abs").unwrap_err().to_string();
        assert!(
            error.contains("S3 key prefixes cannot start with /"),
            "{error}"
        );

        // `..` is a substring test on the server, so `a..b` is refused there
        // even though it traverses nothing.
        for spec in [
            "run42:/work:subpath=../x",
            "run42:/work:subpath=a/../b",
            "run42:/work:subpath=a..b/c",
        ] {
            let error = parse(spec).unwrap_err().to_string();
            assert!(
                error.contains("cannot contain .. for security"),
                "{spec}: {error}"
            );
        }

        let error = parse("run42:/work:subpath=a//b").unwrap_err().to_string();
        assert!(
            error.contains("cannot contain consecutive slashes"),
            "{error}"
        );

        // Stricter than the server on one point, and deliberately so: an
        // explicitly empty `subpath=` is a typo, not a request for everything.
        let error = parse("run42:/work:subpath=").unwrap_err().to_string();
        assert!(error.contains("must not be empty"), "{error}");
        let error = parse("run42:/work:subpath=a,subpath=b")
            .unwrap_err()
            .to_string();
        assert!(error.contains("subpath twice"), "{error}");
    }

    /// A trailing `:` with nothing after it used to parse as read-write. Under
    /// the strict option policy an empty option is a mistake like any other, and
    /// is reported rather than ignored.
    #[test]
    fn a_trailing_empty_options_field_is_rejected() {
        for spec in ["my-data:/data:", "/host:/data:"] {
            let error = parse(spec).unwrap_err().to_string();
            assert!(error.contains("empty volume option"), "{spec}: {error}");
        }
    }

    /// A non-absolute box path is named in the error whatever the options say.
    /// The options arm has to take such a spec for that, and has to check the
    /// box path before the options: reporting `ro`, or an anonymous-volume
    /// complaint about `subpath=`, points the caller at the wrong field.
    #[test]
    fn a_relative_box_path_with_options_names_the_box_path() {
        for spec in [
            "./data:ro",
            "~/data:ro",
            "my-data:ro",
            "my-data:subpath=agents/extract",
            "./data:ro,subpath=agents/extract",
        ] {
            let error = parse(spec).unwrap_err().to_string();
            assert!(error.contains("must be absolute"), "{spec}: {error}");
            let offender = spec.split(':').next().unwrap();
            assert!(error.contains(offender), "{spec}: {error}");
        }
    }

    /// Both arms report the box path first, so the field the caller has to fix
    /// does not depend on how many fields the spec happens to have.
    #[test]
    fn both_arms_name_the_box_path_before_the_options() {
        for spec in ["my-data:data:nocopy", "/host:data:nocopy", "my-data:data"] {
            let error = parse(spec).unwrap_err().to_string();
            assert!(error.contains("must be absolute"), "{spec}: {error}");
            assert!(error.contains("data"), "{spec}: {error}");
        }
    }

    /// The mirror image: a two-field spec whose second field is a relative
    /// `key=value` is read as options, since no box path is relative. Both
    /// readings reject it, and this is the one the parser commits to.
    #[test]
    fn a_relative_key_value_second_field_is_read_as_options() {
        let error = parse("/host/data:relative=path").unwrap_err().to_string();
        assert!(error.contains("unknown volume option"), "{error}");
        assert!(error.contains("relative=path"), "{error}");
    }

    /// A box path may contain `=`, which an options list also does. The second
    /// field is only an options list when it is not itself a path.
    #[test]
    fn an_equals_in_the_box_path_is_not_an_option_list() {
        let mount = parse("/host/data:/opt/key=value").unwrap();
        assert_eq!(
            mount.origin,
            MountOrigin::BindMount("/host/data".to_string())
        );
        assert_eq!(mount.guest_path, "/opt/key=value");
        assert_eq!(mount.sub_path, "");
    }

    /// Only a managed volume has a prefix to select. A host bind names the
    /// sub-directory itself, and an anonymous volume starts empty.
    #[test]
    fn subpath_is_refused_for_host_binds_and_anonymous_volumes() {
        let error = parse("/host:/data:subpath=a").unwrap_err().to_string();
        assert!(error.contains("managed volumes only"), "{error}");
        assert!(error.contains("bind mount the sub-directory"), "{error}");
        let error = parse("/data:subpath=a").unwrap_err().to_string();
        assert!(error.contains("managed volumes only"), "{error}");
        assert!(error.contains("anonymous volume"), "{error}");
        // The anonymous shorthand with a mode still works.
        assert!(parse("/data:ro").unwrap().read_only);
    }

    #[test]
    fn box_path_must_be_absolute() {
        for spec in ["my-data:data", "/host:data", "data"] {
            let error = parse(spec).unwrap_err().to_string();
            assert!(error.contains("must be absolute"), "{spec}: {error}");
        }
    }

    #[test]
    fn rejects_empty_and_overlong_specs() {
        assert!(parse("").unwrap_err().to_string().contains("empty"));
        assert!(parse("   ").unwrap_err().to_string().contains("empty"));
        let error = parse("a:/b:ro:extra:more").unwrap_err().to_string();
        assert!(error.contains("invalid volume spec"), "{error}");
    }
}
