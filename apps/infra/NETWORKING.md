# BoxLite infra — network model

Why the VPC is laid out the way it is: who can reach what, how things reach the
internet, and the reasoning (with AWS docs) behind the two different egress
patterns. Defined in [`sst.config.ts`](./sst.config.ts) §2 PLATFORM + §10 RUNNER.

## Layout (ap-southeast-1, 2 AZs)

```
                              ☁  INTERNET
                   (users ↓)        (↑ ghcr.io, Auth0, ClickHouse, ECR…)
                        │                         ▲
                        ▼                         │
        ╔═══════════════════════════════════════════════════╗
        ║              INTERNET GATEWAY (IGW)                ║  one per VPC
        ╚════╦═══════════════╦════════════════╦═════════════╝
   inbound   │    egress     │                │   (runner egress, direct)
             ▼               │                │
   ┌──── AZ-a ───────────────┼────┐   ┌───────┼──── AZ-b ──────────┐
   │ PUBLIC subnet           │    │   │       │  PUBLIC subnet      │
   │  [ALB node]  [NAT-a]  [Runner+pubIP]     │  [ALB node] [NAT-b] │
   │      │          ▲          (direct out)  │      │         ▲    │
   │ ─────┼──────────┼───────  │    │   │ ─────┼─────────┼──────────│
   │ PRIVATE subnet  │ egress  │    │   │ PRIVATE subnet │ egress   │
   │      ▼          │ (local) │    │   │      ▼         │ (local)  │
   │  [Api/Proxy]────┘         │    │   │  [Api/Proxy]───┘          │
   │  [DB] [Redis]             │    │   │  (tasks)                  │
   └──────────────────────────┘    │   └───────────────────────────┘
```

- **Public subnets:** internet-facing ALBs, the per-AZ NAT, and the EC2 runner.
- **Private subnets:** Fargate service tasks (Api, Proxy, SshGateway, Otel,
  Jaeger, MailDev, PgAdmin), Postgres, Redis. No public IPs.

## Traffic flows

| Flow | Path |
|------|------|
| User → API (ingress) | Internet → IGW → **ALB** (public) → Api task (private) |
| Service → internet (egress) | task (private) → **NAT in its own AZ** → IGW → ghcr/Auth0/ClickHouse |
| Runner → internet (egress) | runner (public IP) → IGW (**no NAT**) |
| API → external, reply back | stateful return through the NAT (API initiated) |

The NAT and ALB are asymmetric on purpose: the **ALB is the only inbound door**;
the **NAT is egress-only**. The service hosts themselves are never directly
addressable from the internet.

## Two egress patterns (and why)

Both let a host reach the internet *outbound-only* — because both NAT and
security groups are **stateful** (return traffic for a flow you started is
allowed). The difference is the failure mode.

```
 A — PRIVATE subnet + NAT            B — PUBLIC subnet + public IP + SG
 (Api, Proxy, DB, Redis …)          (Runner — must be EC2 w/ direct egress)

 no public IP, no inbound route      has a public IP + IGW route
 → internet has NO PATH in           → internet HAS a path; the SG is the gate
 → 2 layers (no-route + SG)          → 1 layer (SG only)
 → FAIL-CLOSED: open the SG to        → FAIL-OPEN: one `0.0.0.0/0` inbound rule
   0.0.0.0/0 and it's still unreachable  and it's exposed
```

- **Services use A.** Defense-in-depth for hosts holding user data + secrets.
- **The runner uses B** by necessity (EC2, high-bandwidth image-pull egress).
  Because the SG is its *entire* inbound control surface, it is pinned to
  `:3003` from the VPC CIDR only → an **egress-only public IP**, nothing inbound
  from the internet. See `RunnerSecurityGroup` in `sst.config.ts`.

## Why two NAT instances

One NAT (`t4g.nano`, fck-nat) **per AZ** — the VPC defaults to 2 AZs. Each
private task egresses through the NAT **in its own AZ**:

- **AZ fault isolation** — if AZ-a dies, AZ-b's tasks still egress via NAT-b. A
  single shared NAT would strand the other AZ on an AZ outage.
- **No cross-AZ data charge / latency** — local NAT means egress never crosses
  the AZ boundary.

Cost: ~$16/mo (2× t4g.nano + 2 public IPv4 + small EBS) — vs ~$86/mo for 2
managed NAT Gateways. The lever to drop to one NAT is `az: 1` (single-AZ, no
HA); not worth the destructive VPC change on a live stack.

## AWS references (the claims above, verbatim)

- **Security groups are stateful** → public-IP host *can* be outbound-only:
  > "Security groups are stateful… if you send a request from an instance, the
  > response traffic for that request is allowed to reach the instance
  > regardless of the inbound security group rules."
  — [Security groups](https://docs.aws.amazon.com/vpc/latest/userguide/vpc-security-groups.html)
- **Inbound is default-deny** (the SG is the only gate for a public host):
  > "The only traffic that reaches the instance is the traffic allowed by the
  > security group rules."
  — same page. And the fail-open warning:
  > "If you specify 0.0.0.0/0 … this enables anyone to access your instances from
  > any IP address using the specified protocol."
- **NAT is outbound-only:**
  > "instances in a private subnet can connect to services outside your VPC but
  > external services can't initiate a connection with those instances… Connections
  > must always be initiated from within the VPC."
  — [NAT gateways](https://docs.aws.amazon.com/vpc/latest/userguide/vpc-nat-gateway.html)
  (We use a NAT *instance* via fck-nat — same source-NAT + connection-tracking.)
- **Private subnet = no route in** (fail-closed), and AWS's recommendation:
  > "Private subnet – The subnet does not have a direct route to an internet
  > gateway." … "we recommend that you use private subnets. Use a bastion host or
  > NAT device to provide internet access."
  — [Subnets](https://docs.aws.amazon.com/vpc/latest/userguide/configure-subnets.html)
