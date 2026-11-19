## TL;DR

Connect the agent API to `boxlite serve` and the Rust REST backend using the contract in [#2672](https://github.com/boxlite-ai/boxlite/issues/2672).

## Problem

**Status:** Implemented; in review. This design extends [#2672](https://github.com/boxlite-ai/boxlite/issues/2672).

Remote Boxes reject agent calls because `Agents` requires a local `BoxImpl`. The OpenAPI contract describes nine operations, but no server or REST client executes them.

## Scope

Implement the nine routes in `boxlite serve` and the corresponding Rust REST agent backend. Existing CLI commands should work with a REST runtime without changing their public syntax. Cloud routing and exposing the agent service port remain out of scope.

Acceptance requires request and response conformance, error and unsupported-capability forwarding, event-stream readiness and cancellation, and an end-to-end remote workflow. Existing local agent behavior must remain unchanged.

## Related work and lessons

| Method | Projects | Trade-off | Stance |
| --- | --- | --- | --- |
| Forward native capabilities and cursors | [A2A](https://github.com/a2aproject/A2A/blob/main/specification/a2a.proto) | No BoxLite journal; unsupported replay must fail explicitly | Pick: follows #2672 and the existing agent core |
| Separate event observation from execution | [AgentScope Java](https://github.com/agentscope-ai/agentscope-java/blob/main/docs/v2/en/docs/building-blocks/agent.md) | Observation does not resubmit a task; lifecycle must be explicit | Adopt: opening events must not start or cancel work |
| Fail uncertain writes without replay | [MCP Rust SDK](https://github.com/modelcontextprotocol/rust-sdk/blob/main/README.md) | Callers handle uncertainty rather than silently duplicating work | Adopt: expose the transport error without resubmission |
| Incremental SSE parser | [eventsource-parser](https://www.npmjs.com/package/eventsource-parser) | Correct framing across chunks; JavaScript dependency | Adapt the parser approach; reject the package for the Rust client |
| Persist and replay events in the service | [Cloudflare Agents](https://github.com/cloudflare/agents/blob/main/docs/agents/streams.md) | Durable recovery requires storage and retention ownership | Reject: the current agent core delegates recovery to adapters |
| Direct local calls only | BoxLite agent core | No transport complexity; remote callers remain unsupported | Reject: does not satisfy the request |

The [WHATWG event-stream format](https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation) supports multi-line data and multiple line endings. The client must parse streamed bytes across arbitrary chunk boundaries rather than assume one HTTP chunk per event.

The [LIMBO study](https://arxiv.org/abs/2609.29095) shows that failed or timed-out writes may already have taken effect. The transport must forward retry keys without inventing a local retry store or silently retrying non-idempotent calls.

## How it works

The server resolves the Box and agent under the requested parent. It maps the wire request to core options, then returns the result or core error according to the contract. A client creates an agent, opens its event stream, sends text, and reads the resulting turn through the Rust agent API.

Successful close and interrupt return HTTP 204 without a snapshot. A client that needs state may request it separately; failure to read it does not undo the confirmed control operation.

`AgentBackend` continues to own the adapter interface. A REST implementation stores create and get snapshots, preserving synchronous config, capabilities, state and turn accessors. Async operations use the existing authenticated `ApiClient` and the Box routing prefix.

When a response has null agent state, create and get still succeed. The synchronous state accessor returns `Unsupported`, matching an adapter that lacks state; config and capabilities remain available.

The server opens the native event stream before returning SSE headers. It forwards event data and emits an SSE ID only for a non-null cursor; a post-header error is sent as an error event before closing. Comment heartbeats keep idle connections open without producing client events. Dropping the client stream releases the connection without cancelling the agent turn.

Agent admission and AutoStop coordinate per Box. A stopping marker prevents new admissions for that Box while the actual stop runs without holding a global lock. Definite rejections release their reservations; uncertain admissions expire after a bounded grace period, and observed terminal states, including `unknown`, release their protection.

Agent record decoding shares the existing record module with the encoders. This preserves one mapping of state, result, request and steering values across REST and other consumers.

Response config decoding accepts additional server fields while validating known
field types; request config parsing rejects unknown fields. Successful explicit
stop clears the canonical Box's turn reservations and cached handle. Observers
check metadata without starting a Box and release protection when its run ends;
pauses and transient metadata failures retain protection. Work OpenCode resumes
after restart is outside the prior run's AutoStop protection.

REST response decoders and their round-trip tests compile only with the `rest` feature. Shared encoders and CLI input parsers remain available without it. Validate both feature configurations with warnings denied: runtime assembly builds the core library without REST before the Go SDK builds its REST-enabled C dependency.

Decoder tests use the `records::rest` namespace so the default `rest::` selector
in unit and coverage targets includes them. They cover enum rejection, child
identity mismatches, optional results, and additive response config fields.

Wire conversion must be shared or tested against the existing CLI record mapping, preserve omitted versus null fields and reject malformed inputs. URL path segments for opaque IDs must be encoded. The current OpenCode adapter supports only its advertised operations; unsupported controls keep their core error.

## Validation

| Claim or risk | Planned check |
| --- | --- |
| Existing remote rejection changes | Reproduce the current `Unsupported` result, then verify remote agent calls through the production client |
| Contract conformance | Exercise all routes, methods, bodies, headers, statuses and error envelopes through the server router |
| Stream correctness | Test ready-before-headers, split chunks, line endings, nullable cursors, post-open errors and cancellation |
| AutoStop coordination | Definite rejection releases the reservation; uncertain admission expires; unknown and other terminal states release it; a blocked stop does not prevent another Box from admitting work |
| SSE heartbeat | A keep-alive comment reaches an idle stream without becoming a REST client event |
| Record conversion | Round-trip representative agent, turn, result, request and steering records through shared encoders and decoders |
| Authentication and isolation | Check authorized and denied requests, plus agent and turn IDs under the wrong Box or parent |
| Snapshot and unsupported state | Create and get with null state succeed; state access returns `Unsupported` and other snapshot accessors still succeed |
| Mutation uncertainty | A lost response produces an error and exactly one upstream mutation attempt |
| Retry-key forwarding | Omitted and supplied keys reach the adapter unchanged; unsupported keys return `Unsupported` |
| Local behavior | Run existing agent and CLI tests with local runtime |
| End-to-end | Run a real remote create, event subscription, send and turn read against `boxlite serve` |
