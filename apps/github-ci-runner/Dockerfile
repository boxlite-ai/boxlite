# Build from the repository root: docker build -f apps/github-ci-runner/Dockerfile .
FROM --platform=$BUILDPLATFORM node:24-slim AS build
WORKDIR /workspace/apps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN npm install -g corepack && corepack enable
COPY apps/package.json apps/yarn.lock apps/.yarnrc.yml ./
RUN yarn install --immutable
COPY apps/nx.json apps/tsconfig.base.json apps/jest.preset.js ./
COPY apps/libs/ci-listener/ libs/ci-listener/
COPY apps/github-ci-runner/project.json apps/github-ci-runner/tsconfig*.json apps/github-ci-runner/webpack.config.cjs github-ci-runner/
COPY apps/github-ci-runner/src/ github-ci-runner/src/
ENV NX_DAEMON=false NX_SKIP_NX_CACHE=true
RUN yarn nx build github-ci-runner --nxBail=true --output-style=stream

FROM node:24-slim
WORKDIR /opt/listener
COPY --from=build /workspace/apps/dist/apps/github-ci-runner/main.js ./main.js
RUN mkdir -p /var/lib/boxlite-ci && chown node:node /var/lib/boxlite-ci && chmod 700 /var/lib/boxlite-ci
USER node
EXPOSE 8080
ENTRYPOINT ["node", "/opt/listener/main.js"]
