#!/usr/bin/env python3
"""
Sync Native API Example - Low-Level Box API (Synchronous)

Synchronous version of use_native_api.py.  See that file for detailed comments.

Demonstrates the synchronous native boxlite API (mirrors async API exactly):
- SyncBoxlite.default() returns SyncBoxlite runtime (mirrors Boxlite.default())
- runtime.create() returns SyncBox (mirrors runtime.create())
- SyncBox.exec() returns SyncExecution (mirrors box.exec())
- SyncExecution.stdout()/stderr() return sync iterables
- All methods are synchronous (no await needed)

Requires: pip install boxlite[sync]
"""

import tempfile
import time

import boxlite
from boxlite import SyncBoxlite


def example_default_runtime():
    """Example 1: Using default runtime."""
    print("\n=== Example 1: Default Runtime ===")

    with SyncBoxlite.default() as runtime:
        print(f"✓ Sync runtime: {runtime}")

        # Create a box (mirrors: runtime.create())
        box = runtime.create(boxlite.BoxOptions(image="alpine:latest"))
        print(f"✓ Box created: {box.id}")

        # Execute command (mirrors: await box.exec())
        execution = box.exec("echo", ["Hello from default runtime"])
        stdout = execution.stdout()

        print("Output:")
        for line in stdout:  # Regular for loop, not async for
            print(f"  {line.strip()}")

        exec_result = execution.wait()  # No await
        print(f"✓ Exit code: {exec_result.exit_code}")

        # Shutdown box (mirrors: await box.stop())
        box.stop()  # No await
        print("✓ Box shut down")


def example_custom_runtime():
    """Example 2: Custom runtime with options."""
    print("\n\n=== Example 2: Custom Runtime ===")

    with SyncBoxlite.default() as runtime:
        # Create box with resource limits
        box_opts = boxlite.BoxOptions(
            image="alpine:latest",
            cpus=2,
            memory_mib=512,
        )
        box = runtime.create(box_opts, name=f"test-box-{int(time.time())}")
        print(f"✓ Box created with limits: {box.id}")

        # Get box info
        info = box.info()
        print(f"✓ Box info:")
        print(f"  ID: {info.id}")
        print(f"  State: {info.state.status}")
        print(f"  Image: {info.image}")
        print(f"  CPUs: {info.cpus}")
        print(f"  Memory: {info.memory_mib} MiB")
        print(f"  Created: {info.created_at}")

        box.stop()
        print("✓ Box shut down")


def example_streaming_execution():
    """Example 3: Streaming stdout and stderr."""
    print("\n\n=== Example 3: Streaming Execution ===")

    with SyncBoxlite.default() as runtime:
        box = runtime.create(boxlite.BoxOptions(image="alpine:latest"))
        print(f"✓ Box created: {box.id}")

        # Execute command that produces both stdout and stderr
        execution = box.exec(
            "sh",
            ["-c", "echo 'to stdout' && echo 'to stderr' >&2 && echo 'more stdout'"]
        )

        # Get both streams
        exec_id = execution.id
        print(f"✓ Execution ID: {exec_id}")

        stdout = execution.stdout()
        stderr = execution.stderr()

        print("\nStdout stream:")
        for line in stdout:  # Sync iteration
            print(f"  stdout: {line.strip()}")

        print("\nStderr stream:")
        for line in stderr:  # Sync iteration
            print(f"  stderr: {line.strip()}")

        exec_result = execution.wait()
        print(f"\n✓ Exit code: {exec_result.exit_code}")

        box.stop()


def example_environment_variables():
    """Example 4: Environment variables."""
    print("\n\n=== Example 4: Environment Variables ===")

    with SyncBoxlite.default() as runtime:
        box = runtime.create(boxlite.BoxOptions(
            image="alpine:latest",
            env=[("USER", "alice"), ("PROJECT", "boxlite")]
        ))
        print(f"✓ Box created with env vars: {box.id}")

        # Execute with additional env vars
        execution = box.exec(
            "env",
            None,
            [("CUSTOM", "value"), ("FOO", "bar")]
        )

        stdout = execution.stdout()
        print("\nEnvironment variables:")
        for line in stdout:
            line = line.strip()
            if any(key in line for key in ["USER=", "PROJECT=", "CUSTOM=", "FOO="]):
                print(f"  {line}")

        execution.wait()
        box.stop()


