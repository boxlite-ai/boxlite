/*
 * SPDX-License-Identifier: AGPL-3.0
 * Copyright (c) 2026 BoxLite AI
 */

import { Injectable, Logger } from '@nestjs/common'
import axios from 'axios'
import { BoxApi, Configuration } from '@boxlite-ai/runner-api-client'
import { Box } from '../entities/box.entity'
import { BoxState } from '../enums/box-state.enum'
import { RunnerService } from './runner.service'

/** A box read must not wait on a slow runner; absent beats late here. */
const RUNNER_READ_TIMEOUT_MS = 3000

/**
 * States in which the runtime can hold an exit code for the main command.
 *
 * Everything else is a box that is up, coming up, or already gone, and the
 * runner has nothing to say: a running box's previous code belongs to a run
 * that ended, and a destroyed box no longer exists on the runner at all.
 * Skipping those is what keeps this read off the create and start paths.
 */
const STATES_THAT_CAN_HOLD_AN_EXIT_CODE: readonly BoxState[] = [BoxState.STOPPED, BoxState.ERROR]

/**
 * Reads the main command's exit code from the runner that owns the box.
 *
 * The control plane does not store it. The runtime records the code when the
 * guest's init exits and keeps it in the box's own record, so the runner can
 * answer for as long as the box lives there — whereas a copy in our database
 * would only ever be as good as the one state report that filled it, and that
 * report is skipped whenever our state already matches the runner's.
 *
 * This is a metadata read, so every failure degrades to `undefined` rather
 * than failing the box read around it. The caller cannot distinguish that from
 * "the runtime recorded none", which is the known cost of not storing a copy:
 * an unreachable runner reads as "no exit code recorded". Failing the whole
 * box response instead would be worse for every field that does not depend on
 * the runner.
 */
@Injectable()
export class BoxExitCodeService {
  private readonly logger = new Logger(BoxExitCodeService.name)

  constructor(private readonly runnerService: RunnerService) {}

  /**
   * Built per call rather than shared: a box read is not hot enough to justify
   * a keyed pool, and the runner adapter's own client carries a one-hour
   * timeout that has no place on this path.
   *
   * Overridable so a test can drive the rules below without standing up HTTP.
   * The URL, the bearer header and the runner's route are not covered that
   * way, and nothing in this repository exercises them: they hold only when
   * the API actually talks to a runner.
   */
  protected buildClient(apiUrl: string, apiKey: string): BoxApi {
    return new BoxApi(
      new Configuration(),
      '',
      axios.create({
        baseURL: apiUrl,
        headers: { Authorization: `Bearer ${apiKey}` },
        timeout: RUNNER_READ_TIMEOUT_MS,
      }),
    )
  }

  async getExitCode(box: Box): Promise<number | undefined> {
    if (!box.runnerId || !STATES_THAT_CAN_HOLD_AN_EXIT_CODE.includes(box.state)) {
      return undefined
    }

    try {
      const runner = await this.runnerService.findOne(box.runnerId)
      if (!runner?.apiUrl) {
        return undefined
      }

      const info = await this.buildClient(runner.apiUrl, runner.apiKey).info(box.id)
      // `0` is a real exit code, so only an absent field means "not recorded";
      // a truthiness check here would erase every clean exit.
      return info.data.exitCode ?? undefined
    } catch (err) {
      this.logger.debug(`Failed to read exit code for box ${box.id} from its runner: ${err}`)
      return undefined
    }
  }
}
