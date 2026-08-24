# BoxLite cloud applications

The applications under this directory form BoxLite's hosted control plane and
runner data plane. This view shows how public traffic reaches private services,
how the control plane schedules boxes, and where state and telemetry flow.

## Architecture

### Current

```mermaid
flowchart TB
    browser(["Browser"])
    sdk(["SDK / CLI"])
    cloudflare(["Cloudflare DNS"])
    idp(["OIDC IdP<br/>Auth0 · Okta · Keycloak · Dex"])
    ghcr(["ghcr.io"])
    telemetry(["External telemetry<br/>organization OTLP · optional ClickHouse"])

    subgraph aws_cloud["AWS cloud"]
        cf["CloudFront<br/>STACK_DOMAIN"]
        s3[("S3<br/>storage + box volumes")]

        subgraph vpc["VPC"]
            subgraph public_ingress["public ingress · public subnets"]
                alb["API ALB<br/>api.STACK_DOMAIN · TLS 443"]
                nlb["Proxy NLB<br/>proxy + *.proxy.STACK_DOMAIN · TLS 443"]
            end

            subgraph private_services["private services · ECS Fargate"]
                api["API + Dashboard · NestJS<br/>:3000"]
                proxy["Proxy<br/>:4000"]

                subgraph obs["internal observability + tools"]
                    otel["OTel Collector<br/>:4318"]
                    jaeger["Jaeger<br/>:16686"]
                    ops["PgAdmin + MailDev<br/>internal only"]
                end
            end

            subgraph state["state · VPC private"]
                pg[("RDS Postgres")]
                redis[("ElastiCache Redis")]
            end

            s3_endpoint["S3 gateway endpoint<br/>private route tables"]

            subgraph runner_fleet["Runner fleet · public subnet"]
                subgraph ec2_runner["EC2 instance · repeated × N"]
                    subgraph runner_process["Runner daemon · one per EC2"]
                        runner_api["Runner API<br/>:3003"]

                        subgraph embedded_boxlite["embedded BoxLite runtime"]
                            boxlite_core["BoxLite runtime<br/>nested KVM"]
                            boxes[["box microVMs"]]
                        end
                    end
                end
            end
        end
    end

    cloudflare dns_to_cf@-.->|"root domain"| cf
    cloudflare dns_to_alb@-.->|"api domain"| alb
    cloudflare dns_to_nlb@-.->|"wildcard proxy domain"| nlb

    browser browser_to_cf@-->|"dashboard SPA"| cf
    cf cf_to_alb@-->|"dashboard origin"| alb
    browser browser_to_alb@-->|"/api/* · WS · SSE"| alb
    sdk sdk_to_alb@-->|"/api/*"| alb
    browser browser_to_nlb@-->|"box port preview"| nlb

    alb alb_to_api@-->|"API traffic"| api
    nlb nlb_to_proxy@-->|"proxy traffic"| proxy
    proxy proxy_to_runner@-->|"box port tunnel"| runner_api

    api api_to_pg@-->|"durable state"| pg
    api api_to_redis@-->|"queues + cache"| redis
    api api_to_s3_endpoint@-->|"private S3 route"| s3_endpoint
    s3_endpoint endpoint_to_s3@-->|"gateway access"| s3
    api api_to_runner@<-->|"jobs + status"| runner_api
    api api_to_idp@-.->|"JWT via JWKS"| idp
    api api_to_otel@-->|"OTLP"| otel

    runner_api runner_to_boxlite@-->|"embedded calls"| boxlite_core
    runner_api runner_to_otel@-->|"host + box OTLP"| otel
    boxlite_core boxlite_to_boxes@-->|"create + run"| boxes
    boxlite_core boxlite_to_s3@-->|"mount volumes"| s3
    boxlite_core boxlite_to_ghcr@-->|"pull images"| ghcr

    otel otel_to_jaeger@-->|"traces"| jaeger
    otel otel_to_telemetry@-.->|"configured export"| telemetry
```

The deployment runbook and operational constraints live in
[`infra/docs/deployment.md`](./infra/docs/deployment.md).

## API catalog

See [`API.md`](./API.md) for the categorized inventory of every application
interface, including its method, path, owning service, and purpose. Alongside
the registered routes it covers outbound events, static asset trees, the local
development stack, and the APIs whose clients live here but whose routes are
served elsewhere.

## Data model

See [`SCHEMA.md`](./SCHEMA.md) for the control-plane Postgres schema: every
table with its columns, keys, and indexes, how the tables relate and which of
those relationships the database enforces, and the satellite stores that sit
beside it.
