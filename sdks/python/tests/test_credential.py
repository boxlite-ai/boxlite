"""Tests for the Credential abstraction.

Verifies: a `Credential` ABC with `ApiKeyCredential` virtual-registered,
`get_token()` returning a redacted `AccessToken`, and `from_env()`
discovery.

Marked `integration` because these exercise the native PyO3 classes
(`boxlite.ApiKeyCredential` / `BoxliteRestOptions`); the CI unit job
does not build the extension, so native-dependent tests run in the
integration job (same convention as test_options.py / test_images.py).
"""

from __future__ import annotations

import boxlite
import pytest

pytestmark = pytest.mark.integration


def test_api_key_credential_get_token():
    cred = boxlite.ApiKeyCredential("blk_live_secret")
    tok = cred.get_token()
    assert tok.token == "blk_live_secret"
    # API keys never expire — the core fetches once and caches.
    assert tok.expires_at is None


def test_api_key_credential_repr_is_masked():
    cred = boxlite.ApiKeyCredential("super-secret")
    assert "super-secret" not in repr(cred)
    assert repr(cred) == "ApiKeyCredential(***)"


def test_access_token_repr_is_masked():
    tok = boxlite.ApiKeyCredential("leak-me").get_token()
    assert "leak-me" not in repr(tok)


def test_is_instance_of_credential_abc():
    """The whole point of the abstraction: ApiKeyCredential is a
    nominal member of the Credential hierarchy via abc.register()."""
    cred = boxlite.ApiKeyCredential("k")
    assert isinstance(cred, boxlite.Credential)
    assert issubclass(boxlite.ApiKeyCredential, boxlite.Credential)


def test_from_env_unset_returns_none(monkeypatch):
    monkeypatch.delenv("BOXLITE_API_KEY", raising=False)
    assert boxlite.ApiKeyCredential.from_env() is None


def test_from_env_set_returns_credential(monkeypatch):
    monkeypatch.setenv("BOXLITE_API_KEY", "env-key")
    cred = boxlite.ApiKeyCredential.from_env()
    assert cred is not None
    assert cred.get_token().token == "env-key"
    assert isinstance(cred, boxlite.Credential)


def test_rest_options_takes_credential():
    opts = boxlite.BoxliteRestOptions(
        url="http://localhost:8100",
        credential=boxlite.ApiKeyCredential("k"),
    )
    assert opts.url == "http://localhost:8100"
    assert "***" in repr(opts)
    assert "k" not in repr(opts).replace("localhost", "")  # no secret leak


def test_rest_options_from_env(monkeypatch):
    monkeypatch.setenv("BOXLITE_REST_URL", "http://localhost:8100")
    monkeypatch.setenv("BOXLITE_API_KEY", "env-key")
    opts = boxlite.BoxliteRestOptions.from_env()
    assert opts.url == "http://localhost:8100"
    assert opts.credential is not None
    assert opts.credential.get_token().token == "env-key"


def test_rest_options_from_env_requires_url(monkeypatch):
    monkeypatch.delenv("BOXLITE_REST_URL", raising=False)
    with pytest.raises(Exception):
        boxlite.BoxliteRestOptions.from_env()
