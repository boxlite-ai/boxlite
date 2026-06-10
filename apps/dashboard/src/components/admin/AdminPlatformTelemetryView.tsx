/*
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import React from 'react'
import { type AdminBox } from './adminHelpers'
import AdminTelemetryPanel from './AdminTelemetryPanel'

interface AdminPlatformTelemetryViewProps {
  contextBox?: AdminBox | null
  onDiagnoseTrace?: (traceId: string) => void
  onDiagnoseExecution?: (executionId: string, traceId?: string) => void
  onDiagnoseJob?: (jobId: string, traceId?: string) => void
  onDiagnoseRequest?: (requestId: string, traceId?: string) => void
}

const AdminPlatformTelemetryView: React.FC<AdminPlatformTelemetryViewProps> = ({
  contextBox,
  onDiagnoseTrace,
  onDiagnoseExecution,
  onDiagnoseJob,
  onDiagnoseRequest,
}) => {
  const preset = contextBox
    ? {
        boxId: contextBox.id,
        runnerId: contextBox.runnerId ?? undefined,
      }
    : undefined

  return (
    <AdminTelemetryPanel
      title={contextBox ? 'Box Telemetry' : 'Platform Telemetry'}
      description={
        contextBox
          ? 'Logs, traces, metrics, and investigation evidence scoped to this box.'
          : 'Four-layer Admin observability across API, runner, EC2 host, and boxes, backed by the shared Admin API used by UI, CLI, and agents.'
      }
      preset={preset}
      compact={false}
      onDiagnoseTrace={onDiagnoseTrace}
      onDiagnoseExecution={onDiagnoseExecution}
      onDiagnoseJob={onDiagnoseJob}
      onDiagnoseRequest={onDiagnoseRequest}
    />
  )
}

export default AdminPlatformTelemetryView
