PHONY_TARGETS += coverage

# Generate HTML coverage report (unit tests only).
coverage:
	@echo "📊 Generating code coverage report..."
	@cargo llvm-cov nextest --no-report -p boxlite --no-default-features --lib
	@cargo llvm-cov nextest --no-report -p boxlite-shared --lib
	@cargo llvm-cov report --html --output-dir target/coverage
	@echo "✅ Coverage report: target/coverage/html/index.html"

# Generate LCOV output for CI upload.
coverage\:lcov:
	@echo "📊 Generating LCOV coverage..."
	@cargo llvm-cov nextest \
		-p boxlite-shared --lib \
		--lcov --output-path target/coverage/lcov.info
	@echo "✅ LCOV output: target/coverage/lcov.info"

# Generate coverage for Rust integration tests (requires VM environment).
coverage\:integration: runtime\:debug
	@echo "📊 Generating integration test coverage..."
	@cargo llvm-cov nextest \
		-p boxlite --test '*' \
		--profile vm \
		--html --output-dir target/coverage-integration
	@echo "✅ Coverage report: target/coverage-integration/html/index.html"
