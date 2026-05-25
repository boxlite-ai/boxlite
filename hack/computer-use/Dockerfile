FROM golang:1.25-bookworm AS build

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libpng-dev \
    libx11-dev \
    libx11-xcb-dev \
    libxcb-xkb-dev \
    libxext-dev \
    libxinerama-dev \
    libxkbcommon-dev \
    libxkbcommon-x11-dev \
    libxrandr-dev \
    libxtst-dev \
    pkg-config \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace/apps

COPY apps/daemon ./daemon
COPY apps/libs/computer-use ./libs/computer-use

RUN printf 'go 1.25.4\n\nuse (\n\t./daemon\n\t./libs/computer-use\n)\n' > go.work

RUN go -C daemon mod download && go -C libs/computer-use mod download

RUN CGO_ENABLED=1 GOOS=linux GOARCH=amd64 go build -o /out/computer-use-amd64 ./libs/computer-use

FROM scratch AS export

COPY --from=build /out/computer-use-amd64 /computer-use-amd64
