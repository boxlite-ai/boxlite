# Auto-stop SDK design references

The hosted auto-stop API follows the lifecycle patterns used by comparable
sandbox SDKs:

- Daytona documents the same two-surface shape: an interval on create and a
  runtime setter, with `0` disabling the policy. See the upstream source
  reference at [`sandboxes.mdx#L1377-L1438`](https://github.com/daytonaio/daytona/blob/main/apps/docs/src/content/docs/en/sandboxes.mdx#L1377-L1438).
- E2B exposes a timeout on create and a runtime `setTimeout` method. Its
  public SDK reference defines the timeout unit and the fact that the setter
  resets the deadline: [`sandbox#change-sandbox-timeout-during-runtime`](https://e2b.dev/docs/sandbox#change-sandbox-timeout-during-runtime).

BoxLite applies the same lifecycle split while using seconds consistently:

- create/update REST DTOs validate a non-negative integer before persistence;
- hosted SDKs expose creation options plus a box instance setter;
- local runtimes reject the hosted-only option instead of persisting a policy
  that they cannot enforce.
