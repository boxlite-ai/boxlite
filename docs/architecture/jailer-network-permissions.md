# 1079: Jailer network permission fix

[#1079](https://github.com/boxlite-ai/boxlite/pull/1079) fixes
[#1072](https://github.com/boxlite-ai/boxlite/issues/1072).

## Three settings

- `network.mode` decides whether the guest network backend is created
  ([definition](../../src/boxlite/src/runtime/options.rs#L730-L761),
  [creation](../../src/boxlite/src/litebox/init/tasks/vmm_spawn.rs#L350-L365)).
- `security.networkEnabled` controls whether the jailer grants host-side IP
  networking to the shim
  ([definition](../../src/boxlite/src/runtime/advanced_options.rs#L170-L176),
  [propagation](../../src/boxlite/src/jailer/mod.rs#L595-L603)).
- `security.jailerEnabled` controls whether the host sandbox is enabled. When
  it is disabled, `networkEnabled` has no effect
  ([check](../../src/boxlite/src/jailer/mod.rs#L399-L415)).

## Eight combinations

Bold rows are the three behavior changes made by 1079:

| `network.mode` | `networkEnabled` | `jailerEnabled` | Before 1079 | After 1079 |
| --- | --- | --- | --- | --- |
| `enabled` | `true` | `true` | Guest networking with jailer. | Unchanged. |
| `enabled` | `true` | `false` | Guest networking without jailer. | Unchanged. |
| `enabled` | `false` | `true` | **Seatbelt denied AF_UNIX; startup failed.** | **Rejected at creation.** |
| `enabled` | `false` | `false` | **Guest networking remained enabled; silent fail-open.** | **Rejected at creation.** |
| `disabled` | `true` | `true` | No guest network; jailer enabled. | Unchanged. |
| `disabled` | `true` | `false` | No guest network; jailer disabled. | Unchanged. |
| `disabled` | `false` | `true` | **AF_UNIX control plane denied; startup failed.** | **AF_UNIX allowed; startup succeeds.** |
| `disabled` | `false` | `false` | No guest network; jailer disabled. | Unchanged. |

## Three behavior changes

### Reject two contradictory configurations

`BoxliteRuntime::create()` and `get_or_create()` call `sanitize_common()` first
([creation boundary](../../src/boxlite/src/runtime/core.rs#L284-L314)). This
condition covers both `enabled / false / true` and `enabled / false / false`:

```rust
if !self.advanced.security.network_enabled
    && matches!(self.network, NetworkSpec::Enabled { .. })
```

The check is implemented in
[`runtime/options.rs`](../../src/boxlite/src/runtime/options.rs#L592-L609). It
intentionally ignores `jailer_enabled`, preventing a disabled jailer from
silently turning the configuration into a fail-open.

### Allow AF_UNIX for a network-disabled box

`disabled / false / true` still creates no guest network backend
([vmm_spawn.rs](../../src/boxlite/src/litebox/init/tasks/vmm_spawn.rs#L350-L365)).
The jailer collects the exact AF_UNIX bind/connect paths required by the box
([jailer/mod.rs](../../src/boxlite/src/jailer/mod.rs#L548-L584)). Seatbelt always
grants those paths but still omits the IP networking policy
([policy branch](../../src/boxlite/src/jailer/sandbox/seatbelt.rs#L243-L256),
[exact grants](../../src/boxlite/src/jailer/sandbox/seatbelt.rs#L340-L375)).

The box can therefore start while the guest remains offline.
