# Shared make variables
SHELL := /bin/bash
export PATH := $(HOME)/.cargo/bin:$(PATH)

# Vendored libkrun builds a Linux init binary as part of every krun-enabled
# macOS Cargo build. Export its cross compiler before Cargo starts resolving
# the dependency graph.
ifeq ($(shell uname),Darwin)
LIBKRUN_LINUX_ARCH := $(shell uname -m | sed 's/^arm64$$/aarch64/; s/^amd64$$/x86_64/')
CC_LINUX ?= $(if $(BOXLITE_LIBKRUN_CC_LINUX),$(BOXLITE_LIBKRUN_CC_LINUX),$(LIBKRUN_LINUX_ARCH)-linux-musl-gcc)
export CC_LINUX
endif

PROJECT_ROOT := $(shell pwd)
SCRIPT_DIR := $(PROJECT_ROOT)/scripts
export PREK_VERSION ?= 0.3.3

PHONY_TARGETS :=
