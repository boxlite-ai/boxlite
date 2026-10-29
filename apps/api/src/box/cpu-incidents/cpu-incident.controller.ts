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
import { ListCpuIncidentsDto, RunnerCpuIncidentDto } from './cpu-incident.dto'
import { CpuIncidentListDto } from './cpu-incident.entity'
import { CpuIncidentService } from './cpu-incident.service'

@ApiExcludeController()
@Controller('runners/me/cpu-incidents')
@UseGuards(CombinedAuthGuard, RunnerAuthGuard)
@UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
export class RunnerCpuIncidentController {
  constructor(private readonly incidents: CpuIncidentService) {}

  @Post()
  @HttpCode(204)
  @ApiNoContentResponse()
  record(@RunnerContextDecorator() runner: RunnerContext, @Body() report: RunnerCpuIncidentDto): Promise<void> {
    return this.incidents.record(runner.runnerId, report)
  }
}

@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/runner-cpu-incidents')
@UseGuards(CombinedAuthGuard, SystemActionGuard)
@RequiredApiRole([SystemRole.ADMIN])
@UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
export class AdminRunnerCpuIncidentController {
  constructor(private readonly incidents: CpuIncidentService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({
    operationId: 'adminListRunnerCpuIncidents',
    summary: 'Query sustained runner CPU incidents by capture completion time range',
  })
  @ApiOkResponse({ type: CpuIncidentListDto })
  list(@Query() query: ListCpuIncidentsDto): Promise<CpuIncidentListDto> {
    return this.incidents.list(query)
  }
}
