/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { FindOptionsWhere } from 'typeorm'
import { Box } from '../entities/box.entity'
import { WarmPool } from '../entities/warm-pool.entity'
import { BoxClass } from '../enums/box-class.enum'

/**
 * The tuple that decides whether a pre-warmed box can serve a request.
 *
 * A warm box is booted before anyone asks for it, so everything it was built
 * with has to be matched rather than applied. This type is that list, and it is
 * the reason it exists as a type: the same tuple is asked for at four sites in
 * `BoxWarmPoolService` — the pool lookup, the box claim, the top-up count, and
 * the re-assignment handler, which asks twice — and all five used to spell it
 * out by hand. One of them left `gpu` out, which let a GPU box answer a request
 * that asked for none.
 *
 * It mirrors `warm_pool_find_idx` (`warm-pool.entity.ts:11`); a field added to
 * one belongs in the other, and a test pins them together.
 *
 * `WarmPool.gpuType` is deliberately not here, and cannot be: `box` has no such
 * column, `CreateBoxDto` has no such field, and the index does not cover it, so
 * there is nothing to match a pool row's GPU type against and no way to ask for
 * one. Adding it is a schema change, not a predicate change.
 */
export type WarmPoolSpec = {
  image: string
  /** The region. `WarmPool` calls this column `target`, `Box` calls it `region`. */
  target: string
  class: BoxClass
  cpu: number
  mem: number
  disk: number
  gpu: number
  osUser: string
  env: { [key: string]: string }
}

/** The tuple a pool row is provisioned with. */
export function warmPoolSpecOfRow(item: WarmPool): WarmPoolSpec {
  return {
    image: item.image,
    target: item.target,
    class: item.class,
    cpu: item.cpu,
    mem: item.mem,
    disk: item.disk,
    gpu: item.gpu,
    osUser: item.osUser,
    env: item.env,
  }
}

/** The tuple a box was built with, named the way a pool row names it. */
export function warmPoolSpecOfBox(box: Box): WarmPoolSpec {
  return {
    image: box.image,
    target: box.region,
    class: box.class,
    cpu: box.cpu,
    mem: box.mem,
    disk: box.disk,
    gpu: box.gpu,
    osUser: box.osUser,
    env: box.env,
  }
}

/**
 * Match a `warm_pool` row against the tuple.
 *
 * Field by field rather than by spreading the argument: callers pass objects
 * that carry more than the tuple — `FetchWarmPoolBoxParams` also has the asking
 * organization — and a spread would turn those into where-clauses on columns
 * the table does not have.
 */
export function warmPoolRowWhere(spec: WarmPoolSpec): FindOptionsWhere<WarmPool> {
  return {
    image: spec.image,
    target: spec.target,
    class: spec.class,
    cpu: spec.cpu,
    mem: spec.mem,
    disk: spec.disk,
    gpu: spec.gpu,
    osUser: spec.osUser,
    env: spec.env,
  }
}

/** The same tuple against a `box` row, which spells the region differently. */
export function warmPoolBoxWhere(spec: WarmPoolSpec): FindOptionsWhere<Box> {
  return {
    image: spec.image,
    region: spec.target,
    class: spec.class,
    cpu: spec.cpu,
    mem: spec.mem,
    disk: spec.disk,
    gpu: spec.gpu,
    osUser: spec.osUser,
    env: spec.env,
  }
}
