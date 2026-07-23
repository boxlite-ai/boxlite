# Shared make variables
SHELL := /bin/bash
export PATH := $(HOME)/.cargo/bin:$(PATH)

PROJECT_ROOT := $(shell pwd)
SCRIPT_DIR := $(PROJECT_ROOT)/scripts
export PREK_VERSION ?= 0.3.3

PHONY_TARGETS :=
