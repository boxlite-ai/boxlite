FROM node:22-alpine AS build

ENV CI=true

RUN npm install -g corepack && corepack enable

COPY --from=golang:1.25.4-alpine /usr/local/go/ /usr/local/go/

ENV PATH="/usr/local/go/bin:${PATH}"

RUN apk add --no-cache git

WORKDIR /boxlite/apps

# Yarn caching layer
COPY apps/package.json apps/yarn.lock apps/.yarnrc.yml ./
RUN yarn install --immutable

# Nx config
COPY apps/nx.json ./

# Go dependency layer (cached unless go.mod/go.sum change)
COPY apps/go.work apps/go.work.sum ./
COPY apps/otel-collector/exporter/go.mod apps/otel-collector/exporter/go.sum otel-collector/exporter/
COPY apps/api-client-go/go.mod apps/api-client-go/go.sum api-client-go/
COPY apps/common-go/go.mod apps/common-go/go.sum common-go/
RUN head -1 go.work > go.work.tmp && printf '\nuse (\n\t./otel-collector/exporter\n\t./api-client-go\n\t./common-go\n)\n' >> go.work.tmp && mv go.work.tmp go.work

ENV NX_DAEMON=false
ENV GOWORK=/boxlite/apps/go.work

RUN go -C otel-collector/exporter mod download && \
    go -C api-client-go mod download && \
    go -C common-go mod download

# Go source
COPY apps/otel-collector/ otel-collector/
COPY apps/api-client-go/ api-client-go/
COPY apps/common-go/ common-go/
RUN mkdir -p dist/apps/otel-collector

RUN yarn nx build otel-collector --configuration=production --nxBail=true

FROM alpine:3.18 AS otel-collector

RUN apk add --no-cache curl

WORKDIR /usr/local/bin

COPY --from=build /boxlite/apps/dist/apps/otel-collector/boxlite-otel-collector boxlite-otel-collector
COPY --from=build /boxlite/apps/otel-collector/config.yaml /otelcol/collector-config.yaml

RUN chmod +x boxlite-otel-collector

HEALTHCHECK CMD [ "curl", "-f", "http://localhost:13133/health/status" ]

EXPOSE 4317
EXPOSE 4318
EXPOSE 13133
EXPOSE 8888

ENTRYPOINT ["boxlite-otel-collector"]

CMD ["--config", "/otelcol/collector-config.yaml"]
