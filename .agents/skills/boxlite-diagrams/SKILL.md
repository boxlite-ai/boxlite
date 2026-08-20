---
name: boxlite-diagrams
description: >
  Create, render, visually inspect, and source-ground clear BoxLite
  architecture, cloud-deployment, sequence, and call-graph diagrams. Use this
  skill whenever a user asks how BoxLite works, requests a diagram or rendered
  picture, wants an issue or bug illustrated, or needs a PR, commit, branch, or
  working-tree change explained visually. Search for and reuse the nearest
  canonical BoxLite diagram before authoring a new one, and choose only the
  views that answer the request.
---

# BoxLite Diagrams

Produce the smallest source-grounded diagram set that answers the user's
question and is readable as a rendered picture. Evidence correctness and visual
composition are separate gates: pass both.

## Workflow

1. Resolve the repository root, current revision, requested subject, output
   location, and reader.
2. Search before drawing. Look for the nearest maintained diagram in READMEs and
   architecture or deployment docs:

   ```bash
   rg -n '^## .*Architecture|^```mermaid|flowchart|sequenceDiagram' \
     README.md apps docs .github
   ```

3. Open the closest diagram and its surrounding prose. If it already answers
   the question, reuse its composition and verify it rather than reconstructing
   the system from low-level source.
4. Select only the useful views with the decision table below. Three views are
   not a default.
5. If the request is an architecture, cloud deployment, topology, overview, or
   rendered picture, read
   [references/architecture-composition.md](references/architecture-composition.md)
   completely before authoring.
6. Read the actual source, IaC, nearby tests, and relevant docs needed to verify
   the selected altitude. If an issue or PR is named, read it with `gh` and
   resolve its revisions.
7. Create `diagram.md` and `evidence.json` in a temporary task directory. Add
   stable canonical IDs for nodes, edges, and architecture boundaries. Declare
   immediate boundary membership so containment is validated rather than
   inferred from indentation.
8. Run the bundled validator. On failure, read `validation.json`, correct the
   evidence or diagram, and retry. Stop after three failed attempts and return
   the report instead of an unverified diagram.
9. Open every generated PNG and inspect the actual render at normal fit-to-page
   size. Fix overlaps, misleading boundaries, clipped labels, poor routing, or
   unreadable density, then re-render. Explicitly state that visual QA was done.
10. Use the repository's required verdict-auditor workflow before presenting
    architectural conclusions.

Do not edit BoxLite production code when the request is only for a diagram.
Save generated files in the repository only when the user explicitly asks.

## Choose the view from the question

| User needs | Default output |
| --- | --- |
| Architecture, deployment, topology, boundaries, or a rendered picture | Architecture only |
| Request order, retries, concurrency, callbacks, or failure | Sequence only |
| Source mechanics, function path, or "how does this code work?" | ASCII call graph; add sequence only if time matters |
| Issue, bug, PR, or before/after change | Smallest view set that makes the change unambiguous |
| User explicitly requests named views | Exactly those views |

Add another view only when it answers a materially different question. Do not
repeat the same component inventory as architecture, sequence, and call graph.

## Reference-first architecture

For the hosted BoxLite cloud deployment, start from
[`apps/infra/docs/deployment.md#architecture`](../../../apps/infra/docs/deployment.md#architecture).
It is the house reference for deployment altitude and composition: external
actors, public edge, private VPC, nested state and observability, semantic
shapes, operational labels, and only the important routes.

Treat an existing diagram as a maintained hypothesis, not proof. Verify any
drift-prone label or route against current IaC and source. Preserve the useful
layout when adding a missing requirement; do not replace a clear canonical
overview with a larger infrastructure inventory.

"Entire cloud deployment architecture" means full coverage at one deployment
altitude. Include users/SDKs, external dependencies, public ingress, network and
trust boundaries, deployed compute, the box execution boundary, durable state,
observability, and the main request/control/data/image paths. It does not mean
every security group, route table, function, or SDK call.

Model ownership with surrounding boundaries, not arrows. For the hosted runner
path, preserve this hierarchy when current source confirms it:

`Runner fleet → EC2 instance × N → Runner daemon → embedded BoxLite runtime → box microVMs`

Use nested Mermaid subgraphs and matching manifest `boundaries[].members` for
each immediate containment step. Do not draw peers when one component owns,
hosts, or embeds the other. Keep external services outside AWS/VPC boundaries,
and place VPC resources inside their actual public or private deployment
boundary. Read the composition reference for the complete placement rules.

## State and annotation model

Choose state labels from the evidence:

- overview: `Current`;
- unimplemented issue: `Current` and `Expected (proposed)`;
- PR, commit, branch, or working-tree change: `Before` and `After`.

Apply annotations to the exact affected node or edge:

- `ISSUE`: verified current gap described by a non-bug issue;
- `← BUG: <description>`: faulty call-graph hop in `Current` or `Before`;
- `BUG: <description>`: faulty architecture or sequence element;
- `FIX`: corrected behavior in `Expected (proposed)` or `After`;
- `PROPOSED`: behavior required by an issue but absent from source;
- `ADDED`, `CHANGED`, `REMOVED`: behavior grounded in the corresponding diff.

A PR can fix a bug reported by an issue. Do not model issue, bug, and PR as
mutually exclusive kinds.

## Document and manifest

Declare selected views at the evidence-manifest root in canonical order:

```json
{
  "schema_version": 1,
  "views": ["architecture"]
}
```

