/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { useState } from 'react'
import { UserRound } from '@/components/ui/icon'
import { cn } from '@/lib/utils'

/** Key by account and URL at the caller so old image events cannot cross identities. */
export function AccountAvatar({ src, name }: { src?: string; name: string }) {
  const [status, setStatus] = useState<'loading' | 'loaded' | 'failed'>('loading')
  const initials = name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => Array.from(word)[0])
    .join('')
    .toUpperCase()

  return (
    <span
      aria-hidden="true"
      className="relative flex size-[23px] shrink-0 items-center justify-center overflow-hidden bg-brand text-meta font-bold text-brand-foreground"
    >
      {status !== 'loaded' && (initials || <UserRound className="size-4" />)}
      {src && status !== 'failed' && (
        <img
          src={src}
          alt=""
          className={cn('absolute inset-0 h-full w-full object-cover', status !== 'loaded' && 'invisible')}
          onLoad={() => setStatus('loaded')}
          onError={() => setStatus('failed')}
        />
      )}
    </span>
  )
}
