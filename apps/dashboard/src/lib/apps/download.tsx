/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import { queryKeys } from '@/hooks/queries/queryKeys'
import { handleApiError } from '@/lib/error-handling'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState, type ComponentProps } from 'react'
import { useAppsScope } from './client'

/** Downloads and previews use the same bearer as management requests, never a console cookie. */
export function AppDownload({
  path,
  filename,
  children,
  disabled,
  ...props
}: Omit<ComponentProps<'button'>, 'onClick'> & { path: string; filename?: string }) {
  const { client } = useAppsScope()
  const [pending, setPending] = useState(false)
  const download = async () => {
    setPending(true)
    try {
      const response = await client.get<Blob>(path, { responseType: 'blob' })
      const url = URL.createObjectURL(response.data)
      const link = document.createElement('a')
      link.href = url
      link.download =
        filename ??
        /filename="?([^";]+)/i.exec(String(response.headers['content-disposition'] ?? ''))?.[1] ??
        'download'
      link.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 0)
    } catch (error) {
      handleApiError(error, 'Could not download the file')
    } finally {
      setPending(false)
    }
  }
  return (
    <button {...props} type="button" disabled={disabled || pending} onClick={() => void download()}>
      {children}
    </button>
  )
}

export function AppImage({ path, ...props }: Omit<ComponentProps<'img'>, 'src'> & { path: string }) {
  const { client, organizationId, canRead } = useAppsScope()
  const { data } = useQuery({
    queryKey: [...queryKeys.apps.organization(organizationId), 'image', path],
    queryFn: async ({ signal }) => (await client.get<Blob>(path, { signal, responseType: 'blob' })).data,
    enabled: !!organizationId && canRead,
    staleTime: 5 * 60_000,
    retry: false,
  })
  const [url, setUrl] = useState<string>()
  useEffect(() => {
    if (!data) return
    const next = URL.createObjectURL(data)
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [data])
  return <img {...props} src={url} />
}
