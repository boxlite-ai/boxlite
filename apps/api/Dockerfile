FROM node:24-slim AS boxlite
# build: 2026-04-28-v2
ENV CI=true

RUN apt-get update && apt-get install -y --no-install-recommends bash curl && \
  rm -rf /var/lib/apt/lists/*
RUN npm install -g corepack && corepack enable

WORKDIR /boxlite

COPY apps/package.json apps/yarn.lock apps/.yarnrc.yml ./
RUN yarn install --immutable

COPY apps/nx.json apps/tsconfig.base.json apps/NOTICE ./

ARG CACHE_BUST=1
ENV NX_DAEMON=false
ENV NX_SKIP_NX_CACHE=true

COPY apps/api/ apps/api/
COPY apps/dashboard/ apps/dashboard/

COPY apps/libs/runner-api-client/ libs/runner-api-client/
COPY apps/libs/api-client/ libs/api-client/
COPY apps/libs/analytics-api-client/ libs/analytics-api-client/
COPY apps/libs/toolbox-api-client/ libs/toolbox-api-client/
COPY apps/libs/sdk-typescript/ libs/sdk-typescript/

RUN echo 1777389170 && yarn nx build api --configuration=production --nxBail=true

RUN VITE_BASE_API_URL=%BOXLITE_BASE_API_URL% yarn nx build dashboard --configuration=production --nxBail=true --output-style=stream

ARG VERSION=0.0.1
ENV VERSION=${VERSION}

HEALTHCHECK CMD [ "curl", "-f", "http://localhost:3000/api/config" ]

ENTRYPOINT ["node", "dist/apps/api/main.js"]
