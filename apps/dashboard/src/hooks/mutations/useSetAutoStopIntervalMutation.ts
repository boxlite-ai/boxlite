import { useApi } from '@/hooks/useApi'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { queryKeys } from '@/hooks/queries/queryKeys'
import { useMutation, useQueryClient } from '@tanstack/react-query'

type SetAutoStopIntervalVariables = {
  boxId: string
  interval: number
}

export const useSetAutoStopIntervalMutation = () => {
  const { boxApi } = useApi()
  const { selectedOrganization } = useSelectedOrganization()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ boxId, interval }: SetAutoStopIntervalVariables) => {
      if (!selectedOrganization?.id) throw new Error('Missing organization')
      return (await boxApi.setAutoStopInterval(boxId, interval, selectedOrganization.id)).data
    },
    onSuccess: (_, { boxId }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.boxes.detail(selectedOrganization?.id ?? '', boxId),
      })
    },
  })
}
