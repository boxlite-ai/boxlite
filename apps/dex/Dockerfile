FROM alpine:3.20 AS config
COPY apps/dex/config.yaml /etc/dex/config.yaml
COPY apps/dex/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

FROM dexidp/dex:v2.42.0
COPY --from=config /etc/dex/config.yaml /etc/dex/config.yaml
COPY --from=config /entrypoint.sh /entrypoint.sh
USER root
RUN mkdir -p /var/dex && chown -R 1001:1001 /var/dex
USER 1001
EXPOSE 5556
ENTRYPOINT ["/entrypoint.sh"]
