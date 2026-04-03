"""
Tests for Secret type and MITM secret substitution.

Test coverage:
  1. PyO3 binding: Secret constructor, field access, mutation, repr
  2. BoxOptions integration: secrets coexist with other fields
  3. Integration: env var injection, CA cert, upstream substitution (requires VM)

Requirements:
  - make dev:python (build Python SDK)
  - VM runtime for integration tests (libkrun + Hypervisor.framework)
"""

from __future__ import annotations

import pytest

import boxlite

# Skip entire module if Secret class is not available (e.g., cached wheel from prior version)
if not hasattr(boxlite, "Secret"):
    pytest.skip(
        "boxlite.Secret not available (rebuild SDK with: make dev:python)",
        allow_module_level=True,
    )

# =============================================================================
# Unit tests (no VM required) — test PyO3 binding contract
# =============================================================================


class TestSecretConstruction:
    """Test Secret class creation and field access via PyO3."""

    def test_basic_creation(self):
        """Secret with all required fields."""
        s = boxlite.Secret(
            name="openai",
            value="sk-real-key-123",
            hosts=["api.openai.com"],
        )
        assert s.name == "openai"
        assert s.value == "sk-real-key-123"
        assert s.hosts == ["api.openai.com"]

    def test_multiple_hosts(self):
        """Secret targeting multiple hostnames (PyO3 Vec conversion)."""
        s = boxlite.Secret(
            name="api_key",
            value="key-123",
            hosts=["api.openai.com", "api.anthropic.com", "api.google.com"],
        )
        assert len(s.hosts) == 3
        assert "api.anthropic.com" in s.hosts

    def test_wildcard_host(self):
        """Secret with wildcard hostname pattern."""
        s = boxlite.Secret(
            name="corp_key",
            value="key-456",
            hosts=["*.internal.corp.com"],
        )
        assert s.hosts == ["*.internal.corp.com"]

    def test_empty_hosts_default(self):
        """Hosts defaults to empty list (PyO3 default parameter)."""
        s = boxlite.Secret(name="test", value="val")
        assert s.hosts == []

    def test_custom_placeholder(self):
        """Custom placeholder kwarg overrides auto-generated one."""
        s = boxlite.Secret(
            name="openai",
            value="sk-123",
            hosts=["api.openai.com"],
            placeholder="{{OPENAI_KEY}}",
        )
        assert s.placeholder == "{{OPENAI_KEY}}"
        assert s.get_placeholder() == "{{OPENAI_KEY}}"

    def test_field_mutation(self):
        """PyO3 #[pyo3(get, set)] allows field mutation."""
        s = boxlite.Secret(name="test", value="val")
        s.name = "updated"
        s.value = "new-val"
        s.hosts = ["new-host.com"]
        assert s.name == "updated"
        assert s.value == "new-val"
        assert s.hosts == ["new-host.com"]

    def test_repr_redacts_value(self):
        """repr() must not contain the actual secret value."""
        s = boxlite.Secret(
            name="openai",
            value="sk-super-secret-key-DO-NOT-LEAK",
            hosts=["api.openai.com"],
        )
        r = repr(s)
        assert "sk-super-secret-key-DO-NOT-LEAK" not in r
        assert "REDACTED" in r
        assert "openai" in r
        assert "api.openai.com" in r


class TestBoxOptionsWithSecrets:
    """Test BoxOptions integration with secrets via PyO3."""

    def test_secrets_with_other_options(self):
        """Secrets coexist with other BoxOptions fields."""
        secret = boxlite.Secret(name="key", value="val", hosts=["api.example.com"])
        opts = boxlite.BoxOptions(
            image="python:3.12",
            cpus=2,
            memory_mib=512,
            env=[("FOO", "bar")],
            network=boxlite.NetworkSpec(
                mode="enabled",
                allow_net=["api.example.com"],
            ),
            secrets=[secret],
        )
        assert opts.image == "python:3.12"
        assert opts.cpus == 2
        assert opts.memory_mib == 512
        assert len(opts.env) == 1
        assert len(opts.secrets) == 1

    def test_secrets_with_network_spec(self):
        """Secrets and NetworkSpec can be used together."""
        secret = boxlite.Secret(name="key", value="val", hosts=["api.openai.com"])
        opts = boxlite.BoxOptions(
            image="alpine:latest",
            network=boxlite.NetworkSpec(
                mode="enabled",
                allow_net=["api.openai.com", "pypi.org"],
            ),
            secrets=[secret],
        )
        assert opts.network.allow_net == ["api.openai.com", "pypi.org"]
        assert len(opts.secrets) == 1

    def test_secret_fields_accessible_through_boxoptions(self):
        """Secret fields accessible via BoxOptions.secrets[i]."""
        secret = boxlite.Secret(
            name="test",
            value="secret-value",
            hosts=["h1.com", "h2.com"],
        )
        opts = boxlite.BoxOptions(secrets=[secret])
        s = opts.secrets[0]
        assert s.name == "test"
        assert s.value == "secret-value"
        assert s.hosts == ["h1.com", "h2.com"]
        assert s.get_placeholder() == "<BOXLITE_SECRET:test>"


# =============================================================================
# Integration tests (require VM + network)
# =============================================================================


@pytest.fixture
def runtime(shared_sync_runtime):
    """Use shared sync runtime."""
    return shared_sync_runtime


