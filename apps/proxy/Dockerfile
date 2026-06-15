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
COPY apps/proxy/go.mod apps/proxy/go.sum proxy/
COPY apps/common-go/go.mod apps/common-go/go.sum common-go/
COPY apps/api-client-go/go.mod apps/api-client-go/go.sum api-client-go/
RUN head -1 go.work > go.work.tmp && printf '\nuse (\n\t./proxy\n\t./common-go\n\t./api-client-go\n)\n' >> go.work.tmp && mv go.work.tmp go.work

ENV NX_DAEMON=false
ENV GOWORK=/boxlite/apps/go.work

RUN go -C proxy mod download && go -C common-go mod download && go -C api-client-go mod download

# Go source
COPY apps/proxy/ proxy/
COPY apps/common-go/ common-go/
COPY apps/api-client-go/ api-client-go/

ARG VERSION=0.0.1
RUN --mount=type=cache,target=/root/.cache/go-build \
  VERSION=$VERSION yarn nx build proxy --configuration=production --nxBail=true

FROM alpine:3.18 AS proxy

RUN apk add --no-cache curl

WORKDIR /usr/local/bin

COPY --from=build /boxlite/apps/dist/apps/proxy boxlite-proxy

RUN chmod +x boxlite-proxy

HEALTHCHECK CMD [ "curl", "-f", "http://localhost:4000/health" ]

ENTRYPOINT ["boxlite-proxy"]
