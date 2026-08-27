#!/usr/bin/env bash
# Trusted Claude Code SessionStart bootstrap for a consumer repository.
#
# Project settings can declare an external plugin, but Claude Code deliberately does
# not install it from that declaration alone. This trusted hook bridges the gap once:
# adopt the shared tooling, validate or add the canonical marketplace, and install a
# project-scoped plugin. Claude must reload its plugin registry afterward. Because a
# SessionStart failure cannot block Claude's first prompt, this script records a
# per-session result that the companion UserPromptSubmit hook checks with --check.
set -uo pipefail

mode="${1:-bootstrap}"
case "$mode" in
  bootstrap|--check) ;;
  *) printf 'agent-tooling: unknown Claude bootstrap mode: %s\n' "$mode" >&2; exit 2 ;;
esac

fail_without_state() {
  printf 'agent-tooling: %s\n' "$1" >&2
  [[ "$mode" == "--check" ]] && exit 2
  exit 1
}

project_dir="${CLAUDE_PROJECT_DIR:-$PWD}"
repo_root="$(git -C "$project_dir" rev-parse --show-toplevel 2>/dev/null)" \
  || fail_without_state "run inside a Git repository"
command -v jq >/dev/null 2>&1 || fail_without_state "jq is required"
hook_input="$(cat)"
session_id="$(jq -er '.session_id | select(type == "string" and length > 0)' <<< "$hook_input" 2>/dev/null)" \
  || fail_without_state "hook input must contain a session_id"
[[ "$session_id" =~ ^[A-Za-z0-9._-]{1,128}$ ]] \
  || fail_without_state "hook input contains an unsafe session_id"
hook_event_name="$(jq -er '.hook_event_name | select(type == "string" and length > 0)' <<< "$hook_input" 2>/dev/null)" \
  || fail_without_state "hook input must contain a hook_event_name"
if [[ "$mode" == "--check" ]]; then
  [[ "$hook_event_name" == "UserPromptSubmit" ]] \
    || fail_without_state "expected UserPromptSubmit hook input, got $hook_event_name"
else
  [[ "$hook_event_name" == "SessionStart" ]] \
    || fail_without_state "expected SessionStart hook input, got $hook_event_name"
fi

state_dir="$(git -C "$repo_root" rev-parse --git-path agent-tooling/claude-bootstrap 2>/dev/null)" \
  || fail_without_state "could not resolve the Claude bootstrap state directory"
