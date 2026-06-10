/*
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useApi } from '@/hooks/useApi'
import { handleApiError } from '@/lib/error-handling'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import type { AdminBox, AdminMachine, AdminOverview, AdminRunner, AdminUser } from './adminHelpers'

const ADMIN_UI_HEADERS = { 'X-BoxLite-Source': 'ui' } as const

export function useAdminOverview() {
  const { axiosInstance } = useApi()
  return useQuery<AdminOverview>({
    queryKey: ['admin', 'overview'],
    queryFn: () => axiosInstance.get('/admin/overview', { headers: ADMIN_UI_HEADERS }).then((r) => r.data),
    retry: false,
  })
}

export function useAdminUsers() {
  const { axiosInstance } = useApi()
  return useQuery<AdminUser[]>({
    queryKey: ['admin', 'users'],
    queryFn: () => axiosInstance.get('/admin/overview/users', { headers: ADMIN_UI_HEADERS }).then((r) => r.data),
  })
}

export function useAdminBoxes() {
  const { axiosInstance } = useApi()
  return useQuery<AdminBox[]>({
    queryKey: ['admin', 'boxes'],
    queryFn: () => axiosInstance.get('/admin/overview/boxes', { headers: ADMIN_UI_HEADERS }).then((r) => r.data),
  })
}

export function useAdminRunners() {
  const { axiosInstance } = useApi()
  return useQuery<AdminRunner[]>({
    queryKey: ['admin', 'runners'],
    queryFn: () => axiosInstance.get('/admin/overview/runners', { headers: ADMIN_UI_HEADERS }).then((r) => r.data),
  })
}

export function useAdminMachines() {
  const { axiosInstance } = useApi()
  return useQuery<AdminMachine[]>({
    queryKey: ['admin', 'machines'],
    queryFn: () => axiosInstance.get('/admin/overview/machines', { headers: ADMIN_UI_HEADERS }).then((r) => r.data),
  })
}

export function useAdminActions() {
  const { axiosInstance } = useApi()
  const queryClient = useQueryClient()

  const cordon = useMutation({
    mutationFn: (runner: AdminRunner) =>
      axiosInstance.patch(
        `/admin/runners/${runner.id}/scheduling`,
        { unschedulable: !runner.unschedulable },
        { headers: ADMIN_UI_HEADERS },
      ),
    onSuccess: (_data, runner) => {
      toast.success(runner.unschedulable ? 'Runner un-cordoned' : 'Runner cordoned')
      queryClient.invalidateQueries({ queryKey: ['admin', 'runners'] })
    },
    onError: (error) => handleApiError(error, 'Failed to update runner scheduling'),
  })

  const drain = useMutation({
    mutationFn: (runnerId: string) =>
      axiosInstance.patch(`/admin/runners/${runnerId}/draining`, { draining: true }, { headers: ADMIN_UI_HEADERS }),
    onSuccess: () => {
      toast.success('Runner draining')
      queryClient.invalidateQueries({ queryKey: ['admin', 'runners'] })
    },
    onError: (error) => handleApiError(error, 'Failed to drain runner'),
  })

  const recover = useMutation({
    mutationFn: (boxId: string) =>
      axiosInstance.post(`/admin/box/${boxId}/recover`, undefined, { headers: ADMIN_UI_HEADERS }),
    onSuccess: () => {
      toast.success('Box recovery initiated')
      queryClient.invalidateQueries({ queryKey: ['admin', 'boxes'] })
    },
    onError: (error) => handleApiError(error, 'Failed to recover box'),
  })

  return { cordon, drain, recover }
}
