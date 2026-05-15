"""Credential abstraction for the BoxLite REST client.

`Credential` is an abstract base class. Concrete credentials are
implemented in the native extension (PyO3 classes can't inherit a
Python ABC across the FFI boundary), so they are registered as
*virtual subclasses* via ``abc.register``.

The practical effect: ``isinstance(ApiKeyCredential(k), Credential)``
is ``True``, and a future ``OAuthCredential`` registers the same way —
callers type against ``Credential`` and never change.
"""

from abc import ABC, abstractmethod

from .boxlite import AccessToken, ApiKeyCredential


class Credential(ABC):
    """Base class for credentials accepted by ``Boxlite.rest()``."""

    @abstractmethod
    def get_token(self) -> "AccessToken":
        """Return the current bearer token plus its expiry."""
        raise NotImplementedError


# Make the native ApiKeyCredential a nominal member of the Credential
# hierarchy without inheritance.
Credential.register(ApiKeyCredential)

__all__ = ["Credential", "AccessToken", "ApiKeyCredential"]
