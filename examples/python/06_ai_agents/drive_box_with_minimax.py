#!/usr/bin/env python3
"""
MiniMax-Driven SimpleBox Example

Demonstrates how to let a MiniMax LLM explore a sandbox via tool calls:
- Create a SimpleBox sandbox
- Expose a sandbox_exec tool to run commands
- Let the model decide which commands to run
- Print a human-readable report

MiniMax uses an OpenAI-compatible API, so we reuse the openai SDK
with a custom base_url pointing to MiniMax's endpoint.

Supported models:
- MiniMax-M2.7              (default) — Latest flagship with enhanced reasoning and coding.
- MiniMax-M2.7-highspeed             — High-speed version of M2.7 for low-latency scenarios.
- MiniMax-M2.5                       — Previous flagship model.
- MiniMax-M2.5-highspeed             — High-speed version of M2.5.

API docs: https://platform.minimax.io/docs/api-reference/text-openai-api
"""

import asyncio
import json
import os
from contextlib import AsyncExitStack

import boxlite
from openai import AsyncOpenAI

MINIMAX_BASE_URL = os.getenv('MINIMAX_BASE_URL', 'https://api.minimax.io/v1')
MINIMAX_DEFAULT_MODEL = 'MiniMax-M2.7'

TOOLS = [
    {
        'type': 'function',
        'function': {
            'name': 'sandbox_exec',
            'description': 'Run a command inside the sandbox and return stdout/stderr/exit_code.',
            'parameters': {
                'type': 'object',
                'properties': {
                    'argv': {
                        'type': 'array',
                        'items': {'type': 'string'},
                        'description': "Command and args, e.g. ['ls','-la'] or ['python','-c','print(123)']",
                    }
                },
                'required': ['argv'],
            },
        },
    }
]


def build_client():
    api_key = os.getenv('MINIMAX_API_KEY')
    if not api_key:
        raise RuntimeError(
            "MINIMAX_API_KEY is not set. Export it before running, e.g.: "
            "`export MINIMAX_API_KEY=sk-...`\n"
            "Get your API key at https://platform.minimax.io"
        )
    return AsyncOpenAI(api_key=api_key, base_url=MINIMAX_BASE_URL)


async def sandbox_exec(box, argv):
    """
    argv: ["ls", "-la"] / ["python", "-c", "..."]
    """
    if not argv:
        return {'stdout': '', 'stderr': 'argv is required.', 'exit_code': 2}
    result = await box.exec(*argv)
    return {
        'stdout': result.stdout,
        'stderr': result.stderr,
        'exit_code': result.exit_code,
    }


async def whip_agent(box, client, user_goal, model=None, max_rounds=12):
    model = model or os.getenv('MINIMAX_MODEL', MINIMAX_DEFAULT_MODEL)

    messages = [
        {
            'role': 'system',
            'content': (
                'You are a powerful autonomous coding assistant.\n'
                'You can plan, explain, and iterate freely.\n'
                'When you need to interact with the environment, call sandbox_exec.\n'
                'Be careful and iterative; do not run destructive commands.\n'
                'Stop when you are done and summarize.\n'
            ),
        },
        {'role': 'user', 'content': user_goal},
    ]

    print('\n[User Goal]\n', user_goal)

    for _ in range(max_rounds):
        response = await client.chat.completions.create(
            model=model,
            messages=messages,
            tools=TOOLS,
            tool_choice='auto',
            temperature=1.0,
        )

        choice = response.choices[0]
        assistant_msg = choice.message

        # Print any text content
        if assistant_msg.content:
            print('\n[LLM]\n', assistant_msg.content)

        # Append assistant message to history
        messages.append(assistant_msg.model_dump())

        # If no tool calls, we are done
        if not assistant_msg.tool_calls:
            return response

        # Execute tool calls
        call_info = '\n'.join(
            f"  -> name={call.function.name!r}, arguments={call.function.arguments!r}"
            for call in assistant_msg.tool_calls
        )
        print(f"\n[System] Executing tool calls: {call_info}")

        for call in assistant_msg.tool_calls:
            try:
                args = json.loads(call.function.arguments or '{}')
            except Exception:
                args = {}

            argv = args.get('argv', [])
            if not isinstance(argv, list):
                out = {'stdout': '', 'stderr': 'Invalid argv; expected a list of strings.', 'exit_code': 2}
            else:
                out = await sandbox_exec(box, argv)

            messages.append({
                'role': 'tool',
                'tool_call_id': call.id,
                'content': json.dumps(out),
            })

    print('[System] max_rounds reached.')
    return response


async def main():
    client = build_client()

    stack = AsyncExitStack()
    box = await stack.enter_async_context(boxlite.SimpleBox(image='python:slim'))
    try:
        await whip_agent(
            box,
            client,
            'Explore this sandbox. Show python version, installed packages, $PATH and list files. '
            'Then run a short python snippet that prints system info. '
            'Finally give a human readable report.',
        )

        await whip_agent(
            box,
            client,
            'What commands (executables) are available in this sandbox? Show them all, split by commas.',
        )
    finally:
        await stack.aclose()


if __name__ == '__main__':
    asyncio.run(main())
