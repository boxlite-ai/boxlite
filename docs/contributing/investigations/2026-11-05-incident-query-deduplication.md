# Deduplicated incident queries

## TL;DR

Admin CPU and memory queries select each Box's largest recorded metric within the requested range, then apply the row limit. Ingestion and stored evidence stay immutable.

## Problem and scope

Both incident services currently filter by time and optional Runner, order by ID, and limit raw snapshots. Repeated Boxes can consume the limit, hiding their higher measurements in later rows. CPU compares `cpuSeconds`; memory compares exact integer `memoryBytes`. Deduplicate by business Box ID across the filtered Runners, independently for each endpoint.

Keep existing response envelopes, ID ordering, authorization, and timestamp boundaries. Equal metrics choose the smaller numeric incident ID. CPU rows without attribution and originally empty memory snapshots remain separate evidence. Memory snapshots losing every Box are omitted; snapshots retaining winners contain only those winners in their original order. `limit` counts incident rows, so a memory row can still contain up to five distinct Boxes.

## Evidence and alternatives

- The two services' `list` methods and PostgreSQL integration tests at `apps/api/src/box/{cpu,memory}-incidents/` establish current filtering and precision contracts at commit `d963e872`.
- The memory entity stores up to five measurements in JSONB; its byte strings exceed JavaScript's safe integer range. Changing ingestion or flattening the response would expand the contract unnecessarily.
- [PostgreSQL 14 window functions](https://www.postgresql.org/docs/14/tutorial-window.html) retain the selected row's identity and operate after filtering. Use `row_number` with metric descending and ID ascending, then filter winners before the outer limit.
- [PostgreSQL 14 JSON processing](https://www.postgresql.org/docs/14/functions-json.html#FUNCTIONS-JSON-PROCESSING-TABLE) supports expanding the memory array. Cast extracted bytes to `bigint` for exact comparisons and retain ordinality for reconstruction.
- Local TypeORM 0.3.31 supports parameterized query builders and common table expressions. Keep selection in one database statement so ranking and result projection see the same snapshot.

Application-side deduplication after limiting is incorrect. Loading the entire range into JavaScript would preserve correctness but consume unbounded application memory. A grouped maximum without selecting the source row can mix metric, image, and sample metadata. SQL ranking selects the complete source observation. No migration or dependency is needed.

## How it works

CPU: filter → rank per Box → retain first rank and all null-attribution rows → order by incident ID → limit.

Memory: filter → expand JSONB entries → rank per Box → retain first rank → regroup by original incident ID → preserve originally empty snapshots → order by incident ID → limit. Preserve each winning entry's image and its source incident's sample time, Runner, and completeness. Database work scales with the selected range; output alone is bounded by `limit`.

## Validation

Add real-Postgres tests before production edits. Verify a later maximum survives `limit=1`, several Boxes with winners in different snapshots, numeric byte comparisons beyond safe integers, ties, range/Runner filters before ranking, null/empty observations, and immutable stored reports. Run against unchanged production to observe assertion failures, then implement and rerun the CPU/memory integration and HTTP suites. Check formatting and lint through Make targets.

Observed: all five new maximum-selection tests failed assertions against unchanged production code. After implementation, all 121 CPU/memory HTTP and PostgreSQL tests passed through `make test:apps:api TEST_FILES='(memory|cpu)-incident'`. Tests used isolated PostgreSQL schemas and real migrations. Changed TypeScript files were formatted with `make fmt:apps FILES=...`. Production query latency across large historical ranges remains unmeasured.

`make lint:apps` passed with zero errors and 393 existing warnings outside the changed incident files. `git diff --check` passed.
