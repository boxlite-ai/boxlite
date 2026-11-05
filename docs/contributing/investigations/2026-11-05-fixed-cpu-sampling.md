# Fixed CPU sampling and minute peaks

## TL;DR

Restore fixed host CPU sampling so `/info` keeps its original averaging horizon; expose short CPU spikes in minute resource logs through the maximum recent sample.

## Problem and scope

Adaptive host sampling changes the default sixty-sample `/info` history from about five minutes to about an hour at low cadence. Remove that behavior and its startup/freshness workarounds. Keep incident qualification above 80% for five observed minutes, two-minute Box capture windows, top-five memory reports, and query deduplication.

## Evidence and decisions

The pre-adaptation collector in `a6ca2deb` uses `CPU_USAGE_SNAPSHOT_INTERVAL` (default five seconds) for every host sample. Its monitor already qualifies five-second observations for five minutes. Reuse that implementation, retaining reader/reporter and input-validation fixes from the review.

`logResourceSnapshot` currently averages samples since its minute cutoff, while `/info` averages the whole sixty-entry ring. Keep the latter unchanged and give the logger a separate maximum-sample calculation using the same inclusive cutoff. If no sample falls in that minute, log a collection warning; do not reuse older samples. A zero maximum is a valid measurement. This requires no new dependencies or external algorithm; the existing ring and timestamp filter provide the needed boundary.

The log field stays `cpuPercent`. For readings 40 and 80 within the minute, the log becomes 80 instead of 60; `/info` still averages retained readings. Each reading itself covers the CPU counter interval, so the maximum is the largest sampled interval, not an instantaneous peak.

## Validation

Update the existing minute-log test from a mean of 60 to a maximum of 80 for readings of 40 and 80. It also checks that an older reading of 100 is excluded and that missing recent samples suppress the resource log. Run the existing CPU, memory, and metrics suites through Make with native-dependency stubs. Remove adaptive-cadence tests along with that implementation; do not add test cases for this revision.

Before production changes, the updated log test observed 60 and failed its expected-80 assertion. The restored implementation must pass that same assertion. Verify that only the logger calls the new maximum helper, while `/info` and healthchecks retain the full-ring mean. Keep query deduplication and the rest of the review fixes.

The updated existing log test passed after the change, including exclusion of the stale 100% reading. The existing CPU incident, memory incident, memory observation, resource-log, and collector tests passed through `make test:apps:runner` with native-dependency stubs. No additional test cases are retained for this revision. Inspection confirms that only the resource logger uses the maximum helper; `/info` and healthchecks retain the mean.
