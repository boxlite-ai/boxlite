# REST Test Utilities

Utilities in this directory support the reusable REST API test workflow.

## Inventory

Run:

```bash
make test:rest:inventory
```

This parses `openapi/box.openapi.yaml`, scans candidate REST/E2E/CLI test files,
and writes:

- `target/rest-test-report/rest-inventory.md`
- `target/rest-test-report/rest-inventory.json`

The report is intentionally conservative. `candidate` means matching test text
exists; it does not claim the operation is fully asserted.
