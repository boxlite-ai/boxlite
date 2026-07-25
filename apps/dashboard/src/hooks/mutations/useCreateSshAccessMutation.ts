/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { CreateBoxAccessGrantScopesEnum } from '@boxlite-ai/api-client'
import { useApi } from '@/hooks/useApi'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { useMutation } from '@tanstack/react-query'
import { generateEphemeralSshKeyPair } from '@/lib/ssh-keypair'

interface CreateSshAccessVariables {
  boxId: string
  expiresInSeconds: number
}

// The dashboard is already account-authenticated, so it doesn't need the
// `X-BoxLite-App-Key` path meant for non-org callers (e.g. the SDK helper):
// it mints a short-lived `ssh`-scoped grant for itself first, then creates
// the credential against that grant. The private key is generated in the
// browser and only its public half is ever sent to the API.
export const useCreateSshAccessMutation = () => {
  const { boxAccessGrantApi, sshAccessApi } = useApi()
  const { selectedOrganization } = useSelectedOrganization()

  return useMutation({
    mutationFn: async ({ boxId, expiresInSeconds }: CreateSshAccessVariables) => {
      const { publicKeyLine, privateKeyPem } = await generateEphemeralSshKeyPair(`boxlite-dashboard-${boxId}`)

      const grant = await boxAccessGrantApi.createBoxAccessGrant(
        boxId,
        { scopes: [CreateBoxAccessGrantScopesEnum.SSH], expiresInSeconds },
        selectedOrganization?.id,
      )

      const credential = await sshAccessApi.createTemporarySshCredential(
        boxId,
        { grantId: grant.data.id, publicKey: publicKeyLine, expiresInSeconds },
        undefined,
        selectedOrganization?.id,
      )

      return { ...credential.data, privateKeyPem }
    },
  })
}
