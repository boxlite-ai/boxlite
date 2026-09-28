## TL;DR

AWS uses ALB/NLB ingress, private services, and distinct service and runner egress paths.

# AWS networking

[Cloud guide](README.md) · [Infrastructure index](../../README.md)

## Traffic paths

Services, database and cache use private placement. Public ALB/NLB ingress reaches the services;
EC2 NAT provides private-service outbound access. Runner hosts use public-subnet public-IP egress,
with inbound reachability restricted by their security group. A public IP is not proof of public access.
The current mdeploy provider admits runner traffic from the service security group; the retained
legacy stack has its own rules. Inspect the active provider before comparing firewall behavior.
The dashboard uses CloudFront; long-running API sessions use the API endpoint directly.

## Diagnose a failed path

Check DNS, destination port, task/instance readiness, routes and the exact security-group source.
Inspect load-balancer target health separately from task health, then exercise a real box preview or exec request.

Sources: [network provider](../../mdeploy/stack/providers/aws/network.ts), [legacy network](../../stack/foundation.ts).
