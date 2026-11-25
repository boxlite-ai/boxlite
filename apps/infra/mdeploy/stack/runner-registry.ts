/** Quote one literal word in generated POSIX or Bash source. */
function shellLiteral(value: string) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`
}

/** Public OCI artifact produced by the release workflow. Hosts need only anonymous pull access. */
const repository = 'boxlite-ai/boxlite/runner'
export const runnerRegistry = `https://ghcr.io/v2/${repository}`
export const runnerDigestFile = '/usr/local/bin/boxlite-runner.oci-digest'
const sha256 = /^sha256:[0-9a-f]{64}$/
export type ReleaseRunner = { tag: string; pins?: { manifest: string; archive: string; sha: string } }

export function releaseRunner(version: string, metadata?: string): ReleaseRunner {
  const tag = 'v' + version
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error('Invalid Runner release version')
  if (metadata === undefined) return { tag }
  const { tag: recorded, sha, runner } = JSON.parse(metadata)
  if (
    recorded !== tag ||
    typeof sha !== 'string' ||
    !/^[0-9a-f]{40}$/.test(sha) ||
    typeof runner?.manifest !== 'string' ||
    !sha256.test(runner.manifest) ||
    typeof runner.archive !== 'string' ||
    !sha256.test(runner.archive)
  ) {
    throw new Error('Invalid release candidate pins for Runner ' + tag)
  }
  return { tag, pins: { sha, manifest: runner.manifest, archive: runner.archive } }
}

const curl =
  "curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 10 --max-time 300 --retry 3 --retry-max-time 300"

/** A draft supplies pins inline. A version-only operator invocation reads the same published receipt. */
export function registrySetup({ tag, pins }: ReleaseRunner): string {
  if (pins)
    return `RUNNER_TAG=${shellLiteral(tag)}
RUNNER_MANIFEST=${shellLiteral(pins.manifest)}
RUNNER_ARCHIVE=${shellLiteral(pins.archive)}
RUNNER_REVISION=${shellLiteral(pins.sha)}`
  return `RUNNER_TAG=${shellLiteral(tag)}
RUNNER_RECEIPT=$(${curl} "https://github.com/boxlite-ai/boxlite/releases/download/$RUNNER_TAG/release-candidate.json" | python3 -c '
import json, re, sys
m = json.load(sys.stdin)
r = m["runner"]
if m["tag"] != sys.argv[1] or not re.fullmatch("[a-f0-9]{40}", m["sha"]) or not all(re.fullmatch("sha256:[a-f0-9]{64}", r[k]) for k in ("manifest","archive")):
    sys.exit("invalid Runner release receipt")
print(r["manifest"], r["archive"], m["sha"])
' "$RUNNER_TAG")
read -r RUNNER_MANIFEST RUNNER_ARCHIVE RUNNER_REVISION <<< "$RUNNER_RECEIPT"`
}

/** Verify the manifest bytes before reading its descriptors, then verify the layer before extraction. */
export const registryDownload = `RUNNER_TOKEN=$(${curl} 'https://ghcr.io/token?service=ghcr.io&scope=repository:${repository}:pull' | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')
${curl} -H "Authorization: Bearer $RUNNER_TOKEN" -H 'Accept: application/vnd.oci.image.manifest.v1+json' "${runnerRegistry}/manifests/$RUNNER_MANIFEST" -o "$RUNNER_MANIFEST_FILE"
printf '%s  %s\\n' "\${RUNNER_MANIFEST#sha256:}" "$RUNNER_MANIFEST_FILE" | sha256sum -c -
python3 - "$RUNNER_MANIFEST_FILE" "$RUNNER_TAG" "$RUNNER_REVISION" "$RUNNER_ARCHIVE" <<'VERIFY_RUNNER'
import json, sys
path, tag, revision, archive = sys.argv[1:]
with open(path) as f:
    manifest = json.load(f)
layers = manifest["layers"]
annotations = manifest["annotations"]
if (manifest.get("artifactType") != "application/vnd.boxlite.runner.v1"
    or annotations.get("org.opencontainers.image.version") != tag
    or annotations.get("org.opencontainers.image.revision") != revision
    or len(layers) != 1 or layers[0]["digest"] != archive or layers[0]["mediaType"] != "application/gzip"):
    sys.exit("Runner manifest does not match this release")
VERIFY_RUNNER
${curl} -H "Authorization: Bearer $RUNNER_TOKEN" "${runnerRegistry}/blobs/$RUNNER_ARCHIVE" -o "$RUNNER_ARCHIVE_FILE"
printf '%s  %s\\n' "\${RUNNER_ARCHIVE#sha256:}" "$RUNNER_ARCHIVE_FILE" | sha256sum -c -`

export const recordRunnerDigest = `printf '%s\\n' "$RUNNER_MANIFEST $RUNNER_ARCHIVE" > ${runnerDigestFile}.new && mv -f ${runnerDigestFile}.new ${runnerDigestFile}`
