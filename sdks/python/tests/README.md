# BoxLite Python SDK Tests

Unit tests for the BoxLite Python SDK box management functionality.

## Setup

Install dev dependencies:

```bash
# From sdks/python directory
pip install -e ".[dev]"
```

## Test Types

### 1. API Surface Tests (`test_box_management_mock.py`)
**Fast, no VM required** - Tests that verify the API is properly exported and callable.

```bash
pytest tests/test_box_management_mock.py
```

These tests run quickly (~0.02s) and don't require a working VM setup.

### 2. Integration Tests (`test_box_management.py`)
**Slow, requires VM** - Tests that create actual VM instances and verify full lifecycle.

```bash
# Run integration tests (requires working libkrun setup)
pytest tests/test_box_management.py -m integration

# Skip integration tests (for CI without VMs)
pytest -m "not integration"
```

These tests require:
- **boxlite-shim** binary (built during maturin develop)
- **guest-rootfs/** runtime tree (built during maturin develop)
- **libkrun** and **libkrunfw** installed on the system

## Running Tests

### Run all tests (API + integration):

```bash
pytest
```

### Run only API tests (fast):

```bash
pytest tests/test_box_management_mock.py -v
```

### Run with verbose output:

```bash
pytest -v
```

### Run specific test:

```bash
pytest tests/test_box_management_mock.py::TestBoxManagementAPI::test_list_boxes_function_exists
```

### Run with coverage:

```bash
pytest --cov=boxlite --cov-report=html
```

## Test Structure

### `test_box_management_mock.py` (12 tests, all passing ✅)
API surface verification without VMs:
  - **TestBoxManagementAPI** (8 tests)
    - Function existence: list_boxes, list_running, get_box_info, remove_box
    - Convenience aliases: list, ls
    - BoxInfo class exposure
    - Callability verification
  - **TestBoxInfoObject** (1 test)
    - BoxInfo attributes structure
  - **TestModuleStructure** (2 tests)
    - Module exports and version
  - **TestErrorHandling** (1 test)
    - Error conditions

### `test_box_management.py` (23 tests, requires VM)
Full lifecycle integration tests:
  - **TestBoxManagement** (21 tests)
    - Box ID generation and uniqueness
    - Listing boxes (all, by state, sorted)
    - Box metadata and info retrieval
    - State transitions (running → stopped)
    - Box removal
    - Multiple boxes isolation
  - **TestBoxInfoObject** (2 tests)
    - BoxInfo object properties and serialization

## Debugging

To see detailed output from the Rust runtime:

```bash
RUST_LOG=debug pytest -v -s
```

To run tests one at a time (useful for debugging):

```bash
pytest -v --maxfail=1
```

## Coverage

Current test coverage for box management:

- ✅ Box ID generation (ULID format, uniqueness, sortability)
- ✅ Box info retrieval (from handle and by ID)
- ✅ Listing boxes (all, filtered by state, sorted by creation time)
- ✅ State transitions (running → stopped)
- ✅ Box removal (stopped only, error on running)
- ✅ Metadata storage (image, CPUs, memory, port, PID)
- ✅ Multiple boxes isolation
- ✅ Convenience aliases (list, ls)
- ✅ BoxInfo object attributes

## Known Issues

None currently.

## Contributing

When adding new box management features, please add corresponding tests in this file.
