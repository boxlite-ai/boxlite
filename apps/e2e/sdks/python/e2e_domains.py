"""One domain operation through either public Python API."""

import asyncio
import json
import os
import sys

import boxlite


def domain(value):
    assert not hasattr(value, "name"), "obsolete short name field is present"
    target = value.target
    return {
        "hostname": value.hostname,
        "url": value.url,
        "target": None
        if target is None
        else {
            "type": target.type,
            "box": target.box,
            "port": target.port,
        },
    }


def normalize(value, action):
    if action == "unbind":
        assert value == (), f"unbind returned {value!r}, expected ()"
        return {}
    if action == "list":
        return {
            "domains": [domain(d) for d in value.domains],
            "limit": value.limit,
            "used": value.used,
            "remaining": value.remaining,
            "min_length": value.min_length,
        }
    return domain(value)


def main():
    mode, action, *args = sys.argv[1:]
    options = boxlite.BoxliteRestOptions(
        url=os.environ["BOXLITE_E2E_URL"],
        credential=boxlite.ApiKeyCredential(os.environ["BOXLITE_E2E_API_KEY"]),
        path_prefix=os.environ["BOXLITE_E2E_PREFIX"],
    )

    def operation(domains):
        if action == "list":
            return domains.list()
        if action == "unbind":
            return domains.unbind(args[0])
        assert action == "bind", "unknown operation"
        return domains.bind(
            args[0],
            boxlite.DomainTarget(
                type="box",
                box=os.environ["BOXLITE_E2E_BOX"],
                port=int(args[1]),
            ),
        )

    async def run_async():
        runtime = boxlite.Boxlite.rest(options)
        try:
            return normalize(await operation(runtime.domains), action)
        finally:
            runtime.close()

    if mode == "sync":
        with boxlite.SyncBoxlite.rest(options) as runtime:
            result = normalize(operation(runtime.domains), action)
    else:
        result = asyncio.run(run_async())
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except boxlite.BoxliteError as exc:
        print(f"{type(exc).__name__}: {exc}", file=sys.stderr)
        sys.exit(1)
