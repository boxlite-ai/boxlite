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

## Extended destination rules

`policy-rules-v1.json` defines the expected results for the [extended rule contract](../../../docs/contributing/architecture/outbound-contract.md#extended-destination-rules).

- `rule_cases` gives accepted rules and their canonical form. A null canonical value means the rule is invalid.
- `list_cases` exercises the separate allow and deny limits. Expand each count using repeated valid entries to check the limit before deduplication.
- `match_cases` checks a rule against the actual destination port, address, or observed name. `decision_cases` checks policy precedence.
- `request_cases` covers request shape, field presence, pending state, and backend support. When a case supplies `allow_count`, expand it to repeated valid rules in the request.
- `flow_cases` gives expected results for the forwarding integrations, including inspection, controlled resolution, platform protections, and registered services.

### Recovery and forwarding cases

- The superseding-request vectors follow an older ambiguous attempt with a confirmed or refused CAS. Restart the coordinator before testing the next omission.
- UDP NAT vectors observe endpoint creation and the external connector against the translated address. The DNS-family controls distinguish AAAA rejection on an IPv4-only dial path from a successful A record.

- The restoration vectors pair an uncertain restoration with a confirmed restoration after a completed backend deny failed to persist. Mixed DNS vectors list the ordered socket attempts for approved candidates.

- Parser-path vectors distinguish API rejection from rejection by the legacy bridge. Restart vectors compare an older absent deny list with a confirmed empty list. UDP lifecycle vectors distinguish delivery on an existing endpoint from admitting a new or reopened one.

The fixtures describe the extended policy for consuming tests. The corresponding backend behavior must be verified before it is advertised.
