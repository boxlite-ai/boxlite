# Skills-only BoxLite distribution; no runtime build is required.
PHONY_TARGETS += plugin-boxlite-force
PLUGIN_PYTHON ?= python3
PLUGIN_COVERAGE_PYTHON ?= $(PLUGIN_PYTHON)
PLUGIN_COVERAGE = PYTHONDONTWRITEBYTECODE=1 COVERAGE_FILE=target/coverage/plugins/.coverage COVERAGE_RCFILE=scripts/plugins/.coveragerc $(PLUGIN_COVERAGE_PYTHON) -m coverage
plugin-boxlite-force:

test\:unit\:plugins: plugin-boxlite-force
	@PYTHONDONTWRITEBYTECODE=1 $(PLUGIN_PYTHON) -m unittest discover -s tests/plugins -p 'test_*.py'

plugin\:boxlite\:check: plugin-boxlite-force
	@$(PLUGIN_PYTHON) scripts/plugins/boxlite.py check
	@$(MAKE) --no-print-directory test:unit:plugins

plugin\:boxlite\:dist: plugin-boxlite-force plugin\:boxlite\:check
	@$(PLUGIN_PYTHON) scripts/plugins/boxlite.py dist

plugin\:boxlite\:check\:cc: plugin-boxlite-force plugin\:boxlite\:dist
	@claude plugin validate --strict plugins/boxlite
	@claude plugin validate --strict target/plugins/boxlite-marketplace
plugin\:boxlite\:coverage: plugin-boxlite-force
	@mkdir -p target/coverage/plugins
	@$(PLUGIN_COVERAGE) run -m unittest discover -s tests/plugins -p 'test_*.py'
	@$(PLUGIN_COVERAGE) run --append scripts/plugins/boxlite.py check
	@$(PLUGIN_COVERAGE) run --append scripts/plugins/boxlite.py dist
	@$(PLUGIN_COVERAGE) xml -o target/coverage/plugins/coverage.xml
	@$(PLUGIN_COVERAGE) report -m
