/* Copyright 2026 BoxLite AI. SPDX-License-Identifier: AGPL-3.0 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  HttpCode,
  ParseUUIDPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'
import { AuthGuard } from '@nestjs/passport'
import { IsBoolean, IsIn, IsISO8601, IsOptional } from 'class-validator'
import {
  analyticsNoticeVersion,
  billingTabs,
  consoleActions,
  consoleControls,
  consolePages,
} from '../../../shared/console-analytics'
import { RoutePath } from '../../../shared/console-routes'
import { AuthContext } from '../common/decorators/auth-context.decorator'
import type { AuthContext as Principal } from '../common/interfaces/auth-context.interface'
import { AnalyticsService } from './services/analytics.service'
import { AnalyticsConsentService } from './services/analytics-consent.service'

class ConsentChoice {
  @IsBoolean() allowed: boolean
  @IsIn([analyticsNoticeVersion]) version: number
}

class ConsoleEvent {
  @IsIn(['$pageview', 'console_control_click']) event: '$pageview' | 'console_control_click'
  @IsIn(consolePages) page: RoutePath
  @IsISO8601({ strict: true }) occurredAt: string
  @IsOptional() @IsIn(consoleControls) control?: string
  @IsOptional() @IsIn(consolePages) destination?: RoutePath
  @IsOptional() @IsIn(consoleActions) action?: string
  @IsOptional() @IsIn(billingTabs) billingTab?: string
}

@ApiExcludeController()
@UseGuards(AuthGuard('jwt'))
@Controller('analytics')
export class ConsoleAnalyticsController {
  constructor(
    private readonly consent: AnalyticsConsentService,
    private readonly analytics: AnalyticsService,
  ) {}

  @Get('consent')
  preference(@AuthContext() actor: Principal) {
    return this.consent.preference(actor.userId)
  }

  @Get('organizations/:organizationId/consent')
  async consolePreference(
    @AuthContext() actor: Principal,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
  ) {
    return this.consent.consolePreference(actor.userId, organizationId)
  }

  @Put('consent')
  decide(@AuthContext() actor: Principal, @Body() choice: ConsentChoice) {
    return this.consent.decide(actor.userId, choice.allowed)
  }

  @Post('organizations/:organizationId/console-events')
  @HttpCode(204)
  async record(
    @AuthContext() actor: Principal,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() input: ConsoleEvent,
  ) {
    await this.consent.requireMember(actor.userId, organizationId)
    if (input.event === 'console_control_click' && !input.control) throw new BadRequestException('Missing control')
    this.analytics.capture(
      {
        event: input.event,
        distinctId: actor.userId,
        groups: { organization: organizationId },
        timestamp: new Date(input.occurredAt),
        properties: {
          $pathname: input.page,
          ...(input.page === RoutePath.BILLING && input.billingTab && { billing_tab: input.billingTab }),
          ...(input.event === 'console_control_click' && {
            control: input.control,
            action: input.action,
            destination: input.destination,
          }),
        },
      },
      { users: [actor.userId], organizations: [organizationId] },
    )
  }
}
