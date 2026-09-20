PHONY_TARGETS += coverage codecov

# Match Codecov's exclusions locally: production guest and SDK code must not
# disappear from the denominator just because their tests run separately.
COVERAGE_REPORT_ARGS = --ignore-filename-regex '(^|/)(src/deps/[^/]+/vendor|src/test-utils|tests)/'

# Optional nextest profile for the unit-coverage passes (CI passes
# NEXTEST_PROFILE=ci). Empty = nextest's default profile.
NEXTEST_PROFILE_FLAG = $(if $(NEXTEST_PROFILE),--profile $(NEXTEST_PROFILE),)

# Instrument core/shared/REST, non-VM integration, CLI, native VMM, and Linux
# guest tests. --no-report accumulates profiles across the passes; the clean
# first drops profiles left by earlier runs, which would otherwise be merged
# in and inflate the numbers. As in test:unit:rust, every pass runs even when
# an earlier one fails, and the recipe exits non-zero if any pass failed.
define run_unit_coverage
	@cargo llvm-cov clean --workspace
	@rc=0; \
	cargo llvm-cov nextest --no-report --no-tests=warn $(NEXTEST_PROFILE_FLAG) $(RUST_UNIT_CORE_ARGS) $(NEXTEST_FILTER) || rc=$$?; \
	cargo llvm-cov nextest --no-report --no-tests=warn $(NEXTEST_PROFILE_FLAG) $(RUST_UNIT_SHARED_ARGS) $(NEXTEST_FILTER) || rc=$$?; \
	cargo llvm-cov test --no-report $(RUST_UNIT_REST_ARGS) -- --test-threads=1 $(REST_CARGOTEST_FILTER) || rc=$$?; \
	$(MAKE) coverage:runtime || rc=$$?; \
	cargo llvm-cov nextest --no-report --no-tests=fail $(NEXTEST_PROFILE_FLAG) -p boxlite-cli --bins --test auth $(NEXTEST_FILTER) || rc=$$?; \
	cargo llvm-cov nextest --no-report --no-tests=warn $(NEXTEST_PROFILE_FLAG) -p boxlite-hypervisor -p boxlite-vmm --lib $(NEXTEST_FILTER) || rc=$$?; \
	$(MAKE) coverage:bindings || rc=$$?; \
	if [ "$$(uname)" = Linux ]; then \
		cargo llvm-cov nextest --no-report --no-tests=fail $(NEXTEST_PROFILE_FLAG) -p boxlite-guest $(NEXTEST_FILTER) || rc=$$?; \
	fi; \
	exit $$rc
endef

# Generate HTML coverage report (unit tests only).
coverage:
	@echo "📊 Generating code coverage report..."
	$(run_unit_coverage)
	@cargo llvm-cov report $(COVERAGE_REPORT_ARGS) --html --output-dir target/coverage
	@echo "✅ Coverage report: target/coverage/html/index.html"

# Generate LCOV output for CI upload.
coverage\:lcov:
	@echo "📊 Generating LCOV coverage..."
	$(run_unit_coverage)
	@mkdir -p target/coverage
	@cargo llvm-cov report $(COVERAGE_REPORT_ARGS) --lcov --output-path target/coverage/lcov.info
	@echo "✅ LCOV output: target/coverage/lcov.info"

coverage\:runtime:
	@cargo llvm-cov nextest --no-report --no-tests=fail $(NEXTEST_PROFILE_FLAG) \
		-p boxlite --no-default-features --features test-support \
		--test runtime --test shutdown --test network $(NEXTEST_FILTER)

coverage\:bindings:
	@rc=0; \
	cargo llvm-cov nextest --no-report --no-tests=fail $(NEXTEST_PROFILE_FLAG) \
		-p boxlite-c -p boxlite-node --lib $(NEXTEST_FILTER) || rc=$$?; \
	cargo llvm-cov nextest --no-report --no-tests=fail $(NEXTEST_PROFILE_FLAG) \
		-p boxlite-python --no-default-features --lib $(NEXTEST_FILTER) || rc=$$?; \
	exit $$rc

# Render collected profiles, including partial results from a failed test run.
coverage\:report:
	@mkdir -p target/coverage
	@cargo llvm-cov report $(COVERAGE_REPORT_ARGS) --lcov --output-path target/coverage/lcov.info
	@cargo llvm-cov report $(COVERAGE_REPORT_ARGS) --html --output-dir target/coverage

# Codecov enforces patch coverage against the PR base; total coverage is reported.
codecov: coverage\:lcov

# Go's reports include every package, including packages with no tests.
coverage\:go: dev\:go
	@mkdir -p target/coverage
	@rc=0; \
	(cd sdks/go && go test -tags boxlite_dev -covermode=atomic -coverpkg=./... \
		-coverprofile="$(PROJECT_ROOT)/target/coverage/go-sdk.out" $(GOTEST_FILTER) ./...) || rc=$$?; \
	(cd src/deps/libgvproxy-sys/gvproxy-bridge && go test -covermode=atomic -coverpkg=./... \
		-coverprofile="$(PROJECT_ROOT)/target/coverage/gvproxy.out" $(GOTEST_FILTER) ./...) || rc=$$?; \
	exit $$rc

coverage\:python: _ensure-python-deps
	@mkdir -p target/coverage/python
	@. .venv/bin/activate && cd sdks/python && \
		python -m pytest tests/ -m "not integration" $(PYTEST_FILTER) \
		--cov=boxlite --cov-report=term-missing \
		--cov-report=xml:../../target/coverage/python/coverage.xml

coverage\:node: _ensure-node-deps
	@cd sdks/node && npm test -- --coverage $(VITEST_FILTER)

coverage\:python\:integration: dev\:python
	@mkdir -p target/coverage/python
	@. .venv/bin/activate && cd sdks/python && \
		python -m pytest tests/ -m "not e2e" $(PYTEST_FILTER) \
		--cov=boxlite --cov-report=term-missing \
		--cov-report=xml:../../target/coverage/python/coverage.xml

coverage\:node\:integration: dev\:node
	@cd sdks/node && npm run test:all -- --coverage $(VITEST_FILTER)

coverage\:api: _ensure-apps-deps
	@cd apps && yarn nx run api:test --coverage --skip-nx-cache $(if $(FILTER),--testNamePattern '$(FILTER)',)

# Add VM integration coverage to the unit profiles instead of erasing them.
# Run coverage:lcov first for a combined report; BOXLITE_DEPS_STUB must be unset.
coverage\:integration: $(if $(SETUP_DONE),,runtime\:debug)
	@echo "📊 Generating integration test coverage..."
	@rc=0; \
	cargo llvm-cov nextest \
		-p boxlite --features krun,gvproxy --test '*' \
		--profile vm --no-report $(NEXTEST_FILTER) || rc=$$?; \
	cargo llvm-cov nextest -p boxlite-cli --test '*' \
		--profile vm --no-report $(NEXTEST_CLI_FILTER) || rc=$$?; \
	$(MAKE) coverage:report || rc=$$?; \
	exit $$rc
	@echo "✅ Combined coverage report: target/coverage/html/index.html"
