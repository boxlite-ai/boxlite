---
name: boxlite
description: Build or adapt an application, deploy it to BoxLite cloud, return its registered public HTTPS URL, and update or diagnose it. Use for BoxLite hosting requests and app building that explicitly selects BoxLite.
---

Complete the requested app in the user's project, then deploy and verify its features. Use the first-deploy path below; reuse its private configuration for updates. Preserve the user's framework, cloud profile and existing resources.

## First deployment

### 1. Inspect the project and authenticate

Record production build/start commands, port, health endpoint, environment variable **names**, persistent paths and host-only dependencies. Fix localhost browser URLs and listeners. For a development-only project consult [frameworks](references/frameworks.md); for a new app implement the requested functionality first.

Before cloud work, enter the bundled **boxlite-setup** workflow automatically when this session has not verified the CLI/profile or a later authentication check reports missing/expired credentials. It reuses valid login, prepares a supported CLI if needed, and starts device authorization when required. Do not send the user away to find a Setup button or run another skill manually.

Continue this app task after setup succeeds, using its exact executable/home/profile and explicit API URL. In CLI examples replace CLI_HOME/API with those values; omit a selector only for an intentionally verified default. Online docs are an optional reference for missing information. Local app work can continue while browser authorization is pending; cloud operations wait for verified identity.

Reuse existing authorization. Explain public access and running-resource billing; obtain authorization still missing for the selected budget or private app configuration transfer. Developer cloud credentials stay outside the application and its archive.

### 2. Create or reuse a Box and register the URL

Cloud aliases are 'base', 'python', and 'node'. Images use user 'boxlite', passwordless sudo and '/workspace'; Box startup does not automatically launch the app. Disk/CPU/memory limits depend on the organization; a 10 GB disk is the current default, not a universal entitlement.

Example for a new small Python service, after selecting resources:

~~~sh
boxlite --home CLI_HOME --profile PROFILE --url API create python --name APP --cpus 1 --memory 2048 --disk-size 10 --inbound enabled --auto-stop 15m --auto-delete 0
boxlite --home CLI_HOME --profile PROFILE --url API start APP
boxlite --home CLI_HOME --profile PROFILE --url API network tunnel APP PORT
~~~

Expect: a Box identity and registered HTTPS URL. Record them privately. Reuse an existing Box; do not recreate it to redeploy or change visibility. A private Box needs a supported inbound update; inspect the installed CLI help.

Register before configuring public origins, OAuth callbacks or build-time frontend URLs. Use the returned URL; preview links and constructed hostnames do not substitute for registration. Do not assume registration limits exposure: some production proxies still reach unregistered listening ports on an inbound-enabled Box. Use an app-only listener layout; keep database/admin/debug listeners disabled or on verified private connections/Unix sockets. Newer proxy source requires per-port registration, but rely on that only after verifying the selected deployment. Never register database/admin ports.

Idle auto-stop can make the site unavailable; visitor traffic does not necessarily restart it. Use '--auto-stop 0' only for an authorized always-on deployment and explain billing. '--auto-delete 0' retains the detached Box's data until deliberate deletion.

### 3. Configure private environment and data paths

The helper uses '/workspace/boxlite-app/releases' for code, 'shared' for private configuration/logs and 'data' for persistent files. Set a different 'remote_root' for an existing layout. Keep data outside releases. Read [database](references/database.md), [application login](references/app-auth.md), or [managed media](references/media.md) only when the app needs them.

If app environment values are needed, prepare a private JSON object mapping names to string values from an existing user-approved local file/secret source. Keep it outside Git and deploy archives. A framework can parse a dotenv file locally into that format. Do not source arbitrary dotenv text as shell code or place secrets in argv/chat.

~~~sh
boxlite --home CLI_HOME --profile PROFILE --url API exec APP -- mkdir -p /workspace/boxlite-app/shared /workspace/boxlite-app/data
boxlite --home CLI_HOME --profile PROFILE --url API exec APP -- chmod 700 /workspace/boxlite-app/shared
boxlite --home CLI_HOME --profile PROFILE --url API cp PRIVATE_ENV_JSON APP:/workspace/boxlite-app/shared/env.json
boxlite --home CLI_HOME --profile PROFILE --url API exec APP -- chmod 600 /workspace/boxlite-app/shared/env.json
~~~

Expect: private environment values loaded for build/start. Set public-origin values before building; frontend-embedded variables contain public values only. Skip this transfer when no environment file is needed.

### 4. Deploy using private project configuration

Resolve 'SKILL_DIR' to this skill's installed directory. Save '.boxlite/deploy.json' privately in the **application project**, outside Git. Fill it from the actual project. Commands are argv arrays; build steps are separate arrays. Use a reviewed '["sh","-c",...]' only when shell syntax is necessary, with no secret values.

Check 'python3 --version' on the host: the helper requires Python 3.9+. Select an available interpreter or a user-authorized installation if missing. Curated guest images already provide Python 3; no additional helper package is required.

Example for a project with requirements.txt, server.py and /health on port 8000:

~~~json
{
  "cli": "boxlite",
  "profile": "PROFILE",
  "home": "CLI_HOME",
  "api_url": "https://api.boxlite.ai",
  "box": "APP",
  "source": "..",
  "port": 8000,
  "health_path": "/health",
  "build": [["python3", "-m", "pip", "install", "-r", "requirements.txt"]],
  "start": ["python3", "server.py"]
}
~~~

~~~sh
python3 SKILL_DIR/scripts/deploy.py .boxlite/deploy.json
~~~

Expect: JSON with the registered URL, release directory and passed guest/public health. The helper excludes dependency caches, '.env*', private deployment state and common data/key files; rejects source symlinks; uploads compressed source; builds in Linux; and restarts the recorded service. Inspect other project-specific private/generated files and select the deployable source accordingly.

Build log/exit files live beside the release's app directory. Failed builds preserve the current service; failed replacement starts attempt the previous recorded release and still report failure. A detached build or lost CLI connection is not a reason to start another build: inspect its build.log/build.exit with a short exec first. The helper is noninteractive.

### 5. Verify and hand off

~~~sh
curl --fail --silent --show-error https://REGISTERED_URL/health
~~~

Expect: health **and the requested feature** work at the public URL. Exercise a real feature/API; homepage 200 alone is insufficient. For application login arrange browser verification with the user. Report URL, resource identity, observed results, redeploy command, costs and stop/delete options. Identify any unverified feature or pending external setup.

## Redeploy after code changes

Run the same command after changing and locally checking the app:

~~~sh
python3 SKILL_DIR/scripts/deploy.py .boxlite/deploy.json
~~~

Expect: a new release/PID, the same Box/port URL, and preserved shared configuration/data. Probe the changed feature and existing data. Do not recreate the Box. After stop/start use the recorded service controller as described in [operations](references/operations.md).

## Diagnose by the failing step

| Observation | Next action |
| --- | --- |
| Tunnel refuses private inbound | Inspect the supported visibility update; preserve the Box/data. |
| Upload HTTP 413 | Inspect compressed size and exclusions; do not retry the unchanged upload. |
| Build failed or status unknown | Read release build.log/build.exit before retrying. |
| Unregistered-port proxy 404 | Register only the intended app port; distinguish app/proxy responses. |
| Public 502 | Check guest health, port, 0.0.0.0 binding and bounded app logs. |
| PID ownership or lock error | Inspect private service state; never use broad pkill or signal unrelated PIDs. |
| Box runs but app does not | Start the recorded app and check health; Box startup is not app startup. |

Read [operations](references/operations.md) for logs, rollback, backups and cleanup. Preserve existing data/mounts while diagnosing.
