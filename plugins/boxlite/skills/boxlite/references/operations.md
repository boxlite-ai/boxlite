# Operate the recorded deployment

Use the private project config's exact executable/home/profile/API/Box/root. Replace CLI_HOME/API in the examples; omit a selector only for its verified default. Record 'ACTIVE_RELEASE' from the last successful helper result; its 'config.json' survives stopping the service. For the default helper root:

~~~sh
boxlite --home CLI_HOME --profile PROFILE --url API exec APP -- tail -n 60 /workspace/boxlite-app/shared/app.log
boxlite --home CLI_HOME --profile PROFILE --url API exec APP -- python3 /workspace/boxlite-app/shared/service.py stop ACTIVE_RELEASE/config.json
boxlite --home CLI_HOME --profile PROFILE --url API stop APP
~~~

Redact incidental secrets before presenting log output. To resume:

~~~sh
boxlite --home CLI_HOME --profile PROFILE --url API start APP
boxlite --home CLI_HOME --profile PROFILE --url API exec APP -- python3 /workspace/boxlite-app/shared/service.py restart ACTIVE_RELEASE/config.json
~~~

Expect: managed PID and verified guest/public health plus a feature check. Stopping the service clears its PID state; resume from the retained release configuration. Keep the same Box/port/URL; Box startup does not launch the app.

Mismatched PID or concurrent operation: inspect private state; never broad pkill. Start commands stay foreground; daemonized applications need their existing lifecycle manager.

Build failures leave the current service running. Replacement-start failure attempts the previous release but still fails the deployment command; verify restored behavior. Old releases consume disk: retain active and rollback releases, remove only confirmed task-owned older releases.

Back up database/media outside the Box using their supported methods. Restore to separate resources and check data/features before claiming recovery. Preserve schema compatibility and do not overwrite live data without authorization.

Report retained resource identities, lifetime and billing. Stop/delete only within the agreed cleanup scope; Box deletion removes guest data while volumes have separate lifetimes.

Source archive transfer and extraction each allow 300 seconds; other CLI operations retain a 60-second deadline, including restart. A CLI timeout reports the operation without argv/output and requires inspecting its state before retrying. If replacement and rollback startup both fail, stale service state is removed and the original replacement error is preserved.