If `views` is omitted, the validator selects all three for backward
compatibility. New diagrams should declare it explicitly. `diagram.md` contains
exactly the selected level-two sections, with one level-three subsection for
each state. An architecture-only document is expected for a deployment-picture
request.

Read [references/output-contract.md](references/output-contract.md) completely
before authoring `diagram.md` or `evidence.json`. The schema is
[references/evidence.schema.json](references/evidence.schema.json); the script
also performs semantic checks that JSON Schema cannot express.

For bug-fix PRs, add `Fixes #<number>` after the last selected view.

## Canonical IDs

Use stable lowercase snake-case IDs. Reuse an ID when the same entity or
relationship appears in more than one selected view or state.

- Architecture node: `runtime["BoxliteRuntime"]`
- Architecture edge: `runtime create_box@--> box`
- Sequence participant: `participant runtime as BoxliteRuntime`
- Sequence edge: put `%% edge:create_box` immediately before its message
- Call graph: the validator maps a hop to one manifest node by its symbol and
  source anchor, then derives edges from indentation.

Every selected Mermaid edge has a canonical ID. Do not add untracked arrows or
messages.

## Source grounding

- Cite the exact revision, repository-relative path, and inclusive line range.
- When a sequence message resolves to an implemented function, keep the action
  short and explicitly label every source field:
  `<action><br/>File: <path><br/>Namespace: <full-chain><br/>Class: <owner><br/>Function: <name><br/>LOC: L<start>-L<end>`.
  `File` is the repository-relative path. `Namespace` is the complete declared
  crate, module, or package chain from outermost to innermost; never collapse a
  nested namespace to its leaf. Use `Namespace: —` when none exists. `Class` is
  the owning class, struct, type, or receiver and is `—` for a free function.
  `Function` is the unqualified function or method name. `LOC` is its inclusive
  line range. Never show a partial source block. Omit the whole block only when
  the message has no concrete source symbol, such as an external actor or
  explicitly proposed behavior; never invent one.
- For sequence-call target nodes, record `evidence[].symbol` as the complete
  namespace, owner, and function chain so the validator can check every
  displayed field rather than only their presence.
- Include narrow evidence tokens that prove each node or relationship.
- For a direct call, the edge evidence contains the callee's leaf symbol.
- For RPC, dispatch, spawn, data flow, or state transitions, cite the concrete
  registration, protocol call, process launch, assignment, or transition.
- Never infer a call merely because two real functions have compatible names.
- Never invent a future symbol for an unimplemented issue. Stop the proposed
  call graph at the last real boundary and annotate the missing next behavior.
- Mark issue-derived future nodes or edges `proposed: true` and support them
  with issue evidence rather than fake source evidence.

For comparisons, source anchors belong to their own state revision. A deleted
hop cites the base revision; an added hop cites the head revision.

## Visual composition

- Keep every node at the selected altitude and in service of one scope sentence.
- Architecture shows ownership, network, trust, process, and storage boundaries.
- Sequence shows time, calls, responses, alternatives, concurrency, and failure.
- Sequence messages keep the action concise while explicitly showing `File`,
  `Namespace`, `Class`, `Function`, and `LOC` when source is available, for
  example `create box<br/>File: apps/api/src/box/services/box.service.ts<br/>Namespace: —<br/>Class: BoxService<br/>Function: create<br/>LOC: L203-L348`.
- Call graph uses one hop per line:
  `symbol (Type · path/file.ext:line) — role`.
- Prefer `flowchart TB` for a whole cloud deployment and `LR` for a short path.
- Use subgraphs only for real boundaries. Make each parent physically surround
  its immediate members; nested and sibling boundaries must be visually
  disjoint in the rendered image.
- Use short labels with domain, protocol, port, implementation, or constraint
  details only where they change understanding.
- Use semantic shapes consistently: rounded actors, rectangles for services,
  cylinders for state, and a distinct VM/runtime shape.
- Keep meaning in text. Color may reinforce it but never carry it.
- Keep README Mermaid unstyled so its host controls light/dark rendering. Do
  not set a theme, `classDef`, `class`, `style`, or `linkStyle`; exported PNGs
  are static previews, not adaptive replacements.
- Mermaid is limited to `flowchart`/`graph` and `sequenceDiagram`.
- `<br/>` is allowed for deliberate label wrapping. Initialization directives,
  clicks, links, other raw HTML, and JavaScript are forbidden.

## Validation command

```bash
python3 .agents/skills/boxlite-diagrams/scripts/validate_diagrams.py \
  --repo "$(git rev-parse --show-toplevel)" \
  --document "$TASK_DIR/diagram.md" \
  --evidence "$TASK_DIR/evidence.json" \
  --report "$TASK_DIR/validation.json"
```

Exit codes:

- `0`: every deterministic check passed;
- `1`: diagram or evidence is invalid;
- `2`: a required tool is unavailable.

The validator uses pinned on-demand `@mermaid-js/mermaid-cli@11.16.0` and emits
`.mmd`, `.svg`, and `.png` artifacts. Open the PNG with the available image-view
tool. Do not substitute source inspection for render inspection.

## Response

Lead with what the user requested:

- rendered picture: show or link the PNG first;
- architecture: show architecture first;
- code-path explanation: show the ASCII call graph and one `Key:` line first;
- comparison: keep `Before` and `After` adjacent within each selected view.

End with a compact evidence summary, visual-QA statement, and the passing
validation-report path when files were requested.

Mechanical validation proves renderability, source traceability, diff alignment,
and consistency across selected views. It does not prove that the picture is
well composed or that the architectural interpretation is complete; visual QA
and the verdict audit cover those separate judgments.
