# BoxLite cloud MVP

## Purpose

Deliver the BoxLite Cloud MVP as a usable platform control plane for both customers and operators. The MVP should let users create and manage boxes while giving operators the tools to manage runners, balance workload, observe system health, and understand usage.

## MVP scope

* Box lifecycle: create, start, stop, delete, inspect, and recover boxes with clear state transitions.
* Admin operations: manage users, usage, quotas, machine status, and box state from a management surface.
* Runner operations: add and remove runners, track runner health, and expose runner capacity.
* Load balancing: place boxes onto healthy runners based on available CPU, memory, disk, and current load.
* Observability: show user usage, runner state, box state, and CPU/memory/disk utilization.
* Quotas: enforce basic per-user or per-org limits before provisioning new boxes.

## Success criteria

* A user can create and delete a box through the MVP flow and see its current lifecycle state.
* An operator can add/remove runners and see whether each runner is healthy, overloaded, or unavailable.
* Box placement avoids unhealthy runners and accounts for CPU, memory, disk, and active box load.
* Admin views expose users, usage, quotas, machines, and resource utilization clearly enough for day-to-day operations.
* Quota checks prevent new boxes when a user or org exceeds configured limits.
* The team has enough metrics, logs, and lifecycle events to debug failed provisioning or overloaded runners.

## Milestones

- Box lifecycle foundation - Target date: 2026-05-21T16:00:00.000Z

- Runner operations and scheduling - Target date: 2026-05-24T16:00:00.000Z

- Admin observability and quotas - Target date: 2026-05-26T16:00:00.000Z

- MVP hardening and demo readiness - Target date: 2026-05-28T16:00:00.000Z

## Metadata
- URL: [https://linear.app/polygala/project/boxlite-cloud-mvp-48a5cc5d2343/overview](https://linear.app/polygala/project/boxlite-cloud-mvp-48a5cc5d2343/overview)
- Status: Planned
- Lead: Dorian Zheng
- Members: Dorian Zheng, brianluo@polygala.ai, Michael Li, ngolo, rui.long@polygala.ai, yuanyuan@polygala.ai, mandalore@polygala.ai
- Start date: Not set
- Target date: May 29th