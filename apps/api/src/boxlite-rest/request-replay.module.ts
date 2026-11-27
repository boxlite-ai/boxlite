/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */
import { Global, Module } from '@nestjs/common'
import { BoxRequestReplayService } from './box-request-replay.service'
import { RequestReplayInterceptor } from './request-replay.interceptor'
import { RequestReplayPolicy } from './request-replay-policy'

@Global()
@Module({
  providers: [BoxRequestReplayService, RequestReplayInterceptor, RequestReplayPolicy],
  exports: [BoxRequestReplayService, RequestReplayInterceptor, RequestReplayPolicy],
})
export class RequestReplayModule {}