[[ "$state_dir" == /* ]] || state_dir="$repo_root/$state_dir"
mkdir -p "$state_dir" \
  || fail_without_state "could not create the Claude bootstrap state directory: $state_dir"
success_file="$state_dir/$session_id.ok"
failure_file="$state_dir/$session_id.error"

if [[ "$mode" == "--check" ]]; then
  [[ -w "$state_dir" ]] || {
    printf 'agent-tooling: Claude bootstrap state is not writable: %s\n' "$state_dir" >&2
    exit 2
  }
  if [[ -s "$failure_file" ]]; then
    cat "$failure_file" >&2
    exit 2
  fi
  [[ -s "$success_file" ]] || {
    printf 'agent-tooling: Claude bootstrap did not complete for session %s\n' "$session_id" >&2
    exit 2
  }
  exit 0
fi

write_failure() {
  local detail="$1" temporary="$failure_file.$$"
  if ! rm -f -- "$success_file"; then
    printf 'agent-tooling: could not clear stale Claude bootstrap success: %s\n' "$success_file" >&2
    return 1
  fi
  if printf 'agent-tooling: %s\n' "$detail" > "$temporary" && mv "$temporary" "$failure_file"; then
    return 0
  fi
  rm -f -- "$temporary"
  printf 'agent-tooling: could not record Claude bootstrap failure: %s\n' "$failure_file" >&2
  return 1
}

hook_fail() {
  local detail="$1"
  write_failure "$detail" || true
  printf 'agent-tooling: %s\n' "$detail" >&2
  exit 1
}

write_failure "Claude bootstrap did not complete for session $session_id" \
  || fail_without_state "could not initialize Claude bootstrap state"

profile_file="$repo_root/.agent-tooling/profile.json"
installer="$repo_root/.agent-tooling/install.sh"
settings_file="$repo_root/.claude/settings.json"

[[ -r "$profile_file" ]] || hook_fail "missing profile manifest: $profile_file"
[[ -x "$installer" ]] || hook_fail "missing executable consumer installer: $installer"
[[ -r "$settings_file" ]] || hook_fail "missing Claude project settings: $settings_file"
command -v claude >/dev/null 2>&1 || hook_fail "Claude Code CLI is required"

tooling_repo="$(jq -er '.tooling.repository | select(type == "string" and length > 0)' "$profile_file" 2>/dev/null)" \
  || hook_fail "tooling.repository is required in $profile_file"
[[ "$tooling_repo" == "boxlite-ai/agent-tooling" ]] \
  || hook_fail "unsupported tooling repository: $tooling_repo"
tooling_ref="$(jq -er '.tooling.ref | select(type == "string" and length > 0)' "$profile_file" 2>/dev/null)" \
  || hook_fail "tooling.ref must name the branch to float on in $profile_file"
[[ ! "$tooling_ref" =~ ^[0-9a-f]{40}$ ]] \
  || hook_fail "tooling.ref names a branch; freeze a revision in .agent-tooling/hold"
if [[ "$tooling_ref" == -* ]] || ! git check-ref-format "refs/heads/$tooling_ref" >/dev/null 2>&1; then
  hook_fail "tooling.ref is not a valid branch name: $tooling_ref"
fi

jq -e --arg ref "$tooling_ref" '
  .extraKnownMarketplaces["boxlite-agent-tooling"].source.source == "github" and
  .extraKnownMarketplaces["boxlite-agent-tooling"].source.repo == "boxlite-ai/agent-tooling" and
  .extraKnownMarketplaces["boxlite-agent-tooling"].source.ref == $ref and
  .enabledPlugins["boxlite-agent-tooling@boxlite-agent-tooling"] == true
' "$settings_file" >/dev/null 2>&1 \
  || hook_fail "Claude project settings must enable boxlite-agent-tooling from the typed GitHub source at tooling.ref $tooling_ref: $settings_file"

git_common_dir() {
  local root="$1" common
  common="$(git -C "$root" rev-parse --git-common-dir 2>/dev/null)" || return 1
  if [[ "$common" != /* ]]; then
    common="$root/$common"
  fi
  (cd "$common" 2>/dev/null && pwd -P)
}

repo_common_dir="$(git_common_dir "$repo_root")" \
  || hook_fail "could not resolve the repository's common Git directory"
canonical_repo_root="$(cd "$repo_root" 2>/dev/null && pwd -P)" \
  || hook_fail "could not resolve the repository's canonical worktree root"

tooling_install_is_valid() {
  local record verify
  record="$(head -n1 "$repo_common_dir/agent-tooling/current" 2>/dev/null || true)"
  [[ "$record" =~ ^[0-9a-f]{40}$ ]] || return 1
  verify="$repo_common_dir/agent-tooling/$record/plugins/boxlite-agent-tooling/scripts/verify-installation.sh"
  [[ -x "$verify" ]] || return 1
  "$verify" "$repo_root" >/dev/null 2>&1
}

if ! tooling_install_is_valid; then
  install_output="$(cd "$repo_root" && AGENT_TOOLING_SYNC_ACTIVE=1 /usr/bin/env bash "$installer" 2>&1)"
  install_status="$?"
  if [[ "$install_status" != 0 ]]; then
    [[ -z "$install_output" ]] || printf '%s\n' "$install_output" >&2
    hook_fail "automatic tooling installation failed"
  fi
  tooling_install_is_valid \
    || hook_fail "automatic tooling installation did not produce a valid local installation"
fi

read_expected_plugin_version() {
  adopted_tooling_revision="$(head -n1 "$repo_common_dir/agent-tooling/current" 2>/dev/null || true)"
  [[ "$adopted_tooling_revision" =~ ^[0-9a-f]{40}$ ]] \
    || hook_fail "adopted tooling revision is invalid after verification"
  expected_plugin_manifest="$repo_common_dir/agent-tooling/$adopted_tooling_revision/plugins/boxlite-agent-tooling/.claude-plugin/plugin.json"
  expected_plugin_version="$(jq -er '
    select(.name == "boxlite-agent-tooling") |
    .version | select(type == "string" and length > 0)
  ' "$expected_plugin_manifest" 2>/dev/null)" \
    || hook_fail "adopted tooling has no valid Claude plugin version: $expected_plugin_manifest"
}

refresh_adopted_tooling() {
  local output status
  output="$(cd "$repo_root" && AGENT_TOOLING_SYNC_ACTIVE=1 /usr/bin/env bash "$installer" 2>&1)"
  status="$?"
  if [[ "$status" != 0 ]]; then
    [[ -z "$output" ]] || printf '%s\n' "$output" >&2
    hook_fail "could not refresh adopted tooling before plugin reconciliation"
  fi
  tooling_install_is_valid \
    || hook_fail "tooling refresh did not produce a valid local installation"
  read_expected_plugin_version
}

read_expected_plugin_version

hold_file="$repo_root/.agent-tooling/hold"
hold_sha=""
if [[ -e "$hold_file" ]]; then
  hold_sha="$(tr -d '\n' < "$hold_file")"
  { [[ "$hold_sha" =~ ^[0-9a-f]{40}$ ]] && [[ "$(wc -c < "$hold_file")" -le 41 ]]; } \
    || hook_fail "$hold_file must contain exactly one full lowercase commit SHA"
  [[ "$hold_sha" == "$adopted_tooling_revision" ]] \
    || hook_fail "hold $hold_sha is not the adopted tooling revision $adopted_tooling_revision"
fi

read_marketplaces() {
  local output status
  output="$(claude plugin marketplace list --json 2>&1)"
  status="$?"
  if [[ "$status" != 0 ]]; then
    [[ -z "$output" ]] || printf '%s\n' "$output" >&2
    hook_fail "could not list Claude marketplaces"
  fi
  jq -e 'type == "array"' <<< "$output" >/dev/null 2>&1 \
    || hook_fail "Claude returned an invalid marketplace list"
  marketplace_list="$output"
}

canonical_marketplace_count() {
  jq -r '[.[] | select(
    .name == "boxlite-agent-tooling" and
    .source == "github" and
    .repo == "boxlite-ai/agent-tooling" and
    .ref == $ref
  )] | length' --arg ref "$tooling_ref" <<< "$1"
}

named_marketplace_count() {
  jq -r '[.[] | select(.name == "boxlite-agent-tooling")] | length' <<< "$1"
}

changed=0
read_marketplaces
marketplaces="$marketplace_list"
named_count="$(named_marketplace_count "$marketplaces")"
canonical_count="$(canonical_marketplace_count "$marketplaces")"
if [[ "$named_count" == 0 ]]; then
  [[ -z "$hold_sha" ]] \
    || hook_fail "hold $hold_sha prevents resolving a missing Claude marketplace"
  marketplace_output="$(claude plugin marketplace add "$tooling_repo@$tooling_ref" --scope project 2>&1)"
  marketplace_status="$?"
  if [[ "$marketplace_status" != 0 ]]; then
    [[ -z "$marketplace_output" ]] || printf '%s\n' "$marketplace_output" >&2
    hook_fail "could not add Claude marketplace $tooling_repo at $tooling_ref"
  fi
  changed=1
elif [[ "$named_count" != 1 || "$canonical_count" != 1 ]]; then
  hook_fail "configured Claude marketplace source does not match github:$tooling_repo@$tooling_ref"
fi

# Adding a marketplace can succeed while a managed policy rewrites or rejects its
# source. Re-read the public state before the plugin install; never use add itself as
# a validation probe because Claude permits replacing a same-name source.
read_marketplaces
marketplaces="$marketplace_list"
named_count="$(named_marketplace_count "$marketplaces")"
canonical_count="$(canonical_marketplace_count "$marketplaces")"
[[ "$named_count" == 1 && "$canonical_count" == 1 ]] \
  || hook_fail "Claude marketplace is not canonical after configuration: github:$tooling_repo@$tooling_ref"

read_plugins() {
  local output status
  output="$(claude plugin list --json 2>&1)"
  status="$?"
  if [[ "$status" != 0 ]]; then
    [[ -z "$output" ]] || printf '%s\n' "$output" >&2
    hook_fail "could not list installed Claude plugins"
  fi
  jq -e 'type == "array"' <<< "$output" >/dev/null 2>&1 \
    || hook_fail "Claude returned an invalid plugin list"
  plugin_list="$output"
}

same_project_path() {
  local candidate="$1" canonical_candidate
  [[ -d "$candidate" ]] || return 1
  canonical_candidate="$(cd "$candidate" 2>/dev/null && pwd -P)" || return 1
  [[ "$canonical_candidate" == "$canonical_repo_root" ]]
}

count_applicable_plugins() {
  local plugin_json="$1" record candidate enabled version
  applicable_plugin_count=0
  applicable_plugin_enabled=""
  applicable_plugin_version=""
  while IFS= read -r record; do
    [[ -n "$record" ]] || continue
    candidate="$(jq -er '.projectPath | select(type == "string" and length > 0)' <<< "$record" 2>/dev/null)" \
      || continue
    same_project_path "$candidate" || continue
    jq -e '(.enabled | type) == "boolean"' <<< "$record" >/dev/null 2>&1 \
      || hook_fail "Claude reported an installed boxlite-agent-tooling plugin without a boolean enabled state"
    enabled="$(jq -r '.enabled' <<< "$record")"
    version="$(jq -er '.version | select(type == "string" and length > 0)' <<< "$record" 2>/dev/null)" \
      || hook_fail "Claude reported an installed boxlite-agent-tooling plugin without a usable version"
    applicable_plugin_count=$((applicable_plugin_count + 1))
    applicable_plugin_enabled="$enabled"
    applicable_plugin_version="$version"
  done < <(jq -c '.[] | select(
    .id == "boxlite-agent-tooling@boxlite-agent-tooling" and .scope == "project"
  )' <<< "$plugin_json")
}

read_plugins
plugins="$plugin_list"
count_applicable_plugins "$plugins"
if [[ "$applicable_plugin_count" == 0 ]]; then
  [[ -z "$hold_sha" ]] \
    || hook_fail "hold $hold_sha prevents installing a missing Claude project plugin"
  plugin_output="$(claude plugin install boxlite-agent-tooling@boxlite-agent-tooling --scope project --yes 2>&1)"
  plugin_status="$?"
  if [[ "$plugin_status" != 0 ]]; then
    [[ -z "$plugin_output" ]] || printf '%s\n' "$plugin_output" >&2
    hook_fail "could not install Claude plugin boxlite-agent-tooling@boxlite-agent-tooling"
  fi
  changed=1
  read_plugins
  plugins="$plugin_list"
  count_applicable_plugins "$plugins"
  [[ "$applicable_plugin_count" == 1 ]] \
    || hook_fail "Claude did not report boxlite-agent-tooling as installed for $repo_root"
elif [[ "$applicable_plugin_count" != 1 ]]; then
  hook_fail "Claude reported ambiguous boxlite-agent-tooling project installations for $repo_root"
fi

if [[ "$applicable_plugin_version" != "$expected_plugin_version" ]]; then
  [[ -z "$hold_sha" ]] \
    || hook_fail "Claude plugin version $applicable_plugin_version does not match held tooling version $expected_plugin_version; remove hold to reconcile"
  refresh_adopted_tooling
fi

if [[ "$applicable_plugin_version" != "$expected_plugin_version" ]]; then
  enabled_before="$applicable_plugin_enabled"

  marketplace_output="$(CLAUDE_CODE_PLUGIN_KEEP_MARKETPLACE_ON_FAILURE=1 \
    claude plugin marketplace update boxlite-agent-tooling 2>&1)"
  marketplace_status="$?"
  if [[ "$marketplace_status" != 0 ]]; then
    [[ -z "$marketplace_output" ]] || printf '%s\n' "$marketplace_output" >&2
    hook_fail "could not update Claude marketplace boxlite-agent-tooling"
  fi

  plugin_output="$(claude plugin update boxlite-agent-tooling@boxlite-agent-tooling --scope project --yes 2>&1)"
  plugin_status="$?"
  if [[ "$plugin_status" != 0 ]]; then
    [[ -z "$plugin_output" ]] || printf '%s\n' "$plugin_output" >&2
    hook_fail "could not update Claude plugin boxlite-agent-tooling@boxlite-agent-tooling"
  fi

  read_plugins
  plugins="$plugin_list"
  count_applicable_plugins "$plugins"
  [[ "$applicable_plugin_count" == 1 ]] \
    || hook_fail "Claude did not report one boxlite-agent-tooling installation after update for $repo_root"
  [[ "$applicable_plugin_version" == "$expected_plugin_version" ]] \
    || hook_fail "Claude plugin stayed at $applicable_plugin_version after update; expected $expected_plugin_version"
  [[ "$applicable_plugin_enabled" == "$enabled_before" ]] \
    || hook_fail "Claude plugin update changed the enabled state"
  changed=1
fi

# An enabled=false record is intentionally accepted. A local setting can disable a
# project installation, and automatic bootstrap must not override that choice.
success_temporary="$success_file.$$"
if ! printf '%s\n' "$(date +%s)" > "$success_temporary" || \
   ! mv "$success_temporary" "$success_file" || \
   ! rm -f -- "$failure_file"; then
  rm -f -- "$success_temporary"
  hook_fail "could not record a successful Claude bootstrap: $success_file"
fi

if [[ "$changed" == 1 ]]; then
  jq -nc --arg message \
    'BoxLite agent tooling was installed or updated. Run /reload-plugins to load its agents and hooks in this session, or start a new Claude Code session.' \
    '{systemMessage: $message, hookSpecificOutput: {hookEventName: "SessionStart", reloadSkills: true}}'
fi
