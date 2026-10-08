# Skills-only BoxLite distribution; no runtime build is required.
plugin\:boxlite\:check:
	@python3 scripts/plugins/boxlite.py check
	@PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests/plugins -p 'test_*.py'

plugin\:boxlite\:dist: plugin\:boxlite\:check
	@python3 scripts/plugins/boxlite.py dist

plugin\:boxlite\:check\:cc: plugin\:boxlite\:dist
	@claude plugin validate --strict plugins/boxlite
	@claude plugin validate --strict target/plugins/boxlite-marketplace
