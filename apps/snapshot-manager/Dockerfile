FROM node:22-alpine AS build

ENV CI=true

RUN npm install -g corepack && corepack enable

COPY --from=golang:1.25.4-alpine /usr/local/go/ /usr/local/go/

ENV PATH="/usr/local/go/bin:${PATH}"

RUN apk add --no-cache git

WORKDIR /boxlite

# Yarn caching layer
COPY apps/package.json apps/yarn.lock apps/.yarnrc.yml ./
RUN yarn install --immutable

# Nx config
COPY apps/nx.json ./

# Go dependency layer (cached unless go.mod/go.sum change)
COPY apps/go.work apps/go.work.sum apps/
COPY apps/snapshot-manager/go.mod apps/snapshot-manager/go.sum apps/snapshot-manager/
RUN head -1 apps/go.work > apps/go.work.tmp && printf '\nuse (\n\t./snapshot-manager\n)\n' >> apps/go.work.tmp && mv apps/go.work.tmp apps/go.work

ENV NX_DAEMON=false
# nx-go runs `go build` from /boxlite (WORKDIR), but go.work lives at apps/go.work.
# Without GOWORK, Go walks upward from /boxlite and finds no module file. Point
# GOWORK at the workspace file so module resolution succeeds.
ENV GOWORK=/boxlite/apps/go.work

RUN cd apps/snapshot-manager && go mod download

# Go source
COPY apps/snapshot-manager/ apps/snapshot-manager/

ARG VERSION=0.0.1
RUN --mount=type=cache,target=/root/.cache/go-build \
  VERSION=$VERSION yarn nx build snapshot-manager --configuration=production --nxBail=true

FROM alpine:3.18 AS snapshot-manager

RUN apk add --no-cache curl

WORKDIR /usr/local/bin

COPY --from=build /boxlite/dist/apps/snapshot-manager boxlite-snapshot-manager

RUN chmod +x boxlite-snapshot-manager

ENTRYPOINT ["boxlite-snapshot-manager"]
