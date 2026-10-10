# Skills-only BoxLite distribution; no runtime build is required.
PHONY_TARGETS += plugin-boxlite-force
PLUGIN_COVERAGE_PYTHON ?= python3
PLUGIN_COVERAGE = PYTHONDONTWRITEBYTECODE=1 COVERAGE_FILE=target/coverage/plugins/.coverage COVERAGE_RCFILE=scripts/plugins/.coveragerc $(PLUGIN_COVERAGE_PYTHON) -m coverage
plugin-boxlite-force:

plugin\:boxlite\:check: plugin-boxlite-force
	@python3 scripts/plugins/boxlite.py check
	@PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests/plugins -p 'test_*.py'

plugin\:boxlite\:dist: plugin-boxlite-force plugin\:boxlite\:check
	@python3 scripts/plugins/boxlite.py dist

plugin\:boxlite\:coverage: plugin-boxlite-force
	@mkdir -p target/coverage/plugins
	@$(PLUGIN_COVERAGE) run -m unittest discover -s tests/plugins -p 'test_*.py'
	@$(PLUGIN_COVERAGE) run --append scripts/plugins/boxlite.py check
	@$(PLUGIN_COVERAGE) run --append scripts/plugins/boxlite.py dist
	@$(PLUGIN_COVERAGE) xml -o target/coverage/plugins/coverage.xml
	@$(PLUGIN_COVERAGE) report -m
