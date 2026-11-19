## TL;DR

AWS runs the API, proxy and collector on ECS Fargate, with EC2 runners and managed state services.

## Details

[Cloud guide](README.md) · [Infrastructure index](../../README.md)

This diagram describes source configuration, not a live account inventory.

[Networking](networking.md) · [Cost inventory](costs.md)

## AWS overview

The AWS provider hosts BoxLite's services using the resources shown below.
Sizing comes from the stage configuration; the diagram does not prescribe one instance type.

```mermaid
flowchart TB
 browser(["Browser"])
 sdk(["SDK / CLI"])
 idp(["OIDC identity provider"])
 registry(["OCI registries"])
 subgraph edge["Public edge"]
  cf["CloudFront<br/>Dashboard"]
  alb["Application Load Balancer<br/>API"]
  nlb["Network Load Balancer<br/>Proxy TLS"]
 end
 subgraph vpc["AWS VPC"]
  api["ECS Fargate<br/>API + bundled dashboard"]
  proxy["ECS Fargate<br/>Proxy"]
  runner["EC2 Runner<br/>Nested KVM"]
  box[["Box microVM"]]
  pg[("RDS PostgreSQL")]
  redis[("ElastiCache Redis")]
  s3[("S3 objects + volumes + checkpoints")]
  credentials[("Secrets Manager<br/>Registry credentials")]
  private_registry["ECS Registry Proxy<br/>private TLS NLB"]
  data[("Retained gp3<br/>Runner data")]
  otel["ECS Fargate<br/>OTel Collector · internal ALB"]
  ch[("Optional ClickHouse<br/>EC2 + EBS or managed")]
 end
 browser -->cf -->alb
 browser -->|"API / WebSocket / SSE"|alb
 sdk -->alb
 browser -->|"Box preview"|nlb -->proxy
 alb -->api
 proxy -->runner -->box
 api -->pg
 api -->redis
 api -->|"Vended STS credentials"|s3
 api -->|"Schedule boxes"|runner
 api -. "JWT / JWKS" .->idp
 api -->otel -->ch
 runner -->|"Public images"|registry
 runner -->|"Private pulls"|private_registry -->registry
 api -->|"Write/revoke"|credentials
 private_registry -->|"Read pinned versions"|credentials
 runner -->data
 runner -->|"Checkpoint archives"|s3
```


## Detailed application topology

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
        s3[("S3<br/>storage + volumes + checkpoints")]
        credentials[("Secrets Manager<br/>Registry credentials")]
        data[("Retained EBS gp3<br/>Runner data")]

        subgraph vpc["VPC"]
            subgraph public_ingress["public ingress · public subnets"]
                alb["API ALB<br/>api.STACK_DOMAIN · TLS 443"]
                nlb["Proxy NLB<br/>proxy + *.proxy.STACK_DOMAIN · TLS 443"]
            end

            subgraph private_services["private services · ECS Fargate"]
                api["API + Dashboard · NestJS<br/>:3000"]
                proxy["Proxy<br/>:4000"]
                private_registry["Registry Proxy<br/>private TLS NLB · :4100"]

                otel["OTel Collector<br/>:4318<br/>internal only"]
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
    boxlite_core boxlite_to_ghcr@-->|"public images"| ghcr
    runner_api -->|"private pulls"| private_registry --> ghcr
    api -->|"write/revoke"| credentials
    private_registry -->|"read"| credentials
    runner_api --> data
    runner_api -->|"checkpoint archives"| s3

    otel otel_to_telemetry@-.->|"configured export"| telemetry
```

Sources: [AWS providers](../../mdeploy/stack/providers/aws/), [retained legacy stack](../../stack/), [native AWS entrypoint](../../mdeploy/pulumi/aws-program.ts).
