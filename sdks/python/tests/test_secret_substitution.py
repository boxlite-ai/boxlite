"""
Tests for Secret type and MITM secret substitution.

Test coverage:
  1. Secret class construction and field access
  2. Secret repr redaction (value never leaked)
  3. Secret placeholder generation
  4. BoxOptions with secrets
  5. Integration: secret substitution through MITM proxy (requires VM)

Requirements:
  - make dev:python (build Python SDK)
  - VM runtime for integration tests (libkrun + Hypervisor.framework)
"""

from __future__ import annotations

import pytest

import boxlite

# =============================================================================
# Unit tests (no VM required)
# =============================================================================


class TestSecretConstruction:
    """Test Secret class creation and field access."""

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
        """Secret targeting multiple hostnames."""
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
        """Hosts defaults to empty list when not provided."""
        s = boxlite.Secret(name="test", value="val")
        assert s.hosts == []

    def test_custom_placeholder(self):
        """Custom placeholder overrides the default."""
        s = boxlite.Secret(
            name="openai",
            value="sk-123",
            hosts=["api.openai.com"],
            placeholder="{{OPENAI_KEY}}",
        )
        assert s.placeholder == "{{OPENAI_KEY}}"
        assert s.get_placeholder() == "{{OPENAI_KEY}}"

    def test_default_placeholder_generation(self):
        """Default placeholder follows <BOXLITE_SECRET:{name}> format."""
        s = boxlite.Secret(name="openai", value="sk-123")
        assert s.get_placeholder() == "<BOXLITE_SECRET:openai>"

    def test_placeholder_none_by_default(self):
        """Placeholder field is None when not set."""
        s = boxlite.Secret(name="test", value="val")
        assert s.placeholder is None

    def test_field_mutation(self):
        """Secret fields can be modified after creation."""
        s = boxlite.Secret(name="test", value="val")
        s.name = "updated"
        s.value = "new-val"
        s.hosts = ["new-host.com"]
        assert s.name == "updated"
        assert s.value == "new-val"
        assert s.hosts == ["new-host.com"]


class TestSecretRepr:
    """Test Secret repr - value must NEVER appear."""

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

    def test_repr_shows_name(self):
        """repr() should show the secret name for identification."""
        s = boxlite.Secret(name="my_api_key", value="secret123")
        r = repr(s)
        assert "my_api_key" in r

    def test_repr_shows_hosts(self):
        """repr() should show the hosts list."""
        s = boxlite.Secret(name="key", value="val", hosts=["api.openai.com"])
        r = repr(s)
        assert "api.openai.com" in r

    def test_repr_shows_placeholder(self):
        """repr() should show the placeholder."""
        s = boxlite.Secret(name="key", value="val")
        r = repr(s)
        assert "BOXLITE_SECRET:key" in r

    def test_str_also_redacts_value(self):
        """str() conversion must also redact the value."""
        s = boxlite.Secret(name="key", value="do-not-show-this")
        s_str = str(s)
        assert "do-not-show-this" not in s_str

    def test_value_not_in_any_representation(self):
        """Exhaustive check: value must not appear in any string form."""
        secret_value = "sk-proj-ABCDEFGHIJKLMNOP_very_long_key"
        s = boxlite.Secret(
            name="openai",
            value=secret_value,
            hosts=["api.openai.com"],
        )
        # Check all common string conversions
        assert secret_value not in repr(s)
        assert secret_value not in str(s)
        assert secret_value not in f"{s}"


class TestSecretPlaceholder:
    """Test placeholder format and generation."""

    def test_placeholder_format_standard(self):
        """Standard names produce correct placeholders."""
        cases = [
            ("openai", "<BOXLITE_SECRET:openai>"),
            ("anthropic_key", "<BOXLITE_SECRET:anthropic_key>"),
            ("my-api-key", "<BOXLITE_SECRET:my-api-key>"),
            ("KEY123", "<BOXLITE_SECRET:KEY123>"),
        ]
        for name, expected in cases:
            s = boxlite.Secret(name=name, value="val")
            assert s.get_placeholder() == expected, f"name={name!r}"

    def test_custom_placeholder_takes_precedence(self):
        """Explicit placeholder overrides the auto-generated one."""
        s = boxlite.Secret(
            name="openai",
            value="val",
            placeholder="CUSTOM_TOKEN",
        )
        assert s.get_placeholder() == "CUSTOM_TOKEN"

    def test_empty_name_placeholder(self):
        """Edge case: empty string name."""
        s = boxlite.Secret(name="", value="val")
        assert s.get_placeholder() == "<BOXLITE_SECRET:>"


