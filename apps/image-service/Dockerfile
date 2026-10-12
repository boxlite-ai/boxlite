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
COPY apps/image-service/go.mod apps/image-service/go.sum image-service/
COPY apps/libs/common-go/go.mod apps/libs/common-go/go.sum libs/common-go/
COPY apps/libs/api-client-go/go.mod apps/libs/api-client-go/go.sum libs/api-client-go/
RUN head -1 go.work > go.work.tmp && printf '\nuse (\n\t./image-service\n\t./libs/common-go\n\t./libs/api-client-go\n)\n' >> go.work.tmp && mv go.work.tmp go.work

ENV NX_DAEMON=false
ENV GOWORK=/boxlite/apps/go.work

RUN go -C image-service mod download && go -C libs/common-go mod download && go -C libs/api-client-go mod download

# Go source
COPY apps/image-service/ image-service/
COPY apps/libs/common-go/ libs/common-go/
COPY apps/libs/api-client-go/ libs/api-client-go/

ARG VERSION=0.0.1
RUN --mount=type=cache,target=/root/.cache/go-build \
  VERSION=$VERSION yarn nx build image-service --configuration=production --nxBail=true

FROM alpine:3.22 AS registry-proxy

RUN apk add --no-cache curl

WORKDIR /usr/local/bin

COPY --from=build /boxlite/apps/dist/apps/registry-proxy boxlite-registry-proxy

RUN chmod +x boxlite-registry-proxy

# Nothing here needs root: the default port is above 1024 and nothing is
# written to disk, so a process that holds runner keys runs without it.
USER 65532:65532

HEALTHCHECK CMD [ "curl", "-f", "http://localhost:4100/health" ]

ENTRYPOINT ["boxlite-registry-proxy"]