def example_box_metrics():
    """Example 5: Box metrics."""
    print("\n\n=== Example 5: Box Metrics ===")

    with SyncBoxlite.default() as runtime:
        box = runtime.create(boxlite.BoxOptions(image="alpine:latest"))
        print(f"✓ Box created: {box.id}")

        # Execute some commands
        for i in range(3):
            execution = box.exec("echo", [f"Command {i + 1}"])
            stdout = execution.stdout()
            for line in stdout:
                pass  # Consume output
            execution.wait()

        # Get box metrics
        metrics = box.metrics()
        print(f"\n✓ Box metrics:")
        print(f"  Commands executed: {metrics.commands_executed_total}")
        print(f"  Exec errors: {metrics.exec_errors_total}")
        print(f"  Bytes sent: {metrics.bytes_sent_total}")
        print(f"  Bytes received: {metrics.bytes_received_total}")
        print(f"  Create duration: {metrics.total_create_duration_ms} ms")
        print(f"  Boot duration: {metrics.guest_boot_duration_ms} ms")
        if metrics.cpu_percent is not None:
            print(f"  CPU usage: {metrics.cpu_percent:.2f}%")
        if metrics.memory_bytes is not None:
            print(f"  Memory: {metrics.memory_bytes / 1024 / 1024:.2f} MiB")

        box.stop()


def example_runtime_metrics():
    """Example 6: Runtime metrics."""
    print("\n\n=== Example 6: Runtime Metrics ===")

    with SyncBoxlite.default() as runtime:
        # Create and run multiple boxes
        boxes = []
        for i in range(2):
            box = runtime.create(boxlite.BoxOptions(image="alpine:latest"))
            boxes.append(box)
            print(f"✓ Box {i + 1} created: {box.id}")

            # Execute a command
            execution = box.exec("echo", [f"Box {i + 1}"])
            stdout = execution.stdout()
            for line in stdout:
                pass  # Consume output
            execution.wait()

        # Get runtime metrics
        metrics = runtime.metrics()
        print(f"\n✓ Runtime metrics:")
        print(f"  Total boxes created: {metrics.boxes_created_total}")
        print(f"  Failed boxes: {metrics.boxes_failed_total}")
        print(f"  Running boxes: {metrics.num_running_boxes}")
        print(f"  Total commands: {metrics.total_commands_executed}")
        print(f"  Total errors: {metrics.total_exec_errors}")

        # Cleanup
        for box in boxes:
            box.stop()
        print("\n✓ All boxes shut down")


def example_list_and_info():
    """Example 7: Listing and getting box info."""
    print("\n\n=== Example 7: List and Get Info ===")

    with SyncBoxlite.default() as runtime:
        # Create multiple boxes
        boxes = []
        ts = int(time.time())
        for i in range(3):
            box = runtime.create(
                boxlite.BoxOptions(image="alpine:latest"),
                name=f"test-box-{ts}-{i}"
            )
            boxes.append(box)
            print(f"✓ Box {i + 1} created: {box.id}")

        # List all boxes
        all_boxes = runtime.list_info()
        print(f"\n✓ Total boxes: {len(all_boxes)}")
        for info in all_boxes[-3:]:  # Show last 3
            print(f"  - {info.id}: {info.state} ({info.image})")

        # Get specific box info
        if boxes:
            info = boxes[0].info()
            print(f"\n✓ Box info for {boxes[0].id}:")
            print(f"  State: {info.state}")
            print(f"  Image: {info.image}")
            print(f"  CPUs: {info.cpus}")
            print(f"  Memory: {info.memory_mib} MiB")

        # Cleanup - shutdown boxes
        for box in boxes:
            box.stop()
            print(f"✓ Stopped box: {box.id}")


def example_execution_kill():
    """Example 8: Kill running execution."""
    print("\n\n=== Example 8: Kill Execution ===")

    with SyncBoxlite.default() as runtime:
        box = runtime.create(boxlite.BoxOptions(image="alpine:latest"))
        print(f"✓ Box created: {box.id}")

        # Start a long-running command
        execution = box.exec("sh", ["-c", "sleep 100; echo done"])
        exec_id = execution.id
        print(f"✓ Started long-running execution: {str(exec_id)}")

        # Wait a bit (sync sleep)
        time.sleep(0.5)

        # Kill the execution
        execution.kill()
        print("✓ Execution killed")

        # Wait for exit
        exec_result = execution.wait()
        print(f"✓ Exit code after kill: {exec_result.exit_code}")

        box.stop()


def example_context_manager():
    """Example 9: Using Box as context manager."""
    print("\n\n=== Example 9: Context Manager ===")

    with SyncBoxlite.default() as runtime:
        # Box automatically shuts down when exiting context
        box = runtime.create(boxlite.BoxOptions(image="alpine:latest"))

        with box:  # Uses __enter__/__exit__
            print(f"✓ Box created in context: {box.id}")

            execution = box.exec("echo", ["Hello from context manager"])
            stdout = execution.stdout()

            for line in stdout:
                print(f"  {line.strip()}")

            exec_result = execution.wait()
            print(f"✓ Execution completed: code={exec_result.exit_code}")

        print("✓ Box automatically shut down on context exit")


