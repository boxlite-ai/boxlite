#!/usr/bin/env python3
"""
SyncSimpleBox Example - Foundation for Custom Containers (Synchronous)

Demonstrates core BoxLite features using SyncSimpleBox directly:
- Command execution with results
- Separate stdout and stderr handling
- Environment variables and working directory
- Error handling and exit codes
- Multiple commands in same container
- Real-world use case: Running a data processing pipeline

Requires: pip install boxlite[sync]
"""

import logging
import sys

import boxlite

logger = logging.getLogger("sync_simplebox_example")


def setup_logging():
    """Configure stdout logging for the example."""
    logging.basicConfig(
        level=logging.ERROR,
        format="%(asctime)s [%(levelname)s] %(message)s",
        handlers=[logging.StreamHandler(sys.stdout)],
    )


def example_basic():
    """Example 1: Basic command execution."""
    print("\n=== Example 1: Basic Command Execution ===")

    with boxlite.SyncSimpleBox(image="python:alpine") as box:
        print(f"Container started: {box.id}")

        # Execute command and get result
        print("\nContainer filesystem:")
        result = box.exec("ls", "-lh", "/")
        print(result.stdout)

        if result.stderr:
            print(f"Stderr: {result.stderr}")
        print(f"Exit code: {result.exit_code}")


def example_stdout_stderr():
    """Example 2: Separate stdout and stderr."""
    print("\n\n=== Example 2: Separate stdout and stderr ===")

    with boxlite.SyncSimpleBox(image="python:alpine") as box:
        print(f"Container started: {box.id}")

        # Command that produces both stdout and stderr
        print("\nRunning command with both stdout and stderr:")
        result = box.exec('sh', '-c', 'echo "to stdout" && echo "to stderr" >&2')

        print(f"Exit code: {result.exit_code}")
        print(f"Stdout: '{result.stdout.strip()}'")
        print(f"Stderr: '{result.stderr.strip()}'")


def example_environment():
    """Example 3: Environment variables."""
    print("\n\n=== Example 3: Environment Variables ===")

    with boxlite.SyncSimpleBox(image="python:alpine") as box:
        print(f"Container started: {box.id}")

        # Execute with custom environment variables
        print("\nSetting FOO=bar and BAZ=qux:")
        result = box.exec('env', env={'FOO': 'bar', 'BAZ': 'qux'})

        print(f"Exit code: {result.exit_code}")
        print("Custom environment variables:")
        for line in result.stdout.split('\n'):
            if 'FOO=' in line or 'BAZ=' in line:
                print(f"  {line}")


def example_working_directory():
    """Example 4: Working directory."""
    print("\n\n=== Example 4: Working Directory ===")

    with boxlite.SyncSimpleBox(
            image="python:alpine",
            working_dir="/tmp",
            env=[("USER", "alice"), ("PROJECT", "data-pipeline")]
    ) as box:
        print(f"Container with custom config: {box.id}")

        # Check working directory
        print("\nCurrent directory:")
        result = box.exec("pwd")
        print(f"  {result.stdout.strip()}")

        # Check environment
        print("\nEnvironment variables:")
        result = box.exec("env")
        for line in result.stdout.split('\n'):
            if "USER=" in line or "PROJECT=" in line:
                print(f"  {line}")


def example_error_handling():
    """Example 5: Error handling."""
    print("\n\n=== Example 5: Error Handling ===")

    with boxlite.SyncSimpleBox(image="python:alpine") as box:
        print(f"Container started: {box.id}")

        # Command that fails
        print("\nRunning command that fails:")
        result = box.exec('false')

        if result.exit_code != 0:
            print(f"Command failed as expected with exit code: {result.exit_code}")
        else:
            print("Command succeeded")

        # Command that succeeds
        print("\nRunning command that succeeds:")
        result = box.exec('true')

        if result.exit_code == 0:
            print(f"Command succeeded with exit code: {result.exit_code}")
        else:
            print(f"Command failed with exit code: {result.exit_code}")


def example_pipeline():
    """Example 6: Real-world data processing pipeline."""
    print("\n\n=== Example 6: Data Processing Pipeline ===")

    with boxlite.SyncSimpleBox(image="python:alpine") as box:
        print(f"Running data pipeline in: {box.id}")

        # Step 1: Generate sample data
        print("\n1. Generating sample data...")
        result = box.exec(
            "python", "-c",
            "import json; data = [{'id': i, 'value': i*2} for i in range(5)]; "
            "print(json.dumps(data, indent=2))"
        )
        print(result.stdout)

        # Step 2: Process data with transformation
        print("2. Processing data...")
        result = box.exec(
            "python", "-c",
            "import json; data = [{'id': i, 'value': i*2} for i in range(5)]; "
            "total = sum(item['value'] for item in data); "
            "print(f'Total: {total}')"
        )
        print(result.stdout)

        # Step 3: Verify system resources
        print("3. Container resources:")
        result = box.exec("free", "-h")
        print(result.stdout)


def main():
    """Run all examples."""
    print("SyncSimpleBox Examples - Foundation for Custom Containers (Synchronous)")
    print("=" * 60)

    example_basic()
    example_stdout_stderr()
    example_environment()
    example_working_directory()
    example_error_handling()
    example_pipeline()

    print("\n" + "=" * 60)
    print("All examples completed!")
    print("\nKey Takeaways:")
    print("  - Simple exec() API returns ExecResult with exit_code, stdout, stderr")
    print("  - Stdout and stderr are separated for clarity")
    print("  - Environment variables can be set per-exec or per-box")
    print("  - Working directory can be customized")
    print("  - Exit codes enable proper error handling")
    print("  - No async/await required - uses greenlet-based sync API")


if __name__ == "__main__":
    setup_logging()
    logger.info("Python logging configured; runtime logs will emit to stdout.")
    main()