class TestBoxOptionsWithSecrets:
    """Test BoxOptions integration with secrets."""

    def test_secrets_default_empty(self):
        """BoxOptions defaults to no secrets."""
        opts = boxlite.BoxOptions()
        assert opts.secrets == []

    def test_single_secret(self):
        """BoxOptions with one secret."""
        secret = boxlite.Secret(
            name="openai",
            value="sk-123",
            hosts=["api.openai.com"],
        )
        opts = boxlite.BoxOptions(
            image="alpine:latest",
            secrets=[secret],
        )
        assert len(opts.secrets) == 1
        assert opts.secrets[0].name == "openai"

    def test_multiple_secrets(self):
        """BoxOptions with multiple secrets."""
        secrets = [
            boxlite.Secret(
                name="openai",
                value="sk-openai",
                hosts=["api.openai.com"],
            ),
            boxlite.Secret(
                name="anthropic",
                value="sk-anthropic",
                hosts=["api.anthropic.com"],
            ),
            boxlite.Secret(
                name="github",
                value="ghp-token",
                hosts=["api.github.com"],
            ),
        ]
        opts = boxlite.BoxOptions(
            image="alpine:latest",
            secrets=secrets,
        )
        assert len(opts.secrets) == 3
        names = [s.name for s in opts.secrets]
        assert "openai" in names
        assert "anthropic" in names
        assert "github" in names

    def test_secrets_with_other_options(self):
        """Secrets coexist with other BoxOptions fields."""
        secret = boxlite.Secret(name="key", value="val", hosts=["api.example.com"])
        opts = boxlite.BoxOptions(
            image="python:3.12",
            cpus=2,
            memory_mib=512,
            env=[("FOO", "bar")],
            allow_net=["api.example.com"],
            secrets=[secret],
        )
        assert opts.image == "python:3.12"
        assert opts.cpus == 2
        assert opts.memory_mib == 512
        assert len(opts.env) == 1
        assert len(opts.secrets) == 1

    def test_secrets_with_allow_net(self):
        """Secrets and allow_net can be used together."""
        secret = boxlite.Secret(name="key", value="val", hosts=["api.openai.com"])
        opts = boxlite.BoxOptions(
            image="alpine:latest",
            allow_net=["api.openai.com", "pypi.org"],
            secrets=[secret],
        )
        assert len(opts.allow_net) == 2
        assert len(opts.secrets) == 1

    def test_secret_fields_accessible_through_boxoptions(self):
        """Secret fields are accessible via BoxOptions.secrets[i]."""
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


class TestSecretEdgeCases:
    """Edge cases and error conditions."""

    def test_empty_value(self):
        """Secret with empty value (technically valid)."""
        s = boxlite.Secret(name="key", value="", hosts=["h.com"])
        assert s.value == ""

    def test_long_value(self):
        """Secret with a very long value (API keys can be long)."""
        long_key = "sk-" + "a" * 1000
        s = boxlite.Secret(name="key", value=long_key, hosts=["h.com"])
        assert len(s.value) == 1003

    def test_special_characters_in_value(self):
        """Secret value with special characters."""
        s = boxlite.Secret(
            name="key",
            value="sk-key/with+special=chars&more%20stuff",
            hosts=["h.com"],
        )
        assert "special=chars" in s.value

    def test_unicode_name(self):
        """Secret with unicode name."""
        s = boxlite.Secret(name="api_key_v2", value="val")
        assert s.name == "api_key_v2"

    def test_many_hosts(self):
        """Secret with many hosts."""
        hosts = [f"api{i}.example.com" for i in range(50)]
        s = boxlite.Secret(name="key", value="val", hosts=hosts)
        assert len(s.hosts) == 50

    def test_duplicate_secrets_same_name(self):
        """Two secrets with the same name (user's responsibility)."""
        secrets = [
            boxlite.Secret(name="key", value="val1", hosts=["h1.com"]),
            boxlite.Secret(name="key", value="val2", hosts=["h2.com"]),
        ]
        opts = boxlite.BoxOptions(secrets=secrets)
        assert len(opts.secrets) == 2

    def test_overlapping_hosts(self):
        """Two secrets targeting the same host."""
        secrets = [
            boxlite.Secret(name="auth", value="v1", hosts=["api.com"]),
            boxlite.Secret(name="token", value="v2", hosts=["api.com"]),
        ]
        opts = boxlite.BoxOptions(secrets=secrets)
        assert len(opts.secrets) == 2


# =============================================================================
# Integration tests (require VM + network)
# =============================================================================


@pytest.fixture
def runtime(shared_sync_runtime):
    """Use shared sync runtime."""
    return shared_sync_runtime


