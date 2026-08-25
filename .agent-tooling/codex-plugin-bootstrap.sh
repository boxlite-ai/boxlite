#!/usr/bin/env bash
# Trusted Codex SessionStart bootstrap for a consumer repository.
#
# The committed consumer installer adopts and validates shared tooling first. Codex
# then registers one canonical Git marketplace for the whole machine and installs the
# plugin once. A canonical source is essential: local clone paths conflict because
# Codex keys configured marketplaces globally by their manifest name.
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[[ -n "$repo_root" ]] || { printf 'agent-tooling: run inside a Git repository\n' >&2; exit 2; }
profile_file="$repo_root/.agent-tooling/profile.json"
installer="$repo_root/.agent-tooling/install.sh"
marketplace_file="$repo_root/.agents/plugins/marketplace.json"
[[ -r "$profile_file" ]] || { printf 'agent-tooling: missing %s\n' "$profile_file" >&2; exit 1; }
[[ -r "$installer" ]] || { printf 'agent-tooling: missing %s\n' "$installer" >&2; exit 1; }
[[ -r "$marketplace_file" ]] || { printf 'agent-tooling: missing %s\n' "$marketplace_file" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { printf 'agent-tooling: jq is required\n' >&2; exit 1; }
command -v codex >/dev/null 2>&1 || { printf 'agent-tooling: Codex CLI is required\n' >&2; exit 1; }

tooling_repo="$(jq -er '.tooling.repository | select(type == "string" and length > 0)' "$profile_file")" || {
  printf 'agent-tooling: tooling.repository is required\n' >&2
  exit 1
}
[[ "$tooling_repo" == "boxlite-ai/agent-tooling" ]] || {
  printf 'agent-tooling: unsupported tooling repository: %s\n' "$tooling_repo" >&2
  exit 1
}
tooling_ref="$(jq -er '.tooling.ref | select(type == "string" and length > 0)' "$profile_file")" || {
  printf 'agent-tooling: tooling.ref must name the branch to float on\n' >&2
  exit 1
}
[[ ! "$tooling_ref" =~ ^[0-9a-f]{40}$ ]] || {
  printf 'agent-tooling: tooling.ref names a branch; to freeze a revision write it to .agent-tooling/hold\n' >&2
  exit 1
}
if [[ "$tooling_ref" == -* ]] || ! git check-ref-format "refs/heads/$tooling_ref" >/dev/null 2>&1; then
  printf 'agent-tooling: tooling.ref is not a valid branch name: %s\n' "$tooling_ref" >&2
  exit 1
fi

validate_codex_marketplace_file() {
  local file="$1"
  [[ -r "$file" ]] || return 1
  jq -e --arg ref "$tooling_ref" '
    .name == "boxlite-agent-tooling" and
    any(.plugins[];
      .name == "boxlite-agent-tooling" and
      .source.source == "git-subdir" and
      .source.url == "https://github.com/boxlite-ai/agent-tooling.git" and
      .source.ref == $ref and
      .source.path == "./plugins/boxlite-agent-tooling" and
      .policy.installation == "INSTALLED_BY_DEFAULT" and
      .policy.authentication == "ON_INSTALL" and
      .category == "Developer Tools")
  ' "$file" >/dev/null 2>&1
}

validate_codex_marketplace_file "$marketplace_file" || {
  printf 'agent-tooling: invalid Codex marketplace for tooling.ref %s: %s\n' "$tooling_ref" "$marketplace_file" >&2
  exit 1
}

tooling_install_is_valid() {
  local common_git_dir record verify
  common_git_dir="$(git -C "$repo_root" rev-parse --git-common-dir)"
  [[ "$common_git_dir" == /* ]] || common_git_dir="$repo_root/$common_git_dir"
  record="$(head -n1 "$common_git_dir/agent-tooling/current" 2>/dev/null || true)"
  [[ "$record" =~ ^[0-9a-f]{40}$ ]] || return 1
  verify="$common_git_dir/agent-tooling/$record/plugins/boxlite-agent-tooling/scripts/verify-installation.sh"
  [[ -x "$verify" ]] || return 1
  "$verify" "$repo_root" >/dev/null 2>&1
}

if ! tooling_install_is_valid; then
  install_output=""
  if install_output="$(cd "$repo_root" && AGENT_TOOLING_SYNC_ACTIVE=1 /usr/bin/env bash "$installer" 2>&1)"; then
    :
  else
    status="$?"
    [[ -z "$install_output" ]] || printf '%s\n' "$install_output" >&2
    printf 'agent-tooling: automatic tooling installation failed\n' >&2
    exit "$status"
  fi
  tooling_install_is_valid || {
    printf 'agent-tooling: automatic tooling installation did not produce a valid local installation\n' >&2
    exit 1
  }
fi

common_git_dir="$(git -C "$repo_root" rev-parse --git-common-dir)"
[[ "$common_git_dir" == /* ]] || common_git_dir="$repo_root/$common_git_dir"
read_expected_plugin_version() {
  adopted_tooling_revision="$(head -n1 "$common_git_dir/agent-tooling/current" 2>/dev/null || true)"
  [[ "$adopted_tooling_revision" =~ ^[0-9a-f]{40}$ ]] || {
    printf 'agent-tooling: adopted tooling revision is invalid after verification\n' >&2
    return 1
  }
  expected_plugin_manifest="$common_git_dir/agent-tooling/$adopted_tooling_revision/plugins/boxlite-agent-tooling/.codex-plugin/plugin.json"
  expected_plugin_version="$(jq -er '
    select(.name == "boxlite-agent-tooling") |
    .version | select(type == "string" and length > 0)
  ' "$expected_plugin_manifest" 2>/dev/null)" || {
    printf 'agent-tooling: adopted tooling has no valid Codex plugin version: %s\n' \
      "$expected_plugin_manifest" >&2
    return 1
  }
}

refresh_adopted_tooling() {
  local output status
  output="$(cd "$repo_root" && AGENT_TOOLING_SYNC_ACTIVE=1 /usr/bin/env bash "$installer" 2>&1)"
  status="$?"
  if [[ "$status" != 0 ]]; then
    [[ -z "$output" ]] || printf '%s\n' "$output" >&2
    printf 'agent-tooling: could not refresh adopted tooling before plugin reconciliation\n' >&2
    return "$status"
  fi
  tooling_install_is_valid || {
    printf 'agent-tooling: tooling refresh did not produce a valid local installation\n' >&2
    return 1
  }
  read_expected_plugin_version
}

read_expected_plugin_version || exit 1

hold_file="$repo_root/.agent-tooling/hold"
hold_sha=""
if [[ -e "$hold_file" ]]; then
  hold_sha="$(tr -d '\n' < "$hold_file")"
  { [[ "$hold_sha" =~ ^[0-9a-f]{40}$ ]] && [[ "$(wc -c < "$hold_file")" -le 41 ]]; } || {
    printf 'agent-tooling: %s must contain exactly one full lowercase commit SHA\n' "$hold_file" >&2
    exit 1
  }
  [[ "$hold_sha" == "$adopted_tooling_revision" ]] || {
    printf 'agent-tooling: hold %s is not the adopted tooling revision %s\n' \
      "$hold_sha" "$adopted_tooling_revision" >&2
    exit 1
  }
fi

codex_plugin_catalog() {
  local catalog
  if ! catalog="$(codex plugin list --marketplace boxlite-agent-tooling --available --json)"; then
    printf 'agent-tooling: could not read the boxlite-agent-tooling Codex marketplace\n' >&2
    return 1
  fi
  jq -e '
    (.installed | type == "array") and
    (.available | type == "array") and
    ([(.installed[], .available[]) | select(
      .pluginId == "boxlite-agent-tooling@boxlite-agent-tooling" and
      .name == "boxlite-agent-tooling" and
      .marketplaceName == "boxlite-agent-tooling" and
      (.version | type == "string" and length > 0) and
      (.enabled | type == "boolean") and
      .installPolicy == "INSTALLED_BY_DEFAULT" and
      .authPolicy == "ON_INSTALL"
    )] | length == 1)
  ' <<< "$catalog" >/dev/null || {
    printf 'agent-tooling: Codex marketplace boxlite-agent-tooling does not advertise the expected plugin at ref %s\n' "$tooling_ref" >&2
    return 1
  }
  printf '%s' "$catalog"
}

marketplaces="$(codex plugin marketplace list --json)" || {
  printf 'agent-tooling: could not list Codex marketplaces\n' >&2
  exit 1
}
jq -e '.marketplaces | type == "array"' <<< "$marketplaces" >/dev/null || {
  printf 'agent-tooling: Codex returned an invalid marketplace list\n' >&2
  exit 1
}
marketplace_count="$(jq -r '[.marketplaces[] | select(.name == "boxlite-agent-tooling")] | length' <<< "$marketplaces")"
canonical_marketplace_url="https://github.com/$tooling_repo.git"
codex_marketplace_source_is_canonical() {
  local marketplace_list="$1"
  jq -e --arg source "$canonical_marketplace_url" '
    .marketplaces[] |
    select(.name == "boxlite-agent-tooling") |
    .marketplaceSource.sourceType == "git" and
    .marketplaceSource.source == $source
  ' <<< "$marketplace_list" >/dev/null
}

changed=0
case "$marketplace_count" in
  0)
    [[ -z "$hold_sha" ]] || {
      printf 'agent-tooling: hold %s prevents resolving a missing Codex marketplace\n' \
        "$hold_sha" >&2
      exit 1
    }
    if ! codex plugin marketplace add "$canonical_marketplace_url" --ref "$tooling_ref" --json >/dev/null; then
      printf 'agent-tooling: could not add Codex marketplace %s at %s\n' "$tooling_repo" "$tooling_ref" >&2
      exit 1
    fi
    changed=1
    ;;
  1)
    codex_marketplace_source_is_canonical "$marketplaces" || {
      printf 'agent-tooling: configured Codex marketplace source is not canonical Git: %s\n' \
        "$canonical_marketplace_url" >&2
      exit 1
    }
    # The list API omits the configured ref. Re-adding the exact source is Codex's
    # public idempotent check: it returns alreadyAdded for a match and fails otherwise.
    if ! codex plugin marketplace add "$canonical_marketplace_url" --ref "$tooling_ref" --json >/dev/null; then
      printf 'agent-tooling: Codex marketplace is not configured at tooling.ref %s\n' "$tooling_ref" >&2
      exit 1
    fi
    ;;
  *)
    printf 'agent-tooling: Codex has %s marketplaces named boxlite-agent-tooling; remove the conflict and retry\n' "$marketplace_count" >&2
    exit 1
    ;;
esac

# Installed plugins legitimately report their cache directory as a local source.
# Verify the configured marketplace root separately so that source transition cannot
# hide a same-name marketplace pointed at a different Git repository or branch.
marketplaces="$(codex plugin marketplace list --json)" || {
  printf 'agent-tooling: could not re-read Codex marketplaces after configuration\n' >&2
  exit 1
}
jq -e '.marketplaces | type == "array"' <<< "$marketplaces" >/dev/null || {
  printf 'agent-tooling: Codex returned an invalid marketplace list after configuration\n' >&2
  exit 1
}
marketplace_count="$(jq -r '[.marketplaces[] | select(.name == "boxlite-agent-tooling")] | length' <<< "$marketplaces")"
[[ "$marketplace_count" == 1 ]] || {
  printf 'agent-tooling: Codex marketplace boxlite-agent-tooling is ambiguous after configuration\n' >&2
  exit 1
}
codex_marketplace_source_is_canonical "$marketplaces" || {
  printf 'agent-tooling: configured Codex marketplace source is not canonical Git: %s\n' \
    "$canonical_marketplace_url" >&2
  exit 1
}
marketplace_root="$(jq -er '
  .marketplaces[] |
  select(.name == "boxlite-agent-tooling") |
  .root | select(type == "string" and length > 0)
' <<< "$marketplaces")" || {
  printf 'agent-tooling: configured Codex marketplace has no usable root\n' >&2
  exit 1
}
configured_marketplace_file="$marketplace_root/.agents/plugins/marketplace.json"
validate_codex_marketplace_file "$configured_marketplace_file" || {
  printf 'agent-tooling: configured Codex marketplace is invalid for tooling.ref %s: %s\n' \
    "$tooling_ref" "$configured_marketplace_file" >&2
  exit 1
}

catalog="$(codex_plugin_catalog)" || exit 1
installed_count="$(jq -r '[.installed[] | select(
  .pluginId == "boxlite-agent-tooling@boxlite-agent-tooling" and .installed == true
)] | length' <<< "$catalog")"
catalog_plugin_version="$(jq -er '(.installed[], .available[]) | select(
  .pluginId == "boxlite-agent-tooling@boxlite-agent-tooling"
) | .version' <<< "$catalog")" || {
  printf 'agent-tooling: Codex catalog has no usable boxlite-agent-tooling version\n' >&2
  exit 1
}

if [[ "$catalog_plugin_version" != "$expected_plugin_version" ]]; then
  [[ -z "$hold_sha" ]] || {
    printf 'agent-tooling: Codex plugin version %s does not match held tooling version %s; remove hold to reconcile\n' \
      "$catalog_plugin_version" "$expected_plugin_version" >&2
    exit 1
  }
  refresh_adopted_tooling || exit 1
fi

if [[ "$catalog_plugin_version" != "$expected_plugin_version" ]]; then
  installed_enabled_before=""
  if [[ "$installed_count" == 1 ]]; then
    jq -e 'any(.installed[]; select(
      .pluginId == "boxlite-agent-tooling@boxlite-agent-tooling" and .installed == true
    ) | (.enabled | type == "boolean"))' <<< "$catalog" >/dev/null || {
      printf 'agent-tooling: Codex installed plugin has no boolean enabled state\n' >&2
      exit 1
    }
    installed_enabled_before="$(jq -r '.installed[] | select(
      .pluginId == "boxlite-agent-tooling@boxlite-agent-tooling" and .installed == true
    ) | .enabled' <<< "$catalog")"
  fi

  if ! upgrade_output="$(codex plugin marketplace upgrade boxlite-agent-tooling --json)"; then
    printf 'agent-tooling: could not upgrade Codex marketplace boxlite-agent-tooling\n' >&2
    exit 1
  fi
  jq -e '
    (.selectedMarketplaces | type == "array") and
    (.selectedMarketplaces | index("boxlite-agent-tooling") != null) and
    (.upgradedRoots | type == "array") and
    (.errors | type == "array" and length == 0)
  ' <<< "$upgrade_output" >/dev/null 2>&1 || {
    printf 'agent-tooling: Codex marketplace upgrade returned an invalid result\n' >&2
    exit 1
  }

  catalog="$(codex_plugin_catalog)" || exit 1
  installed_count="$(jq -r '[.installed[] | select(
    .pluginId == "boxlite-agent-tooling@boxlite-agent-tooling" and .installed == true
  )] | length' <<< "$catalog")"
  catalog_plugin_version="$(jq -er '(.installed[], .available[]) | select(
    .pluginId == "boxlite-agent-tooling@boxlite-agent-tooling"
  ) | .version' <<< "$catalog")" || {
    printf 'agent-tooling: Codex catalog has no usable version after marketplace upgrade\n' >&2
    exit 1
  }
  [[ "$catalog_plugin_version" == "$expected_plugin_version" ]] || {
    printf 'agent-tooling: Codex plugin stayed at %s after upgrade; expected %s\n' \
      "$catalog_plugin_version" "$expected_plugin_version" >&2
    exit 1
  }
  if [[ -n "$installed_enabled_before" ]]; then
    [[ "$installed_count" == 1 ]] || {
      printf 'agent-tooling: Codex marketplace upgrade removed the installed plugin\n' >&2
      exit 1
    }
    jq -e 'any(.installed[]; select(
      .pluginId == "boxlite-agent-tooling@boxlite-agent-tooling" and .installed == true
    ) | (.enabled | type == "boolean"))' <<< "$catalog" >/dev/null || {
      printf 'agent-tooling: upgraded Codex plugin has no boolean enabled state\n' >&2
      exit 1
    }
    installed_enabled_after="$(jq -r '.installed[] | select(
      .pluginId == "boxlite-agent-tooling@boxlite-agent-tooling" and .installed == true
    ) | .enabled' <<< "$catalog")"
    [[ "$installed_enabled_after" == "$installed_enabled_before" ]] || {
      printf 'agent-tooling: Codex marketplace upgrade changed the plugin enabled state\n' >&2
      exit 1
    }
  fi
  changed=1
fi

if [[ "$installed_count" == 0 ]]; then
  [[ -z "$hold_sha" ]] || {
    printf 'agent-tooling: hold %s prevents installing a missing Codex plugin\n' \
      "$hold_sha" >&2
    exit 1
  }
  if ! codex plugin add boxlite-agent-tooling@boxlite-agent-tooling --json >/dev/null; then
    printf 'agent-tooling: could not install Codex plugin boxlite-agent-tooling@boxlite-agent-tooling\n' >&2
    exit 1
  fi
  changed=1
  catalog="$(codex_plugin_catalog)" || exit 1
  jq -e --arg version "$expected_plugin_version" 'any(.installed[];
    .pluginId == "boxlite-agent-tooling@boxlite-agent-tooling" and
    .installed == true and
    .version == $version
  )' <<< "$catalog" >/dev/null || {
    printf 'agent-tooling: Codex did not install boxlite-agent-tooling at expected version %s\n' \
      "$expected_plugin_version" >&2
    exit 1
  }
elif [[ "$installed_count" != 1 ]]; then
  printf 'agent-tooling: Codex reported an ambiguous boxlite-agent-tooling installation\n' >&2
  exit 1
fi

if [[ "$changed" == 1 ]]; then
  jq -nc --arg message \
    'BoxLite agent tooling was installed or updated. Start a new Codex task to load its skills and tools, then review its plugin hooks with /hooks.' \
    '{systemMessage: $message}'
fi
