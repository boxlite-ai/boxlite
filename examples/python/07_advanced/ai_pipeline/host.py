#!/usr/bin/env python3
"""
AI Agent Pipeline Example

Demonstrates multi-box orchestration with an AI agent pipeline pattern:
  Coder -> Reviewer -> Tester

Three agents work together in isolated VMs:
1. Coder   - Generates Python code for a given task
2. Reviewer - Reviews code, forwards to tester for validation
3. Tester  - Executes code in isolation, runs assertions

Key demonstration points:
- Ray-style decorator API (no code strings!)
- Cloudpickle serialization (closures work)
- Pipeline pattern (code flows through multiple stages)
- Nested messaging (reviewer calls tester, then responds to coder)
- Pub/Sub events (pipeline_complete broadcast to all agents)

Run with:
    python examples/python/ai_pipeline/host.py
"""

import asyncio
import logging

from boxlite.orchestration import BoxRuntime

# Enable logging to see message routing
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(message)s",
    datefmt="%H:%M:%S",
)


async def main():
    print("=" * 70)
    print("  AI Agent Pipeline Demo")
    print("  Coder -> Reviewer -> Tester")
    print("=" * 70)
    print()

    async with BoxRuntime() as runtime:
        print("[host] Creating agent boxes...")
        coder = await runtime.create_box(name="coder", memory_mib=512)
        reviewer = await runtime.create_box(name="reviewer", memory_mib=512)
        tester = await runtime.create_box(name="tester", memory_mib=512)
        print(f"[host] Created: {runtime.list_boxes()}")
        print()

        # ====================================================================
        # REVIEWER: Reviews code quality and forwards to tester
        # ====================================================================
        @reviewer.on_message
        def handle_review(sender, data):
            import sys
            from boxlite_runtime import send_message

            action = data.get("action")
            if action == "review":
                code = data.get("code", "")
                tests = data.get("tests", "")
                task = data.get("task", "unknown")

                print(
                    f"[reviewer] Reviewing code from {sender} for: {task}",
                    file=sys.stderr,
                )

                if not code.strip():
                    return {"approved": False, "reason": "Empty code"}
                if "def " not in code:
                    return {"approved": False, "reason": "No function definition found"}

                print(
                    "[reviewer] Syntax looks good, sending to tester...",
                    file=sys.stderr,
                )
                test_result = send_message(
                    "tester", {"action": "test", "code": code, "tests": tests}
                )
                print(f"[reviewer] Test result: {test_result}", file=sys.stderr)

                if test_result.get("passed"):
                    return {"approved": True, "test_output": test_result.get("output")}
                else:
                    return {
                        "approved": False,
                        "reason": f"Tests failed: {test_result.get('error')}",
                    }

            return {"error": f"Unknown action: {action}"}

        @reviewer.on_event("pipeline_complete")
        def reviewer_on_complete(data):
            import sys

            print(
                f"[reviewer] Pipeline complete: {data.get('status')}", file=sys.stderr
            )

        # ====================================================================
        # TESTER: Executes code in isolation and runs test assertions
        # ====================================================================
        @tester.on_message
        def handle_test(sender, data):
            import sys

            action = data.get("action")
            if action == "test":
                code = data.get("code", "")
                tests = data.get("tests", "")
                print(f"[tester] Running tests from {sender}...", file=sys.stderr)

                # Combine code and tests
                full_code = code + "\n" + tests

                namespace = {}
                try:
                    exec(full_code, namespace)
                    print("[tester] All tests passed!", file=sys.stderr)
                    return {"passed": True, "output": "All tests passed"}
                except AssertionError as e:
                    print(f"[tester] Test assertion failed: {e}", file=sys.stderr)
                    return {"passed": False, "error": str(e)}
                except Exception as e:
                    print(f"[tester] Execution error: {e}", file=sys.stderr)
                    return {"passed": False, "error": str(e)}

            return {"error": f"Unknown action: {action}"}

        @tester.on_event("pipeline_complete")
        def tester_on_complete(data):
            import sys

            status = data.get("status", "unknown")
            if status == "success":
                print("[tester] Pipeline succeeded!", file=sys.stderr)
            else:
                print(
                    f"[tester] Pipeline failed: {data.get('reason')}", file=sys.stderr
                )

        # ====================================================================
        # CODER: Generates code and submits for review (one-shot task)
        # ====================================================================
        @coder.task
        def coder_main():
            import sys
            from boxlite_runtime import send_message, publish_event

            print("[coder] Starting code generation agent...", file=sys.stderr)

            task = "fibonacci function"
            print(f"[coder] Generating code for: {task}", file=sys.stderr)

            # Simulated AI code generation
            generated_code = """
def fibonacci(n):
    if n <= 0:
        return 0
    elif n == 1:
        return 1
    else:
        a, b = 0, 1
        for _ in range(2, n + 1):
            a, b = b, a + b
        return b
"""

            test_code = """
assert fibonacci(0) == 0, "fib(0) should be 0"
assert fibonacci(1) == 1, "fib(1) should be 1"
assert fibonacci(10) == 55, "fib(10) should be 55"
assert fibonacci(20) == 6765, "fib(20) should be 6765"
"""

            print("[coder] Sending code to reviewer...", file=sys.stderr)
            review_result = send_message(
                "reviewer",
                {
                    "action": "review",
                    "code": generated_code,
                    "tests": test_code,
                    "task": task,
                },
            )

            print(f"[coder] Review result: {review_result}", file=sys.stderr)

            if review_result.get("approved"):
                print(
                    "[coder] Code approved! Publishing completion event.",
                    file=sys.stderr,
                )
                publish_event("pipeline_complete", {"status": "success", "task": task})
            else:
                reason = review_result.get("reason", "unknown")
                print(f"[coder] Code rejected: {reason}", file=sys.stderr)
                publish_event(
                    "pipeline_complete", {"status": "failed", "reason": reason}
                )

            print("[coder] Done!", file=sys.stderr)

        # Start agents
        print("[host] Starting receiver agents...")
        await reviewer.run()
        await tester.run()

        # Give receivers time to initialize
        await asyncio.sleep(0.5)

        print("[host] Starting coder agent (initiates pipeline)...")
        print()
        await coder.run()

        exit_code = await coder.wait()
        print()
        print(f"[host] Coder finished with exit code: {exit_code}")

        print("[host] Stopping receiver agents...")
        await reviewer.stop()
        await tester.stop()

        print()
        print("=" * 70)
        print("  Demo Complete!")
        print("=" * 70)


if __name__ == "__main__":
    asyncio.run(main())
