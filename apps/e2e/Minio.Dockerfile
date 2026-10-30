FROM scratch
ARG MINIO_RELEASE
ENV HOME=/data
LABEL org.opencontainers.image.title="MinIO for BoxLite E2E" \
      org.opencontainers.image.version="${MINIO_RELEASE}" \
      org.opencontainers.image.source="https://github.com/minio/minio" \
      org.opencontainers.image.url="https://github.com/minio/minio/releases/tag/${MINIO_RELEASE}" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
COPY minio /minio
COPY LICENSE /LICENSE
ENTRYPOINT ["/minio"]
