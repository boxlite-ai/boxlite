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
COPY apps/ssh-gateway/go.mod apps/ssh-gateway/go.sum apps/ssh-gateway/
COPY apps/api-client-go/go.mod apps/api-client-go/go.sum apps/api-client-go/
RUN head -1 apps/go.work > apps/go.work.tmp && printf '\nuse (\n\t./ssh-gateway\n\t./api-client-go\n)\n' >> apps/go.work.tmp && mv apps/go.work.tmp apps/go.work

ENV NX_DAEMON=false
# nx-go runs `go build` from /boxlite (WORKDIR), but go.work lives at apps/go.work.
# Without GOWORK, Go walks upward from /boxlite and finds no module file. Point
# GOWORK at the workspace file so module resolution succeeds.
ENV GOWORK=/boxlite/apps/go.work

RUN go -C apps/ssh-gateway mod download && go -C apps/api-client-go mod download

# Go source
COPY apps/ssh-gateway/ apps/ssh-gateway/
COPY apps/api-client-go/ apps/api-client-go/

RUN yarn nx build ssh-gateway --configuration=production --nxBail=true

FROM alpine:3.18 AS ssh-gateway

WORKDIR /usr/local/bin

COPY --from=build /boxlite/dist/apps/ssh-gateway boxlite-ssh-gateway

RUN chmod +x boxlite-ssh-gateway

EXPOSE 2222

ENTRYPOINT ["boxlite-ssh-gateway"]
