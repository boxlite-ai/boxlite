#!/bin/sh
set -eu

# Wait briefly for minio to be reachable (defense in depth — orchestrator
# already gates this via depends_on healthcheck).
for i in 1 2 3 4 5; do
    if mc alias set boxlite "$MINIO_URL" "$MINIO_USER" "$MINIO_PASSWORD" 2>/dev/null; then
        break
    fi
    echo "init: minio not ready yet (attempt $i)"
    sleep 2
done

mc alias set boxlite "$MINIO_URL" "$MINIO_USER" "$MINIO_PASSWORD"

# Create the default bucket idempotently — --ignore-existing makes mc mb a no-op
# if the bucket already exists.
mc mb --ignore-existing boxlite/boxlite

echo "init: ok — boxlite bucket ready"
