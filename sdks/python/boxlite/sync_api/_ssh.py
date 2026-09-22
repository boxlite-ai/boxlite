"""Synchronous SSH control."""


class SyncSshHandle:
    def __init__(self, owner, handle):
        self._owner = owner
        self._handle = handle

    def configure(self, config):
        return self._owner._sync(self._handle.configure(config))

    def status(self):
        return self._owner._sync(self._handle.status())

    def disable(self):
        return self._owner._sync(self._handle.disable())
