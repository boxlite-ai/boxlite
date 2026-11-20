/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import { cn } from '@/lib/utils'
import styles from './AppHostingIllustration.module.css'

/** A short idea-to-app sequence; card placeholders and reduced-motion views stay still. */
export function AppHostingIllustration({ compact = false, className }: { compact?: boolean; className?: string }) {
  return (
    <svg
      viewBox={compact ? '225 10 355 280' : '0 0 640 300'}
      aria-hidden="true"
      className={cn('w-full text-muted-foreground', styles.scene, compact && styles.static, className)}
      fill="none"
    >
      <g stroke="currentColor" strokeWidth="1" opacity="0.13">
        <path d="m243 239 96-55 96 55-96 55-96-55Zm24-14 96 55m-48-83 96 55m-144 0 96-55m-72 69 96-55" />
        <path d="M99 76v10m-5-5h10M550 218v10m-5-5h10M483 39v8m-4-4h8" />
      </g>
      <path
        d="M183 154C231 126 236 199 284 172M389 144C424 156 414 101 446 103"
        className={styles.flow}
        stroke="hsl(var(--brand))"
        strokeWidth="1.5"
      />
      <path
        d="M318 76c-8-25 28-40 43-20 15-16 44-5 40 17 23-1 29 30 9 38"
        stroke="currentColor"
        opacity="0.3"
        strokeWidth="1.5"
      />
      <g className={styles.box} stroke="hsl(var(--brand))" strokeWidth="1.5" strokeLinejoin="round">
        <path d="m291 148 48-28 48 28-48 28-48-28Z" fill="hsl(var(--brand) / 0.14)" />
        <path d="m291 148 48 28v57l-48-28v-57Z" fill="hsl(var(--brand) / 0.06)" />
        <path d="m339 176 48-28v57l-48 28v-57Z" fill="hsl(var(--brand) / 0.2)" />
        <path d="m305 174 18 10m-18 1 11 6m43-7 13-8m-13 18 21-12" opacity="0.8" />
        <path d="m307 111 32-18 32 18" opacity="0.3" />
      </g>
      <g className={styles.window} strokeWidth="1.5">
        <g transform="rotate(-5 474 135)">
          <path d="M416 91h117v88H416Z" fill="hsl(var(--background))" stroke="currentColor" opacity="0.8" />
          <path d="M416 108h117m-105-9h4m5 0h4" stroke="currentColor" opacity="0.4" />
          <path d="M430 122h29v39h-29Z" fill="hsl(var(--brand) / 0.08)" stroke="hsl(var(--brand))" opacity="0.65" />
          <path d="M470 126h48m-48 10h34m-34 10h43" stroke="currentColor" opacity="0.4" />
          <path d="M470 157h23" stroke="hsl(var(--brand))" strokeWidth="3" opacity="0.7" />
          <path d="m523 73 4 4 8-9" stroke="hsl(var(--brand))" />
        </g>
      </g>
      {!compact && (
        <>
          <g className={styles.idea} strokeWidth="1.5" stroke="currentColor">
            <path d="M133 116c-18 0-27 20-15 33 5 5 7 9 7 14h16c0-5 2-9 7-14 12-13 3-33-15-33Zm-7 54h14m-11 6h8" />
            <path d="M133 102V92m-27 20-8-6m62 6 8-6" stroke="hsl(var(--brand))" />
          </g>
          <g className={styles.code} stroke="hsl(var(--brand))" strokeWidth="1.5">
            <path d="m204 82-8 7 8 7m22-14 8 7-8 7m-10-19-5 24" />
            <path d="m207 198-7 6 7 6m19-12 7 6-7 6m-10-16-4 22" opacity="0.35" />
            <path d="M249 119h13m-9-6v12" opacity="0.5" />
          </g>
        </>
      )}
    </svg>
  )
}
