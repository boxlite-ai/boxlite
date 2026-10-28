"""Configure validated cloud CI identities without printing credentials."""
import json
import os
from pathlib import Path
import sys
import tempfile
from urllib.parse import urlsplit

from lib.e2e_auth import api_key_permissions, credentials_path, discover_path_prefix


def configure(stage: str, url: str, environment, destination: Path) -> None:
    if stage not in ("dev", "prod"):
        raise RuntimeError("stage must be dev or prod")
    target = urlsplit(url)
    if (target.scheme != "https" or not target.hostname or target.username or
            target.password or target.query or target.fragment):
        raise RuntimeError("API_URL must be an HTTPS API base URL without credentials, query or fragment")
    names = {"p1": f"BOXLITE_{stage.upper()}_API_KEY"}
    if stage == "dev":
        names.update(p2="BOXLITE_DEV_P2_API_KEY", p2_readonly="BOXLITE_DEV_P2_READONLY_API_KEY")
    for secret in names.values():
        if not environment.get(secret):
            raise RuntimeError(f"Secret {secret} is not set")

    profiles = {}
    for name, secret in names.items():
        key = environment[secret]
        if any(ord(char) < 32 for char in key):
            raise RuntimeError(f"Secret {secret} contains invalid control characters")
        try:
            prefix = discover_path_prefix(url, key)
            permissions = api_key_permissions(url, key)
        except RuntimeError as exc:
            raise RuntimeError(f"{name} ({secret}): {exc}") from None
        if not isinstance(prefix, str) or not prefix:
            raise RuntimeError(f"{name}: /v1/me must return a nonempty organization path_prefix")
        if name == "p2_readonly":
            if any(not permission.startswith("read:") for permission in permissions):
                raise RuntimeError("p2_readonly must have only read permissions or none")
        elif not {"write:boxes", "delete:boxes"} <= permissions:
            raise RuntimeError(f"{name} requires write:boxes and delete:boxes")
        profiles[name] = dict(url=url.rstrip("/"), api_key=key, auth_method="api_key", path_prefix=prefix)

    if stage == "dev":
        if profiles["p1"]["path_prefix"] == profiles["p2"]["path_prefix"]:
            raise RuntimeError("p1 and p2 must belong to different organizations")
        if profiles["p2"]["path_prefix"] != profiles["p2_readonly"]["path_prefix"]:
            raise RuntimeError("p2 and p2_readonly must belong to the same organization")

    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".credentials-", dir=destination.parent)
    try:
        with os.fdopen(fd, "w") as output:
            for name, profile in profiles.items():
                output.write(f"[profiles.{name}]\n")
                for field, value in profile.items():
                    output.write(f"{field} = {json.dumps(value)}\n")
                output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, destination)
    finally:
        Path(temporary).unlink(missing_ok=True)
    print(f"Configured {stage} profiles: {', '.join(profiles)}")


if __name__ == "__main__":
    try:
        configure(os.environ.get("STAGE", ""), os.environ.get("API_URL", ""), os.environ, credentials_path())
    except (RuntimeError, OSError, ValueError) as exc:
        message = str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__
        sys.exit(f"Cloud profile setup failed: {message}")
