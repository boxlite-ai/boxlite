# Detect changed components by diffing against main (or HEAD~1 if on main).
# Returns a space-separated list of component tags: rust cli ffi python node c
define detect_changes
$(shell \
  BRANCH=$$(git rev-parse --abbrev-ref HEAD 2>/dev/null); \
  if [ "$$BRANCH" = "main" ] || [ "$$BRANCH" = "master" ]; then \
    BASE=HEAD~1; \
  else \
    BASE=$$(git merge-base HEAD main 2>/dev/null || git merge-base HEAD master 2>/dev/null || echo HEAD~1); \
  fi; \
  CHANGED=$$(git diff --name-only $$BASE HEAD 2>/dev/null; git diff --name-only 2>/dev/null; git diff --cached --name-only 2>/dev/null); \
  if [ -z "$$CHANGED" ]; then exit 0; fi; \
  echo "$$CHANGED" | grep -q '^boxlite/' && printf 'rust '; \
  echo "$$CHANGED" | grep -q '^boxlite-shared/' && printf 'rust '; \
  echo "$$CHANGED" | grep -q '^guest/' && printf 'rust '; \
  echo "$$CHANGED" | grep -q '^boxlite-cli/' && printf 'cli '; \
  echo "$$CHANGED" | grep -q '^ffi/' && printf 'ffi '; \
  echo "$$CHANGED" | grep -q '^sdks/python/' && printf 'python '; \
  echo "$$CHANGED" | grep -q '^sdks/node/' && printf 'node '; \
  echo "$$CHANGED" | grep -q '^sdks/c/' && printf 'c '; \
  echo "$$CHANGED" | grep -q 'Cargo\.toml$$' && printf 'rust cli ffi '; \
  echo "$$CHANGED" | grep -q '^Cargo\.lock$$' && printf 'rust cli ffi '; \
)
endef

CHANGED_COMPONENTS := $(sort $(detect_changes))

# Map test components to format/lint surfaces.
# cli/ffi don't need separate formatters — cargo fmt --all and clippy --workspace cover them.
FMT_COMPONENTS := $(sort $(subst cli,rust,$(subst ffi,rust,$(CHANGED_COMPONENTS))))
