FROM node:22-alpine AS build

ENV CI=true

RUN npm install -g corepack && corepack enable

COPY --from=golang:1.25.4-alpine /usr/local/go/ /usr/local/go/

ENV PATH="/usr/local/go/bin:${PATH}"

RUN apk add --no-cache git build-base

WORKDIR /boxlite

# Yarn caching layer
COPY apps/package.json apps/yarn.lock apps/.yarnrc.yml ./
RUN yarn install --immutable

# Nx config
COPY apps/nx.json ./

# Go dependency layer (cached unless go.mod/go.sum change)
COPY apps/go.work apps/go.work.sum apps/
COPY apps/runner/go.mod apps/runner/go.sum apps/runner/
COPY apps/daemon/go.mod apps/daemon/go.sum apps/daemon/
COPY apps/common-go/go.mod apps/common-go/go.sum apps/common-go/
COPY apps/api-client-go/go.mod apps/api-client-go/go.sum apps/api-client-go/
COPY sdks/go/go.mod sdks/go/

# Rewrite go.work to include only needed modules
RUN head -1 apps/go.work > apps/go.work.tmp && printf '\nuse (\n\t./runner\n\t./daemon\n\t./common-go\n\t./api-client-go\n\t../sdks/go\n)\n' >> apps/go.work.tmp && mv apps/go.work.tmp apps/go.work

ENV NX_DAEMON=false

RUN go -C apps/runner mod download \
  && go -C apps/daemon mod download \
  && go -C apps/common-go mod download \
  && go -C apps/api-client-go mod download

# BoxLite static library and headers
COPY sdks/go/ sdks/go/
COPY sdks/c/include/ sdks/c/include/

# Prebuilt libboxlite.a — built by CI or `make dist:runner`
ARG LIBBOXLITE_PATH=target/release/libboxlite.a
COPY ${LIBBOXLITE_PATH} sdks/go/libboxlite.a

# Go source
COPY apps/runner/ apps/runner/
COPY apps/daemon/ apps/daemon/
COPY apps/common-go/ apps/common-go/
COPY apps/api-client-go/ apps/api-client-go/
COPY apps/libs/computer-use/ libs/computer-use/

# Computer-use binary
COPY dist/libs/computer-use-amd64 dist/libs/computer-use-amd64

ARG VERSION=0.0.1
RUN --mount=type=cache,target=/root/.cache/go-build \
  CGO_ENABLED=1 SKIP_COMPUTER_USE_BUILD=true VERSION=$VERSION yarn nx build runner --configuration=production --nxBail=true

# Runtime — lightweight Linux with KVM support
FROM alpine:3.22 AS runner

RUN apk add --no-cache curl

WORKDIR /usr/local/bin

COPY --from=build /boxlite/dist/apps/runner boxlite-runner

RUN chmod +x boxlite-runner

HEALTHCHECK CMD [ "curl", "-f", "http://localhost:3003/" ]

ENTRYPOINT ["boxlite-runner"]
