PHONY_TARGETS += coverage

# Optional nextest profile for the unit-coverage passes (CI passes
# NEXTEST_PROFILE=ci). Empty = nextest's default profile.
NEXTEST_PROFILE_FLAG = $(if $(NEXTEST_PROFILE),--profile $(NEXTEST_PROFILE),)

# Instrument the same crate set test:unit:rust runs. --no-report accumulates
# the profiles across the passes so one report covers all of them; the clean
# first drops profiles left by earlier runs, which would otherwise be merged
# in and inflate the numbers. As in test:unit:rust, every pass runs even when
# an earlier one fails, and the recipe exits non-zero if any pass failed.
define run_unit_coverage
	@cargo llvm-cov clean --workspace
	@rc=0; \
	cargo llvm-cov nextest --no-report --no-tests=warn $(NEXTEST_PROFILE_FLAG) $(RUST_UNIT_CORE_ARGS) $(NEXTEST_FILTER) || rc=$$?; \
	cargo llvm-cov nextest --no-report --no-tests=warn $(NEXTEST_PROFILE_FLAG) $(RUST_UNIT_SHARED_ARGS) $(NEXTEST_FILTER) || rc=$$?; \
	cargo llvm-cov test --no-report $(RUST_UNIT_REST_ARGS) -- --test-threads=1 $(REST_CARGOTEST_FILTER) || rc=$$?; \
	exit $$rc
endef

# Generate HTML coverage report (unit tests only).
coverage:
	@echo "📊 Generating code coverage report..."
	$(run_unit_coverage)
	@cargo llvm-cov report --html --output-dir target/coverage
	@echo "✅ Coverage report: target/coverage/html/index.html"

# Generate LCOV output for CI upload.
coverage\:lcov:
	@echo "📊 Generating LCOV coverage..."
	$(run_unit_coverage)
	@mkdir -p target/coverage
	@cargo llvm-cov report --lcov --output-path target/coverage/lcov.info
	@echo "✅ LCOV output: target/coverage/lcov.info"

# Generate coverage for Rust integration tests (requires VM environment).
coverage\:integration: runtime\:debug
	@echo "📊 Generating integration test coverage..."
	@cargo llvm-cov nextest \
		-p boxlite --test '*' \
		--profile vm \
		--html --output-dir target/coverage-integration
	@echo "✅ Coverage report: target/coverage-integration/html/index.html"
