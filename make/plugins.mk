# Skills-only BoxLite distribution; no runtime build is required.
PHONY_TARGETS += plugin-boxlite-force
plugin-boxlite-force:

plugin\:boxlite\:check: plugin-boxlite-force
	@python3 scripts/plugins/boxlite.py check
	@PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests/plugins -p 'test_*.py'

plugin\:boxlite\:dist: plugin-boxlite-force plugin\:boxlite\:check
	@python3 scripts/plugins/boxlite.py dist
