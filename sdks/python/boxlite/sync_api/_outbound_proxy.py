"""Synchronous operations for the Cloud outbound proxy registry."""


class SyncOutboundProxyHandle:
    def __init__(self, registry, run) -> None:
        self._registry = registry
        self._run = run

    def list(self):
        return self._run(self._registry.list())

    def get(self, name: str):
        return self._run(self._registry.get(name))

    def create(self, name: str, url: str, credential=None):
        return self._run(self._registry.create(name, url, credential))

    def update(self, name: str, *, url=None, credential=None, clear_credential=False):
        return self._run(
            self._registry.update(
                name, url=url, credential=credential, clear_credential=clear_credential
            )
        )

    def remove(self, name: str):
        return self._run(self._registry.remove(name))
