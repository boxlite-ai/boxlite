## TL;DR

Runner DinD now passes real Docker and Compose acceptance with the rebuilt guest firmware.

## Details

See [Docker-in-Docker](docker-in-docker.md) for the supported configuration,
build commands, SDK usage and acceptance entrypoints. The
[qualification report](../contributing/investigations/2026-10-22-f1-dind-qualification.md)
records D1/D2 evidence and the earlier failures. Swarm and Docker cache reuse
require their separate acceptance suites.