@pytest.mark.integration
class TestSecretIntegration:
    """End-to-end secret substitution via MITM proxy."""

    def test_secret_env_vars_and_ca_injection(self, runtime):
        """With secrets: placeholder env vars present, real values hidden, CA cert injected."""
        secrets = [
            boxlite.Secret(
                name="key_a", value="real-val-a-DO-NOT-LEAK", hosts=["a.com"]
            ),
            boxlite.Secret(
                name="key_b", value="real-val-b-DO-NOT-LEAK", hosts=["b.com"]
            ),
        ]
        sandbox = runtime.create(
            boxlite.BoxOptions(image="alpine:latest", secrets=secrets)
        )
        try:
            # 1. Placeholder env vars exist with correct format
            exec_a = sandbox.exec("printenv", ["BOXLITE_SECRET_KEY_A"])
            stdout_a = "".join(list(exec_a.stdout())).strip()
            exec_a.wait()
            assert "<BOXLITE_SECRET:key_a>" in stdout_a

            exec_b = sandbox.exec("printenv", ["BOXLITE_SECRET_KEY_B"])
            stdout_b = "".join(list(exec_b.stdout())).strip()
            exec_b.wait()
            assert "<BOXLITE_SECRET:key_b>" in stdout_b

            # 2. Real values NOT in env
            execution = sandbox.exec("env", [])
            full_env = "".join(list(execution.stdout()))
            execution.wait()
            assert "real-val-a-DO-NOT-LEAK" not in full_env
            assert "real-val-b-DO-NOT-LEAK" not in full_env

            # 3. CA cert in trust store
            execution = sandbox.exec("cat", ["/etc/ssl/certs/ca-certificates.crt"])
            ca_bundle = "".join(list(execution.stdout()))
            execution.wait()
            assert "BEGIN CERTIFICATE" in ca_bundle

            # 4. BOXLITE_CA_PEM not leaked to container processes
            execution = sandbox.exec("printenv", ["BOXLITE_CA_PEM"])
            ca_pem = "".join(list(execution.stdout())).strip()
            result = execution.wait()
            assert result.exit_code == 1 or ca_pem == ""
        finally:
            sandbox.stop()

    def test_no_secret_baseline(self, runtime):
        """Without secrets: no BOXLITE_SECRET_* env vars, no CA injection."""
        sandbox = runtime.create(boxlite.BoxOptions(image="alpine:latest"))
        try:
            execution = sandbox.exec("env", [])
            full_env = "".join(list(execution.stdout()))
            execution.wait()

            assert "BOXLITE_SECRET_" not in full_env
            assert "BOXLITE_CA_PEM" not in full_env
        finally:
            sandbox.stop()

    def test_secret_substitution_reaches_upstream(self, runtime):
        """The real secret value reaches the upstream endpoint (the whole point of MITM).

        Guest curls an HTTPS echo service with the placeholder in Authorization.
        The MITM proxy substitutes the real value before it reaches the server.
        The echo service reflects the headers back, so the guest sees the real value
        in the response — proving substitution happened at the network boundary.
        """
        real_value = "sk-test-real-key-12345"
        secret = boxlite.Secret(
            name="testkey",
            value=real_value,
            hosts=["httpbin.org"],
        )
        sandbox = runtime.create(
            boxlite.BoxOptions(
                image="alpine:latest",
                network=boxlite.NetworkSpec(
                    mode="enabled",
                    allow_net=["httpbin.org"],
                ),
                secrets=[secret],
            )
        )
        try:
            # Guest sends placeholder in header; MITM substitutes real value;
            # httpbin.org echoes it back in JSON response.
            execution = sandbox.exec(
                "wget",
                [
                    "-q",
                    "-O-",
                    "--header",
                    "Authorization: Bearer <BOXLITE_SECRET:testkey>",
                    "https://httpbin.org/headers",
                ],
            )
            stdout = "".join(list(execution.stdout()))
            result = execution.wait()

            assert result.exit_code == 0, f"wget failed: {stdout}"
            # The echoed Authorization header should contain the REAL value,
            # not the placeholder — proving MITM substitution worked.
            assert real_value in stdout, (
                f"Real secret not in upstream response. "
                f"MITM substitution may not be working. Got: {stdout[:500]}"
            )
            assert "<BOXLITE_SECRET:testkey>" not in stdout, (
                "Placeholder leaked to upstream — MITM did not substitute"
            )
        finally:
            sandbox.stop()

    def test_non_secret_host_not_intercepted(self, runtime):
        """HTTP to a host NOT in any secret's hosts list works without MITM.

        Uses HTTP (not HTTPS) to avoid TLS complications with BusyBox wget.
        The key assertion: non-secret traffic is not blocked or broken.
        """
        secret = boxlite.Secret(
            name="key",
            value="val",
            hosts=["api.openai.com"],  # only openai is MITM'd
        )
        sandbox = runtime.create(
            boxlite.BoxOptions(
                image="alpine:latest",
                network=boxlite.NetworkSpec(
                    mode="enabled",
                    allow_net=["httpbin.org"],
                ),
                secrets=[secret],
            )
        )
        try:
            # httpbin.org is NOT in secret hosts — should work normally
            execution = sandbox.exec(
                "wget",
                ["-q", "-O-", "http://httpbin.org/ip"],
            )
            stdout = "".join(list(execution.stdout()))
            result = execution.wait()

            assert result.exit_code == 0, (
                f"Non-secret host request failed — traffic may be broken. "
                f"Output: {stdout[:500]}"
            )
            assert "origin" in stdout, (
                f"Expected JSON with 'origin', got: {stdout[:200]}"
            )
        finally:
            sandbox.stop()


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