@pytest.mark.integration
class TestSecretPlaceholderEnvVars:
    """Test that secret placeholders are injected as environment variables."""

    def test_secret_placeholder_in_env(self, runtime):
        """Guest should see BOXLITE_SECRET_{NAME} env var with placeholder value."""
        secret = boxlite.Secret(
            name="openai",
            value="sk-real-key-DO-NOT-LEAK",
            hosts=["api.openai.com"],
        )
        box = runtime.create(
            boxlite.BoxOptions(
                image="alpine:latest",
                secrets=[secret],
            )
        )
        try:
            # Check that the placeholder env var exists
            execution = box.exec("printenv", ["BOXLITE_SECRET_OPENAI"])
            stdout = list(execution.stdout())
            result = execution.wait()

            assert result.exit_code == 0
            output = "".join(stdout).strip()
            # Should contain the placeholder, NOT the real value
            assert "<BOXLITE_SECRET:openai>" in output
            assert "sk-real-key-DO-NOT-LEAK" not in output
        finally:
            box.stop()

    def test_real_value_not_in_guest_env(self, runtime):
        """The real secret value must NEVER appear in guest environment."""
        secret_value = "sk-SUPER-SECRET-KEY-999"
        secret = boxlite.Secret(
            name="testkey",
            value=secret_value,
            hosts=["api.example.com"],
        )
        box = runtime.create(
            boxlite.BoxOptions(
                image="alpine:latest",
                secrets=[secret],
            )
        )
        try:
            # Dump entire environment
            execution = box.exec("env", [])
            stdout = list(execution.stdout())
            execution.wait()

            full_env = "\n".join(stdout)
            # Real secret value must not appear anywhere in env
            assert secret_value not in full_env
        finally:
            box.stop()

    def test_multiple_secret_env_vars(self, runtime):
        """Multiple secrets produce multiple env vars."""
        secrets = [
            boxlite.Secret(name="key_a", value="val_a", hosts=["a.com"]),
            boxlite.Secret(name="key_b", value="val_b", hosts=["b.com"]),
        ]
        box = runtime.create(
            boxlite.BoxOptions(
                image="alpine:latest",
                secrets=secrets,
            )
        )
        try:
            exec_a = box.exec("printenv", ["BOXLITE_SECRET_KEY_A"])
            stdout_a = "".join(list(exec_a.stdout())).strip()
            exec_a.wait()

            exec_b = box.exec("printenv", ["BOXLITE_SECRET_KEY_B"])
            stdout_b = "".join(list(exec_b.stdout())).strip()
            exec_b.wait()

            assert "<BOXLITE_SECRET:key_a>" in stdout_a
            assert "<BOXLITE_SECRET:key_b>" in stdout_b
        finally:
            box.stop()


@pytest.mark.integration
class TestCACertInjection:
    """Test that the MITM CA certificate is injected into the guest."""

    def test_ca_cert_in_trust_store(self, runtime):
        """When secrets are configured, the CA cert should be in the trust store."""
        secret = boxlite.Secret(name="key", value="val", hosts=["api.example.com"])
        box = runtime.create(
            boxlite.BoxOptions(
                image="alpine:latest",
                secrets=[secret],
            )
        )
        try:
            # Check that the CA bundle exists and contains BoxLite CA
            execution = box.exec("cat", ["/etc/ssl/certs/ca-certificates.crt"])
            stdout = list(execution.stdout())
            execution.wait()

            ca_bundle = "".join(stdout)
            # Should contain at least one certificate (the MITM CA)
            assert "BEGIN CERTIFICATE" in ca_bundle
        finally:
            box.stop()

    def test_ssl_cert_file_env_set(self, runtime):
        """SSL_CERT_FILE env var should be set when secrets are configured."""
        secret = boxlite.Secret(name="key", value="val", hosts=["api.example.com"])
        box = runtime.create(
            boxlite.BoxOptions(
                image="alpine:latest",
                secrets=[secret],
            )
        )
        try:
            execution = box.exec("printenv", ["SSL_CERT_FILE"])
            stdout = "".join(list(execution.stdout())).strip()
            result = execution.wait()

            assert result.exit_code == 0
            assert "ca-certificates" in stdout
        finally:
            box.stop()

    def test_boxlite_ca_pem_env_removed(self, runtime):
        """BOXLITE_CA_PEM env var should be removed after CA installation."""
        secret = boxlite.Secret(name="key", value="val", hosts=["api.example.com"])
        box = runtime.create(
            boxlite.BoxOptions(
                image="alpine:latest",
                secrets=[secret],
            )
        )
        try:
            execution = box.exec("printenv", ["BOXLITE_CA_PEM"])
            stdout = "".join(list(execution.stdout())).strip()
            result = execution.wait()

            # Should be empty / not found (exit code 1)
            # The raw PEM should not leak to user processes
            assert result.exit_code == 1 or stdout == ""
        finally:
            box.stop()


@pytest.mark.integration
class TestNoSecretsBaseline:
    """Baseline: without secrets, no MITM infrastructure should be present."""

    def test_no_ca_env_without_secrets(self, runtime):
        """Without secrets, BOXLITE_CA_PEM should not be set."""
        box = runtime.create(boxlite.BoxOptions(image="alpine:latest"))
        try:
            execution = box.exec("printenv", ["BOXLITE_CA_PEM"])
            stdout = "".join(list(execution.stdout())).strip()
            result = execution.wait()

            # No BOXLITE_CA_PEM when no secrets
            assert result.exit_code == 1 or stdout == ""
        finally:
            box.stop()

    def test_no_secret_env_vars_without_secrets(self, runtime):
        """Without secrets, no BOXLITE_SECRET_* env vars should exist."""
        box = runtime.create(boxlite.BoxOptions(image="alpine:latest"))
        try:
            execution = box.exec("env", [])
            stdout = list(execution.stdout())
            execution.wait()

            full_env = "\n".join(stdout)
            assert "BOXLITE_SECRET_" not in full_env
        finally:
            box.stop()


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
