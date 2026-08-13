# Stable Pulumi launchers

These two paths are persisted in Pulumi `command.local.Command` inputs. Keep
their command strings stable so an organizational refactor cannot re-run Runner
registration or binary upgrades. All implementation code lives in `runner/`.
