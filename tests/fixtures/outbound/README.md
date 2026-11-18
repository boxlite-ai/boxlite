# Outbound contract examples

`contract-v1.json` supplies shared inputs for the [outbound implementation contract](../../../docs/contributing/architecture/outbound-contract.md).

- `policy_cases` describes the current strict mode/allowlist boundary; unsupported extensions remain rejected until their owning feature enables them.
- `connection_cases` separates the pre-NAT policy address, approved literal connection address, hostname, port, and protocol.
- `mode_transition_cases` requires ordinary forwarding and registered DNS endpoints to remain blocked during mode transitions and NIC failures; pending or uncertain transitions cannot acknowledge success.
- `replacement_cases` describes the revision protocol's required outcomes, including conflicts, acknowledgement uncertainty, conditional restoration, and crashes.

These are fixture inputs and expected outcomes, not an implementation or capability advertisement.

Consume them through each production parser, forwarding path, or replacement operation rather than testing values constructed solely inside a test.

`bootstrap-v1.json` is a minimal shim launch message with a disabled network and a private restored revision.
The Runtime launch encoder, shim parser, and gvproxy startup encoder consume it to verify metadata propagation while keeping the existing public configuration shapes.
Its paths are example values; live integration tests use temporary directories they own.

`proxy-contract-v1.json` lists proposed [proxy contract](../../../docs/contributing/architecture/outbound-proxy-contract.md) cases.
Each case names its input or starting state and expected outcome. An absent field models omission, while a JSON `null` models explicit clearing.

The proxy cases use synthetic registration names, credentials, and hosts. Later implementation
tests should observe the applicable production boundary, such as Runner dispatch, proxy relay,
or host resolver queries. The shared `contract-v1.json` cases describe the current foundation.
