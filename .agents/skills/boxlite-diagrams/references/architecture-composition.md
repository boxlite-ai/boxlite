# Architecture composition

Read this reference whenever the requested output is an architecture,
deployment, topology, overview, or rendered picture.

## Contents

- [BoxLite house reference](#boxlite-house-reference)
- [Pick one altitude](#pick-one-altitude)
- [Model containment before routes](#model-containment-before-routes)
- [Place hosted-cloud components](#place-hosted-cloud-components)
- [Compose for a normal-width render](#compose-for-a-normal-width-render)
- [Preserve adaptive themes](#preserve-adaptive-themes)
- [Run visual QA](#run-visual-qa)

## BoxLite house reference

Start with the existing diagram closest to the request. For the hosted cloud
deployment, use
[`apps/infra/docs/deployment.md#architecture`](../../../../apps/infra/docs/deployment.md#architecture)
as the composition baseline. It establishes the BoxLite house style:

- keep users and external dependencies outside owned infrastructure;
- separate public ingress from private compute;
- group state and observability by operational role;
- distinguish actors, services, storage, and box microVMs by shape;
- put only useful domain, protocol, port, runtime, and constraint details in
  labels;
- draw only high-value request, control, image, telemetry, and data routes.

Reuse the canonical layout when it answers the question, but treat its
containment as a hypothesis. Verify every deployment boundary against current
IaC and source before copying it. Do not reconstruct the system from low-level
call paths merely because more source exists.

## Pick one altitude

State the diagram's question in one sentence before drawing. Examples:

- "How public traffic reaches private BoxLite services and boxes."
- "How the runner creates and starts one box."
- "What changed between the PR base and head."

Every node must help answer that sentence. A deployment overview names deployed
systems and boundaries, not individual functions. A source call graph names
functions, not every cloud resource.

"Entire deployment architecture" means complete coverage at the deployment
altitude, not every AWS resource. Include:

1. user and SDK entry points;
2. external identity, DNS, registry, or telemetry dependencies that affect the
   main path;
3. public ingress and routing;
4. network, host, process, and trust boundaries needed to understand ownership;
5. deployed compute and the box execution boundary;
6. durable state and caches;
7. the main control, data, image, and observability routes.

Combine siblings with the same boundary and role when their individual identity
does not change a route. Add a second diagram only when the user asks for a
different altitude.

## Model containment before routes

Distinguish containment from communication:

- "inside," "runs on," "owns," and "embeds" require surrounding subgraphs;
- "calls," "routes to," "polls," "mounts," and "exports" require arrows;
- never use an arrow as a substitute for ownership;
- never place an embedded component beside its host.

Give every real boundary a canonical lowercase snake-case Mermaid subgraph ID.
Declare the same boundary and each immediate member in
`evidence.json.boundaries`. The validator compares the manifest with the actual
nesting; indentation alone is not evidence.

For the hosted runner path, preserve this source-backed containment:

`Runner fleet → EC2 instance × N → Runner daemon → embedded BoxLite runtime → box microVMs`

Draw one representative EC2 unit and label the repeated layer `× N`; do not
clone identical instances. Use this shape:

```mermaid
flowchart TB
subgraph runner_fleet["Runner fleet · × N"]
  subgraph ec2_runner["EC2 instance · representative"]
    subgraph runner_process["Runner daemon"]
      runner_api["Runner API · :3003"]
      subgraph embedded_boxlite["embedded BoxLite runtime"]
        boxlite_core["BoxLite"]
        boxes[["box microVMs"]]
      end
    end
  end
end
```

Model every step, not merely the outer fleet. `Runner fleet` surrounds the
representative `EC2` boundary; EC2 surrounds the Runner process; Runner
surrounds the embedded BoxLite runtime; BoxLite surrounds the microVMs it
creates and manages.

Deep nesting is justified for this ownership chain because flattening it changes
the architecture's meaning. Keep unrelated state, telemetry, and ingress
grouping shallow so the overall picture remains readable.

## Place hosted-cloud components

Verify these placements against current IaC before drawing because they can
drift:

- keep the browser, SDK/CLI, Cloudflare DNS, OIDC provider, and image registry
  outside BoxLite-owned AWS boundaries;
- keep CloudFront in the AWS/global edge but outside the VPC;
- surround ALB/NLB resources with the VPC public-ingress boundary;
- surround ECS/Fargate API, Proxy, and internal tools with the VPC private
  service boundary;
- surround the Runner fleet with the VPC public-runner-subnet boundary;
- place RDS and Redis inside their VPC state boundary;
- keep regional S3 outside the VPC; draw its VPC gateway endpoint or route only
  when that access distinction matters.

Do not label a box "public edge" and then use it to imply that every enclosed
resource is outside the VPC. A route category and a deployment boundary are
different concepts.

## Compose for a normal-width render

- Prefer `flowchart TB` for a whole deployment and `LR` for a short path.
- Put the main request/control path near the center and supporting systems
  around it.
- Keep sibling boundaries disjoint. If Mermaid overlaps them, change direction,
  edge placement, or grouping and render again.
- Use short labels. Add a second or third line only for a domain, port,
  protocol, implementation, scale marker, or operational constraint.
- Use rounded actors, rectangles for services, cylinders for state, and a
  distinct shape for microVMs.
- Label important edges with traffic or control meaning. Leave obvious
  forwarding edges unlabeled only when the relationship remains unambiguous.
- Aim for roughly 12–20 nodes. Boundaries do not consume the same budget when
  they replace misleading ownership arrows.
- Avoid service logos, decorative icons, and dense legends.

Mermaid may ignore a subgraph's requested direction when its nodes connect
outside that subgraph. Treat the rendered result—not source indentation or a
`direction` statement—as the layout truth.

## Preserve adaptive themes

For GitHub README output, leave Mermaid unstyled so the host selects light/dark
colors. Do not add initialization directives, fixed themes, `themeVariables`,
`classDef`, `class`, `style`, or `linkStyle`. Use shapes, labels, and boundaries
instead of color for meaning.

An exported SVG or PNG is static and does not auto-switch. Keep the live Mermaid
block as the README source of truth, and use PNG only as a preview or download.
When theme contrast matters, inspect a light and dark render before delivery.

## Run visual QA

After deterministic validation, open every generated PNG at normal fit-to-page
size and check the picture:

1. The title or prose states the scope.
2. The main path can be followed in a few seconds.
3. Each parent visibly surrounds every declared immediate member.
4. External, AWS, VPC, subnet, host, process, runtime, state, and telemetry
   boundaries are truthful and disjoint.
5. Labels remain legible without zooming and are not clipped.
6. Arrows do not cross unrelated nodes or imply false ownership/direction.
7. No large empty region or long return edge distorts the layout.
8. Every item promised by the scope sentence appears.
9. The unstyled Mermaid remains readable in light/dark themes.

If any check fails, revise and render again. Syntax success and source evidence
do not constitute a visual-quality pass.
