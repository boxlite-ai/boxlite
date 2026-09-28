# Guest SSH lifecycles

## TL;DR

SSH work belongs to a service generation, connection, or channel; cancellation requests a stop, while tracked completion proves cleanup has finished.

## Start with the ownership model

Read the [architecture overview](README.md) first. These diagrams follow its
`ssh alice@host 'echo hello'` example, then add forwarding and shutdown.

| Scope | Starts at | Finishes when |
| --- | --- | --- |
| Service generation | Successful `configure()` | Listener and tracked SSH work have drained |
| Connection | Accepted TCP socket | Russh session ends and connection cleanup drains |
| Execution-backed channel | Shell, exec, SFTP, or direct Unix socket request | Process and output task finish, then execution resources are released |
| Remote forwarding listener | TCP bind or container helper readiness | Listener stops and pending channel opens settle; established relays have a separate lifetime |

Read in order: [service](#1-service-configuration) → [connection](#2-connection-and-authentication)
→ [channel](#3-channel-execution) → [forwarding](#4-forwarding) → [shutdown](#5-service-shutdown).
Arrows name calls or events. **Spawn** starts concurrent work; **await** marks a
completion dependency. Diagrams omit routine logging and validation helpers.

## 1. Service configuration

`Configure` replaces one complete SSH generation. Validation happens before
stopping the current generation; binding the new address happens afterward.

```mermaid
flowchart TD
    RPC["Ssh.Configure RPC"] --> PARSE["SshManager::configure<br/>SshConfig::parse"]
    PARSE -->|invalid| KEEP["Return InvalidArgument<br/>current generation stays running"]
    PARSE -->|valid| LOCK["Lock manager state"]
    LOCK --> STOP["await stop()<br/>cancel and drain old generation"]
    STOP -->|drain timeout| TIMEOUT["Return DeadlineExceeded<br/>disabled, cleanup still tracked"]
    STOP -->|drained| BIND["await TcpListener::bind"]
    BIND -->|failure| DISABLED["Return Unavailable<br/>service remains disabled"]
    BIND -->|success| START["New TaskGroup<br/>increment generation<br/>spawn accept_loop"]
    START --> READY["Return enabled SshStatus"]
```

`Status` reports availability, not a cleanup barrier. `Disable` calls the same
`stop()` without starting a replacement. A later control call can resume waiting
after a drain timeout; the old tracking state is retained.

Source: [configure/status/disable/stop](mod.rs#L127).

## 2. Connection and authentication

One accepted socket gets one `SshConnection`, one child `TaskGroup`, and one
connection permit. The accept loop can continue while that connection runs.

```mermaid
sequenceDiagram
    participant A as Accept loop
    participant M as Connection task
    participant R as russh
    participant H as SshConnection
    A->>M: spawn_connection() → spawn_tracked()
    M->>H: new() with authentication notification
    M->>R: await run_stream(config, socket, handler)
    R->>R: Exchange identification, begin key exchange
    R->>R: Spawn session event loop
    R-->>M: RunningSession
    M->>M: monitor_session()
    Note over R,H: Key exchange and authentication continue
    opt Authentication succeeds before deadline
        R->>H: auth_publickey() / auth_openssh_certificate()
        H->>H: Authorize account and commit permissions
        H-->>M: authenticated notification
        H-->>R: Auth::Accept
    end
    Note over M,R: Await session end, cancellation, or pre-auth deadline
    opt Cancellation or pre-auth deadline
        M->>R: disconnect_transport() → Handle::disconnect()
        M->>M: Shut down TCP socket
    end
    R->>H: Drop handler as session ends
    H->>H: Cancel connection tasks and terminate bridges
    R-->>M: RunningSession completes
    M->>M: Release connection permit
    Note over M,H: Child cleanup can still be draining
```

There are two separate 30-second limits: `run_stream()` identification exchange,
then authentication in `monitor_session()`. Returning `RunningSession` does not
mean the client authenticated. A rejected key can be retried within the deadline.

Disconnect allows up to one second to queue the russh request, then shuts down
the local socket and awaits the session. During identification, cancellation
closes the socket directly. Neither step promises that the peer received CLOSE
for every channel.

Sources: [accept and monitor](mod.rs#L231), [authentication](server.rs#L76),
[handler drop](server.rs#L622). Russh's [run_stream implementation](https://docs.rs/russh/0.62.4/src/russh/server/mod.rs.html#1049-1088)
shows the separate spawned event loop.

## 3. Channel execution

Opening a session channel only reserves pending state. `env_request()` and
`pty_request()` fill it; shell, exec, or SFTP requests start the process.
The following diagram shows normal completion of `echo hello`.

```mermaid
sequenceDiagram
    participant H as SshConnection / russh
    participant B as ChannelBridge
    participant E as Execution core
    participant O as Output task
    participant C as Cleanup task
    H->>H: channel_open_session() → accept and store state
    H->>B: exec_request() → start_execution() → start()
    B->>E: await start_ssh_execution()
    E-->>B: Execution ID for container process
    B->>E: send_execution_input() opens stdin stream
    B->>O: spawn output_pump()
    B->>C: spawn_tracked execution cleanup
    B-->>H: Store bridge for channel
    H->>B: data() / channel_eof() → stdin / stdin_eof
    B->>E: Input bytes / close stdin
    par Output and channel completion
        E-->>O: stdout hello
        O->>H: Handle::data()
        E-->>O: Output stream EOF
        O->>E: await wait_execution()
        E-->>O: Actual process exit status
        O->>H: finish_channel(): exit status, EOF, CLOSE
    and Execution resource cleanup
        C->>E: await state.wait_process()
        E-->>C: Process has exited
        C->>O: await output_task completion
        C->>E: await registry.release_ephemeral()
    end
```

| Event | What changes |
| --- | --- |
| Client EOF | Closes process stdin; the process may continue running |
| Output stream EOF | Output pump still awaits actual process exit before sending exit status |
| Client CLOSE, connection drop, or service stop | `terminate_running()` cancels bridge tasks; tracked cleanup signals the process group, waits for exit, then releases resources |
| Bridge setup fails after obtaining an execution ID | `cleanup_failed_execution_start()` schedules the same termination/release path |

On cancellation, `terminate_process_group()` sends SIGHUP and SIGTERM, waits out
the one-second grace period, then attempts SIGKILL. The output task is cancelable,
so normal exit-status/EOF/CLOSE delivery is not guaranteed during teardown.
Cleanup awaits both process exit and output-task completion before release.
The stdin writer is also tracked through completion.

Sources: [channel callbacks](server.rs#L169), [bridge startup](bridge.rs#L120),
[signals](bridge.rs#L307), [output completion](bridge.rs#L747),
[tracked cleanup](bridge.rs#L825).

## 4. Forwarding

### Establish the destination before relaying

All modes require forwarding permission. Direct forwarding opens from client to
server; remote forwarding opens a new channel back toward the client for each
accepted socket. See the [four network paths](README.md#forwarding-where-each-connection-goes).

| Mode | Readiness and channel confirmation | Relay owner |
| --- | --- | --- |
| Direct TCP | `open_direct_tcpip()` connects the guest TCP socket, then `reply.accept()` | `ForwardingManager` task |
| Direct Unix socket | `ChannelBridge::start()` awaits container helper READY, then the handler accepts and calls `activate_output()` | Bridge and container helper |
| Remote TCP | `listen_tcpip()` binds a guest loopback listener before success | One task per accepted socket |
| Remote Unix socket | `listen()` starts a container listener and awaits helper READY before success | Container helper plus one guest relay per accepted socket |

```mermaid
sequenceDiagram
    participant S as Incoming socket
    participant L as Remote listener task
    participant R as russh Handle
    participant C as SSH client
    S->>L: Accept TCP socket / private Unix-helper ingress
    opt Remote Unix socket
        L->>L: authenticate_ingress() with private token
    end
    L->>R: Spawn pending open, await channel_open_forwarded_*()
    R->>C: Request forwarded channel
    alt Client confirms before timeout
        C-->>R: Channel-open confirmation
        R-->>L: Channel
        L->>L: Spawn relay using Channel::into_stream()
        S<<->>C: Bytes through guest relay and SSH channel
    else Rejection or timeout
        L->>L: Drop local socket and permit
    end
```

Direct TCP connect and forwarded-channel confirmation each have a ten-second
timeout. Direct Unix helpers use bridge execution cleanup but omit SSH process
exit notifications: a forwarded stream is not a shell session.

### Stop a listener without confusing it with its relays

For TCP, `cancel_tcpip_forward()` cancels the selected registration. Its task
drops the listener, awaits pending opens, then drops the registration to notify
the caller. Already established relays may continue until they finish or their
connection/service is canceled.

Unix listeners require another handshake because the socket lives inside the
container. The successful cancellation path is:

```mermaid
sequenceDiagram
    participant H as SshConnection
    participant L as Reverse listener task
    participant P as Container helper
    participant E as Execution cleanup
    H->>L: cancel_streamlocal_forward() → cancel registration
    L->>L: Drop private guest ingress
    L->>P: request_stop() closes control stdin
    P->>P: Drop Unix listener and unlink owned socket path
    P-->>L: STOPPED marker
    par Guest side
        L->>L: await pending channel opens
        L-->>H: Finish registration, cancellation succeeds
        L->>E: Spawn tracked helper cleanup
    and Container side
        P->>P: Drain established relays, up to 30 seconds
        P->>P: Exit helper process
    end
    E->>E: await process, output and stdin tasks
    E->>E: release_ephemeral()
```

**STOPPED means the listener is gone, not that the helper has exited.**
Waiting for STOPPED has a ten-second timeout after the stop request is sent.
A missing acknowledgement triggers cleanup with process termination; a helper
that already ended goes straight to completion cleanup. A successful listener
cancellation does not await execution release.

Sources: [TCP lifecycle](forward.rs#L154), [TCP listener drain](forward.rs#L375),
[direct Unix readiness](server.rs#L247), [reverse Unix manager](reverse_streamlocal.rs#L442),
[helper STOPPED and relay drain](reverse_streamlocal.rs#L190),
[guest listener teardown](reverse_streamlocal.rs#L865), [helper cleanup](reverse_streamlocal.rs#L1042).

## 5. Service shutdown

`disable()` and replacement `configure()` share this stop path. Cancellation
propagates down the task tree; the branches below run concurrently.

```mermaid
flowchart TD
    STOP["SshManager::stop()<br/>mark status disabled"] --> CANCEL["Generation TaskGroup::cancel()"]
    CANCEL --> LISTENER["Cancel accept_loop<br/>drop listener"]
    CANCEL --> SESSION["Disconnect transports<br/>await russh sessions"]
    SESSION --> DROP["SshConnection::drop()<br/>cancel children and terminate bridges"]
    CANCEL --> BRIDGES["Bridge cleanup<br/>terminate / await process<br/>await output, release execution"]
    CANCEL --> FORWARD["Forwarding cleanup<br/>stop listeners, settle opens<br/>finish relays and helper cleanup"]
    DROP -.-> BRIDGES
    DROP -.-> FORWARD
    LISTENER --> DRAIN["await TaskGroup::wait()<br/>all tracked work completes"]
    SESSION --> DRAIN
    BRIDGES --> DRAIN
    FORWARD --> DRAIN
    DRAIN --> JOIN["await listener JoinHandle<br/>clear old generation state"]
    JOIN --> DONE["Stop completed"]
```

The caller gives the drain **ten seconds**. On timeout it gets
`DeadlineExceeded`; status stays disabled and cleanup remains tracked.
The diagram's final state has not yet been reached.

| TaskGroup API | Meaning during shutdown |
| --- | --- |
| `child()` | Parent cancellation reaches children; parent tracking includes their completion |
| `spawn()` | Drops its work when cancellation wins, e.g. accept loop or ordinary relay |
| `spawn_tracked()` | Passes the cancellation token to work that must finish its own cleanup |
| `token()` | Keeps russh's handler lifetime counted until `Drop` has registered cleanup |
| `wait()` | Closes the tracker and awaits tracked work, including cleanup registered during shutdown |

SSH disable leaves the container's main process and non-SSH executions running.
Full `Guest.Shutdown` attempts SSH disable, then continues with the execution
registry and container teardown even if disabling SSH returned an error.

Sources: [stop barrier](mod.rs#L190), [TaskGroup](task_group.rs#L10),
[guest shutdown](../guest.rs#L89). Time limits live in [limits.rs](limits.rs).
