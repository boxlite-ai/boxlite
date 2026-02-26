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
