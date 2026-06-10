/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  OnApplicationShutdown,
  Logger,
} from '@nestjs/common'
import { Observable } from 'rxjs'
import { tap } from 'rxjs/operators'
import { PostHog } from 'posthog-node'
import { BoxDto } from '../box/dto/box.dto'
import { CreateBoxDto } from '../box/dto/create-box.dto'
import { Request } from 'express'
import { CreateOrganizationDto } from '../organization/dto/create-organization.dto'
import { OrganizationDto } from '../organization/dto/organization.dto'
import { UpdateOrganizationMemberAccessDto } from '../organization/dto/update-organization-member-access.dto'
import { CreateOrganizationRoleDto } from '../organization/dto/create-organization-role.dto'
import { UpdateOrganizationRoleDto } from '../organization/dto/update-organization-role.dto'
import { CreateOrganizationInvitationDto } from '../organization/dto/create-organization-invitation.dto'
import { UpdateOrganizationInvitationDto } from '../organization/dto/update-organization-invitation.dto'
import { CustomHeaders } from '../common/constants/header.constants'
import { CreateVolumeDto } from '../box/dto/create-volume.dto'
import { VolumeDto } from '../box/dto/volume.dto'
import { CreateWorkspaceDto } from '../box/dto/create-workspace.deprecated.dto'
import { WorkspaceDto } from '../box/dto/workspace.deprecated.dto'
import { TypedConfigService } from '../config/typed-config.service'
import { UpdateOrganizationDefaultRegionDto } from '../organization/dto/update-organization-default-region.dto'

type RequestWithUser = Request & {
  user?: { userId: string; organizationId: string }
  params: Record<string, string>
}
type CommonCaptureProps = {
  organizationId?: string
  distinctId: string
  durationMs: number
  statusCode: number
  userAgent: string
  error?: string
  source: string
  isDeprecated?: boolean
  sdkVersion?: string
  environment?: string
}

@Injectable()
export class MetricsInterceptor implements NestInterceptor, OnApplicationShutdown {
  private readonly posthog?: PostHog
  private readonly version: string
  private readonly logger = new Logger(MetricsInterceptor.name)

  constructor(private readonly configService: TypedConfigService) {
    this.version = this.configService.getOrThrow('version')

    if (!this.configService.get('posthog.apiKey')) {
      this.logger.warn('POSTHOG_API_KEY is not set, metrics will not be recorded')
      return
    }

    if (!this.configService.get('posthog.host')) {
      this.logger.warn('POSTHOG_HOST is not set, metrics will not be recorded')
      return
    }

    // Initialize PostHog client
    // Make sure to set POSTHOG_API_KEY in your environment variables
    this.posthog = new PostHog(this.configService.getOrThrow('posthog.apiKey'), {
      host: this.configService.getOrThrow('posthog.host'),
    })
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    if (!this.posthog) {
      return next.handle()
    }

    const request = context.switchToHttp().getRequest()
    const startTime = Date.now()

    return next.handle().pipe(
      tap({
        next: (response) => {
          // For DELETE requests or empty responses, pass an empty object with statusCode
          const responseObj = response || { statusCode: 204 }
          this.recordMetrics(request, responseObj, startTime).catch((err) => this.logger.error(err))
        },
        error: (error) => {
          this.recordMetrics(
            request,
            { statusCode: error.status || 500 },
            startTime,
            error.message || JSON.stringify(error),
          ).catch((err) => this.logger.error(err))
        },
      }),
    )
  }

