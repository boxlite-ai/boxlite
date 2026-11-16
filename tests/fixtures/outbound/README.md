# Outbound contract examples

`contract-v1.json` supplies shared inputs for the [outbound implementation contract](../../../docs/contributing/architecture/outbound-contract.md).

- `policy_cases` describes the current strict mode/allowlist boundary; unsupported extensions remain rejected until their owning feature enables them.
- `connection_cases` separates the pre-NAT policy address, approved literal connection address, hostname, port, and protocol.
- `replacement_cases` describes the revision protocol's required outcomes, including conflicts, acknowledgement uncertainty, conditional restoration, and crashes.

These are fixture inputs and expected outcomes, not an implementation or capability advertisement.

Consume them through each production parser, forwarding path, or replacement operation rather than testing values constructed solely inside a test.
