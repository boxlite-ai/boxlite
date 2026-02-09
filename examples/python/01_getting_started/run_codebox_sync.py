#!/usr/bin/env python3
"""
SyncCodeBox Example - Secure Python Code Execution (Synchronous)

Synchronous version of run_codebox.py.  See that file for detailed comments.

Demonstrates running untrusted Python code safely:
- Execute arbitrary Python code in isolation
- Install packages dynamically
- Real-world use case: AI agent code execution

Requires: pip install boxlite[sync]
"""

import boxlite


def example_basic():
    """Example 1: Basic code execution."""
    print("\n=== Example 1: Basic Code Execution ===")

    with boxlite.SyncCodeBox() as codebox:
        print("CodeBox ready")

        # Execute simple code
        print("\nRunning calculation:")
        result = codebox.run("""
import math

# Calculate fibonacci sequence
def fib(n):
    if n <= 1:
        return n
    return fib(n-1) + fib(n-2)

for i in range(10):
    print(f"fib({i}) = {fib(i)}")
""")
        print(result)


def example_packages():
    """Example 2: Dynamic package installation."""
    print("\n\n=== Example 2: Package Installation ===")

    with boxlite.SyncCodeBox() as codebox:
        print("Installing requests package...")
        codebox.install_package("requests")

        print("\nMaking HTTP request:")
        result = codebox.run("""
import requests
import json

# Make request to public API
response = requests.get('https://api.github.com/zen')
print(f"GitHub Zen: {response.text}")

# Check status
print(f"Status: {response.status_code}")
""")
        print(result)


def example_data_processing():
    """Example 3: Data processing - Real AI agent scenario."""
    print("\n\n=== Example 3: Data Processing (AI Agent Use Case) ===")

    with boxlite.SyncCodeBox() as codebox:
        print("Processing dataset...")

        # Simulate AI agent writing and executing data analysis code
        result = codebox.run("""
import json
from collections import Counter

# Sample dataset (could come from AI agent)
data = {
    "transactions": [
        {"user": "alice", "amount": 100, "category": "food"},
        {"user": "bob", "amount": 250, "category": "transport"},
        {"user": "alice", "amount": 50, "category": "food"},
        {"user": "charlie", "amount": 300, "category": "entertainment"},
        {"user": "bob", "amount": 150, "category": "food"},
    ]
}

# Analysis 1: Total by user
user_totals = {}
for txn in data["transactions"]:
    user = txn["user"]
    user_totals[user] = user_totals.get(user, 0) + txn["amount"]

print("Total Spending by User:")
for user, total in sorted(user_totals.items()):
    print(f"  {user}: ${total}")

# Analysis 2: Category distribution
categories = [txn["category"] for txn in data["transactions"]]
category_counts = Counter(categories)

print("\\nSpending by Category:")
for category, count in category_counts.most_common():
    print(f"  {category}: {count} transactions")

# Analysis 3: Statistics
amounts = [txn["amount"] for txn in data["transactions"]]
print(f"\\nStatistics:")
print(f"  Average: ${sum(amounts) / len(amounts):.2f}")
print(f"  Min: ${min(amounts)}")
print(f"  Max: ${max(amounts)}")
""")
        print(result)


def example_isolation():
    """Example 4: Demonstrate isolation - unsafe code contained."""
    print("\n\n=== Example 4: Isolation Demo ===")

    with boxlite.SyncCodeBox() as codebox:
        print("Running potentially unsafe code safely...")

        # This code tries to access host system but is isolated
        result = codebox.run("""
import os
import socket

print("Container environment:")
print(f"  Hostname: {socket.gethostname()}")
print(f"  User: {os.getenv('USER', 'unknown')}")
print(f"  Home: {os.getenv('HOME', 'unknown')}")
print(f"  Writable: {os.access('/tmp', os.W_OK)}")

# Try to list root (isolated from host)
print(f"\\nRoot directory: {os.listdir('/')[:5]}...")
print("\\nAll operations contained in isolated environment")
""")
        print(result)


def main():
    """Run all examples."""
    print("SyncCodeBox Examples - Secure Python Execution (Synchronous)")
    print("=" * 60)

    example_basic()
    example_packages()
    example_data_processing()
    example_isolation()

    print("\n" + "=" * 60)
    print("All examples completed!")
    print("\nKey Takeaways:")
    print("  - SyncCodeBox runs untrusted code safely")
    print("  - Dynamic package installation")
    print("  - Perfect for AI agents executing code")
    print("  - Complete isolation from host system")
    print("  - No async/await required - uses greenlet-based sync API")


if __name__ == "__main__":
    main()