  private async recordMetrics(request: RequestWithUser, response: any, startTime: number, error?: string) {
    const durationMs = Date.now() - startTime
    const statusCode = error ? response.statusCode : response.statusCode || (request.method === 'DELETE' ? 204 : 200) // Default to 204 for DELETE requests
    const distinctId = request.user?.userId || 'anonymous'
    const userAgent = request.get('user-agent')
    const source = request.get(CustomHeaders.SOURCE.name)
    const sdkVersion = request.get(CustomHeaders.SDK_VERSION.name)

    const props: CommonCaptureProps = {
      distinctId,
      organizationId: request.user?.organizationId,
      durationMs,
      statusCode,
      userAgent,
      error,
      source: Array.isArray(source) ? source[0] : source,
      isDeprecated: request.route.path.includes('/workspace') || request.route.path.includes('/images'),
      sdkVersion,
      environment: this.configService.get('posthog.environment'),
    }

    switch (request.method) {
      case 'POST':
        switch (request.route.path) {
          case '/api/api-keys':
            this.captureCreateApiKey(props)
            break
          // TODO(image-rewrite): /api/templates metrics removed with box_template.
          case '/api/box':
            this.captureCreateBox(props, request.body, response)
            break
          case '/api/workspace':
            this.captureCreateWorkspace_deprecated(props, request.body, response)
            break
          case '/api/box/:boxIdOrName/start':
          case '/api/workspace/:workspaceId/start':
          case '/api/v1/boxes/:boxId/start':
          case '/api/v1/:prefix/boxes/:boxId/start':
            this.captureStartBox(
              props,
              request.params.boxIdOrName || request.params.workspaceId || request.params.boxId,
            )
            break
          case '/api/box/:boxIdOrName/stop':
          case '/api/workspace/:workspaceId/stop':
          case '/api/v1/boxes/:boxId/stop':
          case '/api/v1/:prefix/boxes/:boxId/stop':
            this.captureStopBox(
              props,
              request.params.boxIdOrName || request.params.workspaceId || request.params.boxId,
              request.query?.force === 'true',
            )
            break
          case '/api/box/:boxIdOrName/resize':
            this.captureResizeBox(props, request.params.boxIdOrName, request.body)
            break
          case '/api/box/:boxIdOrName/public/:isPublic':
          case '/api/workspace/:workspaceId/public/:isPublic':
            this.captureUpdatePublicStatus(
              props,
              request.params.boxIdOrName || request.params.workspaceId,
              request.params.isPublic === 'true',
            )
            break
          case '/api/box/:boxIdOrName/autostop/:interval':
          case '/api/workspace/:workspaceId/autostop/:interval':
            this.captureSetAutostopInterval(
              props,
              request.params.boxIdOrName || request.params.workspaceId,
              parseInt(request.params.interval),
            )
            break
          case '/api/box/:boxIdOrName/autodelete/:interval':
            this.captureSetAutoDeleteInterval(props, request.params.boxIdOrName, parseInt(request.params.interval))
            break
          case '/api/organizations/invitations/:invitationId/accept':
            this.captureAcceptInvitation(props, request.params.invitationId)
            break
          case '/api/organizations/invitations/:invitationId/decline':
            this.captureDeclineInvitation(props, request.params.invitationId)
            break
          case '/api/organizations':
            this.captureCreateOrganization(props, request.body, response)
            break
          case '/api/organizations/:organizationId/leave':
            this.captureLeaveOrganization(props, request.params.organizationId)
            break
          case '/api/organizations/:organizationId/users/:userId/access':
            this.captureUpdateOrganizationUserAccess(
              props,
              request.params.organizationId,
              request.params.userId,
              request.body,
            )
            break
          case '/api/organizations/:organizationId/roles':
            this.captureCreateOrganizationRole(props, request.params.organizationId, request.body)
            break
          case '/api/organizations/:organizationId/invitations':
            this.captureCreateOrganizationInvitation(props, request.params.organizationId, request.body)
            break
          case '/api/organizations/:organizationId/invitations/:invitationId/cancel':
            this.captureCancelOrganizationInvitation(props, request.params.organizationId, request.params.invitationId)
            break
          case '/api/volumes':
            this.captureCreateVolume(props, request.body, response)
            break
        }
        break
      case 'DELETE':
        switch (request.route.path) {
          case '/api/box/:boxIdOrName':
          case '/api/workspace/:workspaceId':
          case '/api/v1/boxes/:boxId':
          case '/api/v1/:prefix/boxes/:boxId':
            this.captureDeleteBox(
              props,
              request.params.boxIdOrName || request.params.workspaceId || request.params.boxId,
            )
            break
          // TODO(image-rewrite): /api/templates delete metrics removed with box_template.
          case '/api/organizations/:organizationId':
            this.captureDeleteOrganization(props, request.params.organizationId)
            break
          case '/api/organizations/:organizationId/users/:userId':
            this.captureDeleteOrganizationUser(props, request.params.organizationId, request.params.userId)
            break
          case '/api/organizations/:organizationId/roles/:roleId':
            this.captureDeleteOrganizationRole(props, request.params.organizationId, request.params.roleId)
            break
          case '/api/volumes/:volumeId':
            this.captureDeleteVolume(props, request.params.volumeId)
            break
        }
        break
      case 'PUT':
        switch (request.route.path) {
          case '/api/box/:boxIdOrName/labels':
          case '/api/workspace/:workspaceId/labels':
            this.captureUpdateBoxLabels(props, request.params.boxIdOrName || request.params.workspaceId)
            break
          case '/api/organizations/:organizationId/roles/:roleId':
            this.captureUpdateOrganizationRole(
              props,
              request.params.organizationId,
              request.params.roleId,
              request.body,
            )
            break
          case '/api/organizations/:organizationId/invitations/:invitationId':
            this.captureUpdateOrganizationInvitation(
              props,
              request.params.organizationId,
              request.params.invitationId,
              request.body,
            )
            break
          case '/api/organizations/:organizationId/experimental-config':
            this.captureUpdateOrganizationExperimentalConfig(props, request.body)
            break
        }
        break
      case 'PATCH':
        switch (request.route.path) {
          case '/api/organizations/:organizationId/default-region':
            this.captureSetOrganizationDefaultRegion(props, request.params.organizationId, request.body)
            break
        }
        break
    }

    if (!request.route.path.startsWith('/api/toolbox/:boxId/toolbox')) {
      return
    }

    const path = request.route.path.replace('/api/toolbox/:boxId/toolbox', '')

    switch (path) {
      case '/project-dir':
        this.captureToolboxCommand(props, request.params.boxId, 'project-dir_get')
        break
      case '/files':
        switch (request.method) {
          case 'GET':
            this.captureToolboxCommand(props, request.params.boxId, 'files_list')
            break
          case 'DELETE':
            this.captureToolboxCommand(props, request.params.boxId, 'files_delete')
            break
        }
        break
      case '/files/download':
        this.captureToolboxCommand(props, request.params.boxId, 'files_download')
        break
      case '/files/find':
        this.captureToolboxCommand(props, request.params.boxId, 'files_find')
        break
      case '/files/folder':
        this.captureToolboxCommand(props, request.params.boxId, 'files_folder_create')
        break
      case '/files/info':
        this.captureToolboxCommand(props, request.params.boxId, 'files_info')
        break
      case '/files/move':
        this.captureToolboxCommand(props, request.params.boxId, 'files_move')
        break
      case '/files/permissions':
        this.captureToolboxCommand(props, request.params.boxId, 'files_permissions')
        break
      case '/files/replace':
        this.captureToolboxCommand(props, request.params.boxId, 'files_replace')
        break
      case '/files/search':
        this.captureToolboxCommand(props, request.params.boxId, 'files_search')
        break
      case '/files/upload':
        this.captureToolboxCommand(props, request.params.boxId, 'files_upload')
        break
      case '/git/add':
        this.captureToolboxCommand(props, request.params.boxId, 'git_add')
        break
      case '/git/branches':
        switch (request.method) {
          case 'GET':
            this.captureToolboxCommand(props, request.params.boxId, 'git_branches_list')
            break
          case 'POST':
            this.captureToolboxCommand(props, request.params.boxId, 'git_branches_create')
            break
        }
        break
      case '/git/clone':
        this.captureToolboxCommand(props, request.params.boxId, 'git_clone')
        break
      case '/git/commit':
        this.captureToolboxCommand(props, request.params.boxId, 'git_commit')
        break
      case '/git/history':
        this.captureToolboxCommand(props, request.params.boxId, 'git_history')
        break
      case '/git/pull':
        this.captureToolboxCommand(props, request.params.boxId, 'git_pull')
        break
      case '/git/push':
        this.captureToolboxCommand(props, request.params.boxId, 'git_push')
        break
      case '/git/status':
        this.captureToolboxCommand(props, request.params.boxId, 'git_status')
        break
      case '/process/execute':
        this.captureToolboxCommand(props, request.params.boxId, 'process_execute', {
          command: request.body.command,
          cwd: request.body.cwd,
          exit_code: response.exitCode,
          timeout_sec: request.body.timeout,
        })
        break
      case '/process/session':
        switch (request.method) {
          case 'GET':
            this.captureToolboxCommand(props, request.params.boxId, 'process_session_list')
            break
          case 'POST':
            this.captureToolboxCommand(props, request.params.boxId, 'process_session_create', {
              session_id: request.body.sessionId,
            })
            break
        }
        break
      case '/process/session/:sessionId':
        switch (request.method) {
          case 'GET':
            this.captureToolboxCommand(props, request.params.boxId, 'process_session_get', {
              session_id: request.params.sessionId,
            })
            break
          case 'DELETE':
            this.captureToolboxCommand(props, request.params.boxId, 'process_session_delete', {
              session_id: request.params.sessionId,
            })
            break
        }
        break
      case '/process/session/:sessionId/exec':
        this.captureToolboxCommand(props, request.params.boxId, 'process_session_execute', {
          session_id: request.params.sessionId,
          command: request.body.command,
        })
        break
      case '/process/session/:sessionId/command/:commandId':
        this.captureToolboxCommand(props, request.params.boxId, 'process_session_command_get', {
          session_id: request.params.sessionId,
          command_id: request.params.commandId,
        })
        break
      case '/process/session/:sessionId/command/:commandId/logs':
        this.captureToolboxCommand(props, request.params.boxId, 'process_session_command_logs', {
          session_id: request.params.sessionId,
          command_id: request.params.commandId,
        })
        break
      case '/lsp/completions':
        this.captureToolboxCommand(props, request.params.boxId, 'lsp_completions')
        break
      case '/lsp/did-close':
        this.captureToolboxCommand(props, request.params.boxId, 'lsp_did_close')
        break
      case '/lsp/did-open':
        this.captureToolboxCommand(props, request.params.boxId, 'lsp_did_open')
        break
      case '/lsp/document-symbols':
        this.captureToolboxCommand(props, request.params.boxId, 'lsp_document_symbols')
        break
      case '/lsp/start':
        this.captureToolboxCommand(props, request.params.boxId, 'lsp_start', {
          language_id: request.body.languageId,
        })
        break
      case '/lsp/stop':
        this.captureToolboxCommand(props, request.params.boxId, 'lsp_stop', {
          language_id: request.body.languageId,
        })
        break
      case '/lsp/box-symbols':
        this.captureToolboxCommand(props, request.params.boxId, 'lsp_box_symbols', {
          language_id: request.query.languageId,
          path_to_project: request.query.pathToProject,
          query: request.query.query,
        })
        break
    }
  }

