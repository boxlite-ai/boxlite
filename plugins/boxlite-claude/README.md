# BoxLite

Create and run isolated Linux sandboxes from Codex or Claude Code. Choose a mode when you set up the plugin.

| Mode | What you need |
| --- | --- |
| Cloud OAuth | A BoxLite account and browser authorization through your host. |
| Cloud API key | A BoxLite API key configured privately in your host. |
| Local | A BoxLite CLI on the execution host, Python 3.9+, and working virtualization. |

For installation and connection checks, follow the [setup guide](skills/boxlite-setup/SKILL.md).
Once setup succeeds, use the [Box operations guide](skills/boxlite/SKILL.md) to run commands and transfer files in the selected mode.

## Cloud file transfers

BoxLite runs Python on your computer to package uploads and unpack downloads. Directory uploads include hidden files.
Both hosts transfer file data through the BoxLite MCP connection you select.

Codex applies its shell-command permissions when it launches the bundled transfer helper.
Claude Code applies its tool permissions to each upload or download call and its arguments, including the connection, Box ID, and paths.
