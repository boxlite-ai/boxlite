# syntax=docker/dockerfile:1

FROM node:24-slim AS base
ENV CI=true

# python3/make/g++ are node-gyp's toolchain. Native dependencies (sqlite3, ssh2) normally unpack
# a prebuilt binary and never invoke gyp, so this is dead weight on a good day — but the fallback
# `prebuild-install ... || node-gyp rebuild` runs whenever that download fails, and without a
# toolchain the fallback cannot succeed, so one lost download fails the whole `yarn install`
# rather than degrading into a slower build. The shipped image starts from its own node:24-slim
# below and copies only node_modules, so none of this reaches it.
RUN apt-get update && apt-get install -y --no-install-recommends bash curl python3 make g++ && \
  rm -rf /var/lib/apt/lists/*
RUN npm install -g corepack && corepack enable

WORKDIR /boxlite/apps

FROM base AS deps
COPY apps/package.json apps/yarn.lock apps/.yarnrc.yml ./
RUN yarn install --immutable

FROM base AS runtime-deps
ENV NODE_ENV=production
COPY apps/package.json apps/yarn.lock apps/.yarnrc.yml ./
RUN yarn workspaces focus --all --production

FROM deps AS build
COPY apps/nx.json apps/tsconfig.base.json apps/NOTICE ./

ENV NX_DAEMON=false
ENV NX_SKIP_NX_CACHE=true

COPY apps/api/ api/
COPY apps/dashboard/ dashboard/

COPY apps/libs/runner-api-client/ libs/runner-api-client/
COPY apps/libs/api-client/ libs/api-client/
COPY apps/libs/analytics-api-client/ libs/analytics-api-client/

RUN yarn nx build api --configuration=production --nxBail=true --output-style=stream && node --check dist/apps/api/main.js

RUN VITE_BASE_API_URL=%BOXLITE_BASE_API_URL% yarn nx build dashboard --configuration=production --nxBail=true --output-style=stream

FROM node:24-slim AS boxlite
ENV CI=true
ENV NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends bash curl && \
  rm -rf /var/lib/apt/lists/*

WORKDIR /boxlite/apps

COPY --from=runtime-deps --chown=node:node /boxlite/apps/package.json ./package.json
COPY --from=runtime-deps --chown=node:node /boxlite/apps/node_modules ./node_modules
COPY --from=build --chown=node:node /boxlite/apps/NOTICE ./NOTICE
COPY --from=build --chown=node:node /boxlite/apps/dist/apps/api ./dist/apps/api
COPY --from=build --chown=node:node /boxlite/apps/dist/apps/dashboard ./dist/apps/dashboard

ARG VERSION=0.0.1
ENV VERSION=${VERSION}

EXPOSE 3000
HEALTHCHECK CMD [ "curl", "-f", "http://localhost:3000/api/config" ]

USER node

ENTRYPOINT ["node", "dist/apps/api/main.js"]