  private captureCreateApiKey(props: CommonCaptureProps) {
    this.capture('api_api_key_created', props, 'api_api_key_creation_failed')
  }

  // TODO(image-rewrite): template create/activate/deactivate/delete metrics removed with box_template.

  private captureCreateBox(props: CommonCaptureProps, request: CreateBoxDto, response: BoxDto) {
    const envVarsLength = request.env ? Object.keys(request.env).length : 0

    const records = {
      box_id: response.id,
      box_name_request: request.name,
      box_name: response.name,
      box_user_request: request.user,
      box_user: response.user,
      box_cpu_request: request.cpu,
      box_cpu: response.cpu,
      box_gpu_request: request.gpu,
      box_gpu: response.gpu,
      box_memory_mb_request: request.memory * 1024,
      box_memory_mb: response.memory * 1024,
      box_disk_gb_request: request.disk,
      box_disk_gb: response.disk,
      box_target_request: request.target,
      box_target: response.target,
      box_auto_stop_interval_min_request: request.autoStopInterval,
      box_auto_stop_interval_min: response.autoStopInterval,
      box_auto_delete_interval_min_request: request.autoDeleteInterval,
      box_auto_delete_interval_min: response.autoDeleteInterval,
      box_public_request: request.public,
      box_public: response.public,
      box_labels_request: request.labels,
      box_labels: response.labels,
      box_env_vars_length_request: envVarsLength,
      box_volumes_length_request: request.volumes?.length,
      box_daemon_version: response.daemonVersion,
      box_network_block_all_request: request.networkBlockAll,
      box_network_block_all: response.networkBlockAll,
      box_network_allow_list_set_request: !!request.networkAllowList,
      box_network_allow_list_set: !!response.networkAllowList,
    }

    this.capture('api_box_created', props, 'api_box_creation_failed', records)
  }

