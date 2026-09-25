## TL;DR

Budget for AWS hosting, state, storage, networking and operational services according to the selected deployment path.

# AWS cost inventory

[Cloud guide](README.md) · [Infrastructure index](../../README.md)

This inventory follows the [AWS provider](../../mdeploy/stack/providers/aws/) and retained
[legacy stack](../../stack/); it is not a live bill or a fixed monthly estimate.

| Resource family | BoxLite use |
| --- | --- |
| ECS Fargate | API/dashboard, proxy and OTel collector |
| EC2 and EBS | Runner hosts; optional ClickHouse and retained data disks |
| RDS | PostgreSQL compute, storage, configured backups and availability |
| ElastiCache | Redis capacity and availability |
| S3 | Application objects, volumes, deployment assets/state and runner artifacts |
| ECR | Container images |
| ALB and NLB | API, proxy and internal service entrypoints |
| CloudFront | Dashboard delivery |
| NAT instances, public IPv4 and data transfer | Service and runner egress, public endpoints and traffic |
| Secrets Manager / SSM | Secret values and configuration according to storage tier and usage |
| CloudWatch | Logs, metrics and alarms |
| SES, when configured | Outbound application mail |

Use current regional pricing for the configured instance sizes, replica counts, storage retention,
traffic and service allowances. Include retained data and old artifacts after a deployment or teardown.
BoxLite runtime, shim and guest processes share the runner host; they are not additional EC2 instances.
External DNS, OIDC and other product integrations have separate ownership and bills.