def example_working_directory():
    """Example 10: Working directory and port mappings."""
    print("\n\n=== Example 10: Working Directory & Ports ===")

    with SyncBoxlite.default() as runtime:
        box = runtime.create(boxlite.BoxOptions(
            image="alpine:latest",
            working_dir="/tmp",
            ports=[(8080, 80)]  # host:container
        ))
        print(f"✓ Box created: {box.id}")

        # Verify working directory
        execution = box.exec("pwd", None, None)
        stdout = execution.stdout()

        print("\nWorking directory:")
        for line in stdout:
            print(f"  {line.strip()}")

        execution.wait()

        # Get box info to see port mappings
        info = box.info()
        print(f"✓ Box configuration verified")

        box.stop()


def example_manual_start_stop():
    """Example 11: Manual start/stop (non-context-manager usage)."""
    print("\n\n=== Example 11: Manual Start/Stop ===")

    # This pattern is useful for:
    # - REPL/interactive sessions
    # - Test fixtures (setup/teardown)
    # - Class-based lifecycle management
    # - Long-running services

    # Start runtime manually (instead of using 'with')
    runtime = SyncBoxlite.default().start()
    print(f"✓ Runtime started: {runtime}")

    try:
        # Create and use boxes as normal
        box = runtime.create(boxlite.BoxOptions(image="alpine:latest"))
        print(f"✓ Box created: {box.id}")

        execution = box.exec("echo", ["Hello from manual start/stop!"])
        stdout = execution.stdout()

        print("Output:")
        for line in stdout:
            print(f"  {line.strip()}")

        execution.wait()
        box.stop()
        print("✓ Box stopped")

    finally:
        # Must call stop() to clean up dispatcher fiber
        runtime.stop()
        print("✓ Runtime stopped")


def example_class_based_usage():
    """Example 12: Class-based usage pattern."""
    print("\n\n=== Example 12: Class-Based Usage ===")

    class SandboxManager:
        """Example of class-based lifecycle management."""

        def __init__(self):
            self._runtime = None
            self._box = None

        def start(self, image: str = "alpine:latest"):
            """Initialize runtime and create a box."""
            self._runtime = SyncBoxlite.default().start()
            self._box = self._runtime.create(boxlite.BoxOptions(image=image))
            print(f"✓ SandboxManager started with box: {self._box.id}")

        def run_command(self, cmd: str, args: list = None) -> str:
            """Run a command in the sandbox."""
            if not self._box:
                raise RuntimeError("SandboxManager not started")

            execution = self._box.exec(cmd, args)
            stdout = execution.stdout()
            output = "".join(line for line in stdout)
            execution.wait()
            return output.strip()

        def stop(self):
            """Clean up resources."""
            if self._box:
                self._box.stop()
                self._box = None
            if self._runtime:
                self._runtime.stop()
                self._runtime = None
            print("✓ SandboxManager stopped")

    # Use the class
    manager = SandboxManager()
    try:
        manager.start()
        result = manager.run_command("echo", ["Hello from SandboxManager!"])
        print(f"Output: {result}")
        result = manager.run_command("uname", ["-a"])
        print(f"System: {result}")
    finally:
        manager.stop()


def main():
    """Run all sync native API examples."""
    print("Sync Native Box API Examples - Low-Level Rust FFI Layer")
    print("=" * 60)

    example_default_runtime()
    example_custom_runtime()
    example_streaming_execution()
    example_environment_variables()
    example_box_metrics()
    example_runtime_metrics()
    example_list_and_info()
    example_execution_kill()
    example_context_manager()
    example_working_directory()
    example_manual_start_stop()
    example_class_based_usage()

    print("\n" + "=" * 60)
    print("✓ All sync native API examples completed!")
    print("\nKey Takeaways:")
    print("  • SyncBoxlite.default() returns SyncBoxlite (mirrors Boxlite.default())")
    print("  • runtime.create() returns SyncBox (mirrors runtime.create())")
    print("  • box.exec() returns SyncExecution (same API, no await)")
    print("  • Separate stdout/stderr streams with sync iteration")
    print("  • Comprehensive metrics (runtime and per-box)")
    print("  • List/get_info for box management")
    print("  • Context manager for automatic cleanup")
    print("  • Manual start()/stop() for REPL and class-based usage")
    print("  • Full control over resources (CPU, memory, env, ports)")


if __name__ == "__main__":
    main()