  private captureCreateWorkspace_deprecated(
    props: CommonCaptureProps,
    request: CreateWorkspaceDto,
    response: WorkspaceDto,
  ) {
    const envVarsLength = request.env ? Object.keys(request.env).length : 0

    const records = {
      box_id: response.id,
      box_user_request: request.user,
      box_user: response.user,
      box_cpu_request: request.cpu,
      box_cpu: response.cpu,
      box_gpu_request: request.gpu,
      box_gpu: response.gpu,
      box_memory_mb_request: request.memory * 1024,
      box_memory_mb: response.memory * 1024,
      box_disk_gb_request: request.disk,
      box_disk_gb: response.disk,
      box_target_request: request.target,
      box_target: response.target,
      box_auto_stop_interval_min_request: request.autoStopInterval,
      box_auto_stop_interval_min: response.autoStopInterval,
      box_public_request: request.public,
      box_public: response.public,
      box_labels_request: request.labels,
      box_labels: response.labels,
      box_env_vars_length_request: envVarsLength,
      box_volumes_length_request: request.volumes?.length,
      box_daemon_version: response.daemonVersion,
    }

    this.capture('api_box_created', props, 'api_box_creation_failed', records)
  }

  private captureDeleteBox(props: CommonCaptureProps, boxId: string) {
    this.capture('api_box_deleted', props, 'api_box_deletion_failed', {
      box_id: boxId,
    })
  }

