# Cloud MCP and local-runtime plugin distribution; no runtime build is required.
PLUGIN_COVERAGE_PYTHON ?= $(PLUGIN_PYTHON)
PLUGIN_REVIEW_CHECKLIST ?= scripts/plugins/review/checklist.json
PLUGIN_LOCAL_CLI ?= $(CURDIR)/target/plugins/tools/boxlite
PLUGIN_COVERAGE = PYTHONDONTWRITEBYTECODE=1 COVERAGE_FILE=target/coverage/plugins/.coverage COVERAGE_RCFILE=scripts/plugins/.coveragerc $(PLUGIN_COVERAGE_PYTHON) -m coverage


plugin\:boxlite\:check: plugin-boxlite-force
	@$(PLUGIN_PYTHON) scripts/plugins/boxlite.py check
	@$(MAKE) --no-print-directory test:unit:plugins

plugin\:boxlite\:submission: plugin-boxlite-force plugin\:boxlite\:check
	@$(PLUGIN_PYTHON) scripts/plugins/boxlite.py submission

plugin\:boxlite\:dist: plugin-boxlite-force plugin\:boxlite\:check
	@$(PLUGIN_PYTHON) scripts/plugins/boxlite.py dist

plugin\:boxlite\:check\:cc: plugin-boxlite-force plugin\:boxlite\:dist
	@claude plugin validate --strict plugins/boxlite-claude
	@claude plugin validate --strict target/plugins/boxlite-marketplace
plugin\:boxlite\:coverage: plugin-boxlite-force
	@mkdir -p target/coverage/plugins
	@$(PLUGIN_COVERAGE) run -m unittest discover -s tests/plugins -p 'test_*.py'
	@$(PLUGIN_COVERAGE) run --append scripts/plugins/boxlite.py check
	@$(PLUGIN_COVERAGE) run --append scripts/plugins/boxlite.py dist
	@$(PLUGIN_COVERAGE) xml -o target/coverage/plugins/coverage.xml
	@$(PLUGIN_COVERAGE) report -m

plugin\:boxlite\:smoke\:cloud: plugin-boxlite-force
	@$(PLUGIN_PYTHON) scripts/plugins/cloud_acceptance.py

plugin\:boxlite\:smoke\:local: plugin-boxlite-force
	@$(PLUGIN_PYTHON) scripts/plugins/local_acceptance.py --cli "$(PLUGIN_LOCAL_CLI)"

plugin\:boxlite\:preflight\:oauth: plugin-boxlite-force
	@$(PLUGIN_PYTHON) scripts/plugins/oauth_preflight.py

plugin\:boxlite\:review-kit: plugin-boxlite-force plugin\:boxlite\:check
	@$(PLUGIN_PYTHON) scripts/plugins/release.py kit

plugin\:boxlite\:ready: plugin-boxlite-force
	@$(PLUGIN_PYTHON) scripts/plugins/release.py ready --checklist "$(PLUGIN_REVIEW_CHECKLIST)"
