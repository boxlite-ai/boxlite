/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { RoutePath } from '@/enums/RoutePath'
import { Navigate } from 'react-router-dom'

function Onboarding() {
  return <Navigate to={`${RoutePath.BOXES}?onboarding=1`} replace />
}

export default Onboarding