  private captureStartBox(props: CommonCaptureProps, boxId: string) {
    this.capture('api_box_started', props, 'api_box_start_failed', {
      box_id: boxId,
    })
  }

  private captureStopBox(props: CommonCaptureProps, boxId: string, force: boolean) {
    this.capture('api_box_stopped', props, 'api_box_stop_failed', {
      box_id: boxId,
      force,
    })
  }

  private captureResizeBox(
    props: CommonCaptureProps,
    boxId: string,
    body: { cpu?: number; memory?: number; disk?: number },
  ) {
    this.capture('api_box_resized', props, 'api_box_resize_failed', {
      box_id: boxId,
      cpu: body?.cpu,
      memory: body?.memory,
      disk: body?.disk,
    })
  }

  private captureUpdatePublicStatus(props: CommonCaptureProps, boxId: string, isPublic: boolean) {
    this.capture('api_box_public_status_updated', props, 'api_box_public_status_update_failed', {
      box_id: boxId,
      box_public: isPublic,
    })
  }

  private captureSetAutostopInterval(props: CommonCaptureProps, boxId: string, interval: number) {
    this.capture('api_box_autostop_interval_updated', props, 'api_box_autostop_interval_update_failed', {
      box_id: boxId,
      box_autostop_interval: interval,
    })
  }

