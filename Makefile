include make/vars.mk
include make/help.mk
include make/clean.mk
include make/setup.mk
include make/build.mk
include make/dist.mk
include make/dev.mk
include make/changes.mk
include make/test.mk
include make/coverage.mk
include make/quality.mk

.DEFAULT_GOAL := help

.PHONY: $(PHONY_TARGETS)

# Workaround for macOS Make 3.81 which bifurcates \: targets into two entries:
# one with backslash (gets .PHONY but no recipe) and one without (gets recipe).
# By NOT marking colon targets as .PHONY, the backslash versions have no recipe,
# no file, and are not phony — so .DEFAULT fires and re-invokes with the clean name.
.DEFAULT:
	@case "$@" in \
	  *\\*) $(MAKE) --no-print-directory $$(echo "$@" | tr -d '\\') ;; \
	  *) echo "make: *** No rule to make target '$@'. Stop." >&2; exit 2 ;; \
	esac
