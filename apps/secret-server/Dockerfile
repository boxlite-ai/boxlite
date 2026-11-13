FROM golang:1.25.4-alpine AS build
WORKDIR /src
COPY apps/secret-server/ ./
RUN GOWORK=off CGO_ENABLED=0 go build -o /secret-server ./cmd/secret-server

FROM alpine:3.22
RUN apk add --no-cache ca-certificates
COPY --from=build /secret-server /usr/local/bin/secret-server
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/secret-server"]