  private captureSetAutoDeleteInterval(props: CommonCaptureProps, boxId: string, interval: number) {
    this.capture('api_box_autodelete_interval_updated', props, 'api_box_autodelete_interval_update_failed', {
      box_id: boxId,
      box_autodelete_interval: interval,
    })
  }

  private captureUpdateBoxLabels(props: CommonCaptureProps, boxId: string) {
    this.capture('api_box_labels_update', props, 'api_box_labels_update_failed', {
      box_id: boxId,
    })
  }

  private captureAcceptInvitation(props: CommonCaptureProps, invitationId: string) {
    this.capture('api_invitation_accepted', props, 'api_invitation_accept_failed', {
      invitation_id: invitationId,
    })
  }

  private captureDeclineInvitation(props: CommonCaptureProps, invitationId: string) {
    this.capture('api_invitation_declined', props, 'api_invitation_decline_failed', {
      invitation_id: invitationId,
    })
  }

  private captureCreateOrganization(
    props: CommonCaptureProps,
    request: CreateOrganizationDto,
    response: OrganizationDto,
  ) {
    if (!this.posthog) {
      return
    }

    this.posthog.groupIdentify({
      groupType: 'organization',
      groupKey: response.id,
      properties: {
        name: request.name,
        created_at: response.createdAt,
        created_by: response.createdBy,
        is_default_for_authenticated_user: response.isDefaultForAuthenticatedUser,
        environment: this.configService.get('posthog.environment'),
      },
    })

    this.capture('api_organization_created', props, 'api_organization_creation_failed', {
      organization_id: response.id,
      organization_name: request.name,
      organization_default_region_id: request.defaultRegionId,
    })
  }

  private captureLeaveOrganization(props: CommonCaptureProps, organizationId: string) {
    this.capture('api_organization_left', props, 'api_organization_leave_failed', {
      organization_id: organizationId,
    })
  }

  private captureSetOrganizationDefaultRegion(
    props: CommonCaptureProps,
    organizationId: string,
    request: UpdateOrganizationDefaultRegionDto,
  ) {
    this.capture('api_organization_default_region_set', props, 'api_organization_default_region_set_failed', {
      organization_id: organizationId,
      organization_default_region_id: request.defaultRegionId,
    })
  }

  private captureDeleteOrganization(props: CommonCaptureProps, organizationId: string) {
    this.capture('api_organization_deleted', props, 'api_organization_deletion_failed', {
      organization_id: organizationId,
    })
  }

  private captureUpdateOrganizationUserAccess(
    props: CommonCaptureProps,
    organizationId: string,
    userId: string,
    request: UpdateOrganizationMemberAccessDto,
  ) {
    this.capture('api_organization_user_access_updated', props, 'api_organization_user_access_update_failed', {
      organization_id: organizationId,
      organization_user_id: userId,
      organization_user_role: request.role,
      organization_user_assigned_role_ids: request.assignedRoleIds,
    })
  }

  private captureDeleteOrganizationUser(props: CommonCaptureProps, organizationId: string, userId: string) {
    this.capture('api_organization_user_deleted', props, 'api_organization_user_deletion_failed', {
      organization_id: organizationId,
      organization_user_id: userId,
    })
  }

  private captureCreateOrganizationRole(
    props: CommonCaptureProps,
    organizationId: string,
    request: CreateOrganizationRoleDto,
  ) {
    this.capture('api_organization_role_created', props, 'api_organization_role_creation_failed', {
      organization_id: organizationId,
      organization_role_name: request.name,
      organization_role_description: request.description,
      organization_role_permissions: request.permissions,
    })
  }

  private captureDeleteOrganizationRole(props: CommonCaptureProps, organizationId: string, roleId: string) {
    this.capture('api_organization_role_deleted', props, 'api_organization_role_deletion_failed', {
      organization_id: organizationId,
      organization_role_id: roleId,
    })
  }

