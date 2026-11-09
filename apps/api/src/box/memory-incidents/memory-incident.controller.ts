import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Post,
  Query,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common'
import {
  ApiBearerAuth,
  ApiExcludeController,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { RunnerAuthGuard } from '../../auth/runner-auth.guard'
import { SystemActionGuard } from '../../auth/system-action.guard'
import { RequiredApiRole } from '../../common/decorators/required-role.decorator'
import { RunnerContextDecorator } from '../../common/decorators/runner-context.decorator'
import { RunnerContext } from '../../common/interfaces/runner-context.interface'
import { SystemRole } from '../../user/enums/system-role.enum'
import { ListMemoryIncidentsDto, RunnerMemoryIncidentDto } from './memory-incident.dto'
import { MemoryIncidentListDto } from './memory-incident.entity'
import { MemoryIncidentService } from './memory-incident.service'

@ApiExcludeController()
@Controller('runners/me/memory-incidents')
@UseGuards(CombinedAuthGuard, RunnerAuthGuard)
@UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
export class RunnerMemoryIncidentController {
  constructor(private readonly incidents: MemoryIncidentService) {}

  @Post()
  @HttpCode(204)
  @ApiNoContentResponse()
  record(@RunnerContextDecorator() runner: RunnerContext, @Body() report: RunnerMemoryIncidentDto): Promise<void> {
    return this.incidents.record(runner.runnerId, report)
  }
}

@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/runner-memory-incidents')
@UseGuards(CombinedAuthGuard, SystemActionGuard)
@RequiredApiRole([SystemRole.ADMIN])
@UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
export class AdminRunnerMemoryIncidentController {
  constructor(private readonly incidents: MemoryIncidentService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({
    operationId: 'adminListRunnerMemoryIncidents',
    summary: 'Query runner memory snapshots by host sample time range',
  })
  @ApiOkResponse({ type: MemoryIncidentListDto })
  list(@Query() query: ListMemoryIncidentsDto): Promise<MemoryIncidentListDto> {
    return this.incidents.list(query)
  }
}
