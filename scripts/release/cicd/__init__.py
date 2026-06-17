"""BoxLite release control-plane tooling.

Pure-logic building blocks for the standardized release pipeline (Task 21):

- ``manifest``          -- parse + validate ``release.yaml`` (the WHAT-to-ship contract)
- ``artifact_manifest`` -- the immutable build-once artifact record deploy trusts
- ``preflight``         -- pre-apply gates: resource diff, DB baseline, DNS collision
- ``ledger``            -- release ledger + last-good-SHA lookup for rollback
- ``versions``          -- OSS single-version-source drift check

None of these touch AWS/registries/CI; they operate on data + fixtures so they
can be unit-tested in isolation. The workflows that feed them real ``sst diff`` /
DB state / build outputs are wired separately.
"""