  private captureUpdateOrganizationRole(
    props: CommonCaptureProps,
    organizationId: string,
    roleId: string,
    request: UpdateOrganizationRoleDto,
  ) {
    this.capture('api_organization_role_updated', props, 'api_organization_role_update_failed', {
      organization_id: organizationId,
      organization_role_id: roleId,
      organization_role_name: request.name,
      organization_role_description: request.description,
      organization_role_permissions: request.permissions,
    })
  }

  private captureCreateOrganizationInvitation(
    props: CommonCaptureProps,
    organizationId: string,
    request: CreateOrganizationInvitationDto,
  ) {
    this.capture('api_organization_invitation_created', props, 'api_organization_invitation_creation_failed', {
      organization_id: organizationId,
      organization_invitation_email: request.email,
      organization_invitation_role: request.role,
      organization_invitation_assigned_role_ids: request.assignedRoleIds,
      organization_invitation_expires_at: request.expiresAt,
    })
  }

  private captureUpdateOrganizationInvitation(
    props: CommonCaptureProps,
    organizationId: string,
    invitationId: string,
    request: UpdateOrganizationInvitationDto,
  ) {
    this.capture('api_organization_invitation_updated', props, 'api_organization_invitation_update_failed', {
      organization_id: organizationId,
      organization_invitation_id: invitationId,
      organization_invitation_expires_at: request.expiresAt,
      organization_invitation_role: request.role,
      organization_invitation_assigned_role_ids: request.assignedRoleIds,
    })
  }

  private captureCancelOrganizationInvitation(props: CommonCaptureProps, organizationId: string, invitationId: string) {
    this.capture('api_organization_invitation_canceled', props, 'api_organization_invitation_cancel_failed', {
      organization_id: organizationId,
      organization_invitation_id: invitationId,
    })
  }

  private captureCreateVolume(props: CommonCaptureProps, request: CreateVolumeDto, response: VolumeDto) {
    this.capture('api_volume_created', props, 'api_volume_creation_failed', {
      volume_id: response.id,
      volume_name_request_set: !!request.name,
    })
  }

  private captureDeleteVolume(props: CommonCaptureProps, volumeId: string) {
    this.capture('api_volume_deleted', props, 'api_volume_deletion_failed', {
      volume_id: volumeId,
    })
  }

  private captureUpdateOrganizationExperimentalConfig(
    props: CommonCaptureProps,
    experimentalConfig: Record<string, any> | null,
  ) {
    this.capture(
      'api_organization_experimental_config_updated',
      props,
      'api_organization_experimental_config_update_failed',
      {
        experimental_config_empty: !experimentalConfig,
        experimental_config_otel_set: !!experimentalConfig?.otel,
      },
    )
  }

  private captureToolboxCommand(
    props: CommonCaptureProps,
    boxId: string,
    command: string,
    extraProps?: Record<string, any>,
  ) {
    this.capture('api_toolbox_command', props, 'api_toolbox_command_failed', {
      box_id: boxId,
      toolbox_command: command,
      ...extraProps,
    })
  }

  private capture(event: string, props: CommonCaptureProps, errorEvent?: string, extraProps?: Record<string, any>) {
    if (!this.posthog) {
      return
    }

    this.posthog.capture({
      distinctId: props.distinctId,
      event: props.error ? errorEvent || event : event,
      groups: this.captureCommonGroups(props),
      properties: { ...this.captureCommonProperties(props), ...extraProps },
    })
  }

  private captureCommonProperties(props: CommonCaptureProps) {
    return {
      duration_ms: props.durationMs,
      status_code: props.statusCode,
      user_agent: props.userAgent,
      error: props.error,
      source: props.source,
      is_deprecated: props.isDeprecated,
      sdk_version: props.sdkVersion,
      environment: props.environment,
      boxlite_version: this.version,
    }
  }

  private captureCommonGroups(props: CommonCaptureProps) {
    return props.organizationId ? { organization: props.organizationId } : undefined
  }

  onApplicationShutdown(/*signal?: string*/) {
    if (this.posthog) {
      this.posthog.shutdown()
    }
  }
}
