# Make guidance

## Target design

- Prefer existing targets and options, e.g.
  `make test:unit:vmm FILTER='test_name'`. Add only reusable workflows to the
  appropriate `.mk`; no targets for individual tests or PRs.
- Keep recipes to tool/script calls; put complex shell logic in `scripts/`.
  Follow `runtime` in [build.mk](build.mk). Preserve setup prerequisites.

## Style

- Start recipe lines with a tab. Separate targets with a blank line.
- Use lowercase target names and the existing colon hierarchy; escape colons
  in definitions, e.g. `test\:unit\:vmm:`. Use `UPPER_SNAKE_CASE` Make variables.
- Use `:=` for immediate values, `?=` for overridable defaults, `+=` to append,
  and `=` when expansion must be deferred. Preserve existing expansion timing.
- Use `$(NAME)` for Make variables and `$$name` for shell variables in recipes.
  Use `&&` between dependent commands and `\` continuations for shared shell state.
- Use `$(MAKE)` for recursive calls. Preserve the root [Makefile](../Makefile)'s
  macOS Make 3.81 compatibility and `.PHONY`/`.DEFAULT` handling.

## Verification

- Update [help.mk](help.mk) when public commands change.
- After recipe changes, run `make help` and the affected target.
