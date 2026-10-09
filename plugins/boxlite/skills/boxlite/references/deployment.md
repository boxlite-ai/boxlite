# Deploy a full-stack app

Inspect the app's build, start, health check, runtime dependencies, and data paths. Use its existing project commands for local verification. Keep generated application source in the app workspace. Inspect `boxlite create --help`, `volume create --help`, and `network tunnel --help` for the installed CLI version before selecting options.

Confirm that the selected CLI profile or explicit URL targets the intended cloud API before allocating resources; an unconfigured CLI can use the local runtime. Run `auth whoami` and resource queries with the same connection settings. When using an SDK, select its REST runtime explicitly.

Select unique Box and volume names and record their IDs, public URL, guest app directory, service port, and persistent paths in a private project manifest. Respect the user's existing profile and cloud environment. For an independent test, allocate separate resources within the authorized scope/budget.

For a Python service, an example Box configuration is the cloud-supported `python` image alias, 1 CPU, 2048 MiB RAM, and a 10 GiB guest disk. Choose resources and the supported image for the actual app. Set auto-stop deliberately and auto-delete to 0 when retaining guest data. The managed cloud restricts images to supported aliases; an arbitrary OCI image accepted locally can be rejected remotely.

When media storage is needed, create a dedicated volume with `boxlite --profile PROFILE volume create --name MEDIA_NAME`, record the returned identity, and attach it at creation with `-v MEDIA_NAME:/mnt/media`. Start the Box and verify the actual mount through guest exec before configuring the app's upload path. `boxlite cp` does not access mounted media; use guest exec for files under the mount.

Copy only app source or built artifacts required by the deployment. Exclude host dependencies, credentials, `.env`, and private data. Install guest dependencies for the app's documented runtime and use an unprivileged service user. Configure secrets separately in server-only private files or the user's chosen secret store. Install a process supervisor and record the app-specific start, stop, status, and log commands; the plugin does not supply an app runtime.

Check each foreground exec's exit status before using its output; SDK completion alone does not imply success. A detached launch only confirms submission: probe the service port and health endpoint before reporting it ready.

For an app that needs a public HTTPS URL, create its Box with `--inbound enabled`; the default inbound mode is private and `network tunnel` will refuse it. Explain the public exposure and honor the user's existing authorization; obtain authorization when that exposure is outside the agreed scope. Inspect the actual inbound setting rather than assuming platform defaults. Expose only the intended service. Do not recreate an existing private Box merely to change visibility: inspect `boxlite update --help` if that command is available, or use the documented server-side inbound update for that exact Box.

Obtain the public URL with `boxlite --profile PROFILE network tunnel BOX_NAME PORT`. Use the returned HTTPS URL, not a handcrafted proxy hostname. For remote Boxes, `-p` host-port publication is not the public URL mechanism. Verify the app's health endpoint and required features through that URL. Configure application OAuth callbacks only after it is known.

Updates must preserve database paths, managed volumes, and private configuration. Stage artifacts and verify checksums before replacing app files. If proxy size limits reject an archive, copy smaller chunks to guest rootfs, reassemble, and compare SHA-256 before extraction. Do not retry large transfers indefinitely.

Long CLI exec tasks can lose their websocket attachment while continuing inside the guest. Write installer output and exit status to guest-rootfs files, check completion with a separate short exec, and inspect those files before retrying. Do not rerun a still-running installer.

For Python SDK workflows, consult the [Cloud agent guide](https://boxlite.ai/agent.md), whose recipes target SDK 0.10.0. Check the installed SDK and target environment before reuse; its `SimpleBox.tunnel()` caveats and host-directory `volumes=` limitations do not replace this CLI's tunnel and managed-volume guidance. Keep SDK-specific snippets within their documented language and version.
