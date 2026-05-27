As BoxLite developers, we are going to design and implement the full
infra-local stack.

BoxLite has adopted a new principle: **eat your own dogfood.**

Building on the existing infra-local proposal, we will construct a new
implementation that does **not** use Docker. Instead we use BoxLite to
run BoxLite boxes, and inside each box we run the corresponding OCI
image. The goal is to use BoxLite's own capabilities to stand up the
complete infra-local stack.

1. Get familiar with the BoxLite Python SDK.
2. Using the BoxLite Python SDK, launch the required components and
   services. Either with separate Python scripts per component, or with
   a single Python entry point that accepts different config files to
   launch different services.
3. Building on [`docs/apps/infra-vs-local-infra.md`](../../docs/apps/infra-vs-local-infra.md)
   and the BoxLite Python SDK, design a new proposal:
   `own-dog-food-local-infra-solution.md`.
