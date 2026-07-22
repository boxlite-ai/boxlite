/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import boxliteLogoStacked from '@/assets/boxlite-logo-stacked.png'
import LoadingFallback from '@/components/LoadingFallback'
import { Github } from '@/components/ui/icon'
import { RoutePath } from '@/enums/RoutePath'
import { useState } from 'react'
import { useAuth } from 'react-oidc-context'
import { Navigate, useLocation } from 'react-router-dom'

const LandingPage: React.FC = () => {
  const { signinRedirect, isAuthenticated, isLoading } = useAuth()
  const location = useLocation()

  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [remember, setRemember] = useState(true)

  if (isLoading) {
    return <LoadingFallback />
  }

  if (isAuthenticated) {
    return <Navigate to={`${RoutePath.DASHBOARD}${location.search}`} replace />
  }

  // Every entry point hands off to the OIDC hosted login (no client-side auth API).
  const go = () => {
    void signinRedirect({
      state: { returnTo: RoutePath.DASHBOARD + location.search },
      ...(email ? { login_hint: email } : {}),
    })
  }

  const isLogin = mode === 'login'

  // The auth screen is always dark, regardless of the user's saved theme. Scoping the
  // `dark` class here makes the design tokens resolve to their dark values for this
  // subtree only (the rest of the app still follows ThemeContext).
  return (
    <div className="dark flex min-h-screen flex-col overflow-y-auto bg-background font-mono text-[13px] text-foreground">
      <div className="flex flex-1 flex-col items-center justify-center px-6 py-12">
        <div className="w-full max-w-[380px]">
          {/* brand */}
          <div className="mb-[30px] text-center">
            <img
              src={boxliteLogoStacked}
              alt="BoxLite"
              className="mx-auto mb-[14px] block h-[104px] w-auto object-contain"
            />
            <p className="m-0 text-[12px] tracking-[0.3px] text-muted-foreground">
              Agent cloud — secure compute for AI agents.
            </p>
          </div>

          {/* tabs — grayscale fill selection, consistent with the top nav active state */}
          <div className="mb-6 flex border border-border">
            <button
              type="button"
              onClick={() => setMode('login')}
              className={`flex-1 py-[11px] text-center text-[12px] tracking-[1.5px] transition-colors ${
                isLogin ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-card hover:text-foreground'
              }`}
            >
              SIGN IN
            </button>
            <button
              type="button"
              onClick={() => setMode('signup')}
              className={`flex-1 border-l border-border py-[11px] text-center text-[12px] tracking-[1.5px] transition-colors ${
                !isLogin ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-card hover:text-foreground'
              }`}
            >
              SIGN UP
            </button>
          </div>

          {/* SSO */}
          <div className="grid grid-cols-2 gap-[10px]">
            <button
              type="button"
              onClick={go}
              className="flex items-center justify-center gap-[9px] border border-border px-3 py-3 text-[12.5px] transition-colors hover:border-muted-foreground hover:bg-card"
            >
              {/* pixel-art "G" — pixelarticons has no Google mark, so this matches the 8-bit set */}
              <svg width="15" height="15" viewBox="0 0 5 7" fill="currentColor" shapeRendering="crispEdges" className="shrink-0">
                <rect x="1" y="0" width="3" height="1" />
                <rect x="0" y="1" width="1" height="1" />
                <rect x="4" y="1" width="1" height="1" />
                <rect x="0" y="2" width="1" height="1" />
                <rect x="0" y="3" width="1" height="1" />
                <rect x="2" y="3" width="3" height="1" />
                <rect x="0" y="4" width="1" height="1" />
                <rect x="4" y="4" width="1" height="1" />
                <rect x="0" y="5" width="1" height="1" />
                <rect x="4" y="5" width="1" height="1" />
                <rect x="1" y="6" width="3" height="1" />
              </svg>
              Google
            </button>
            <button
              type="button"
              onClick={go}
              className="flex items-center justify-center gap-[9px] border border-border px-3 py-3 text-[12.5px] transition-colors hover:border-muted-foreground hover:bg-card"
            >
              <Github className="size-[15px] shrink-0" />
              GitHub
            </button>
          </div>

          {/* divider */}
          <div className="my-[22px] flex items-center gap-[14px]">
            <div className="h-px flex-1 bg-border" />
            <span className="whitespace-nowrap text-[9.5px] uppercase tracking-[1.5px] text-muted-foreground">
              Or continue with email
            </span>
            <div className="h-px flex-1 bg-border" />
          </div>

          {/* email */}
          <label className="mb-[7px] block text-[10px] uppercase tracking-[1.5px] text-muted-foreground">
            Email address
          </label>
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
            autoComplete="email"
            className="mb-4 block w-full border border-border bg-card px-[14px] py-[13px] text-[13px] text-foreground outline-none focus:border-brand"
          />

          {/* password */}
          <label className="mb-[7px] block text-[10px] uppercase tracking-[1.5px] text-muted-foreground">Password</label>
          <div className="relative mb-4">
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type={showPw ? 'text' : 'password'}
              placeholder="••••••••"
              autoComplete="current-password"
              className="block w-full border border-border bg-card px-[14px] py-[13px] pr-[62px] text-[13px] text-foreground outline-none focus:border-brand"
            />
            <button
              type="button"
              onClick={() => setShowPw((v) => !v)}
              className="absolute right-0 top-0 flex h-full items-center px-[14px] text-[10.5px] tracking-[1px] text-muted-foreground transition-colors hover:text-foreground"
            >
              {showPw ? 'HIDE' : 'SHOW'}
            </button>
          </div>

          {/* signup confirm */}
          {!isLogin && (
            <>
              <label className="mb-[7px] block text-[10px] uppercase tracking-[1.5px] text-muted-foreground">
                Confirm password
              </label>
              <input
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                type={showPw ? 'text' : 'password'}
                placeholder="••••••••"
                autoComplete="new-password"
                className="mb-4 block w-full border border-border bg-card px-[14px] py-[13px] text-[13px] text-foreground outline-none focus:border-brand"
              />
            </>
          )}

          {/* extras */}
          {isLogin ? (
            <div className="mb-5 flex items-center justify-between">
              <button
                type="button"
                onClick={() => setRemember((v) => !v)}
                className="flex select-none items-center gap-[9px]"
              >
                <span
                  className="flex size-4 items-center justify-center border transition-colors"
                  style={{
                    borderColor: remember ? 'hsl(var(--brand))' : 'hsl(var(--border))',
                    background: remember ? 'hsl(var(--brand))' : 'transparent',
                  }}
                >
                  {remember && (
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="hsl(var(--background))" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                  )}
                </span>
                <span className="whitespace-nowrap text-[12px] text-muted-foreground">Remember me</span>
              </button>
              <button type="button" onClick={go} className="text-[12px] text-muted-foreground hover:text-foreground">
                Forgot password?
              </button>
            </div>
          ) : (
            <p className="mb-5 text-[11.5px] leading-relaxed text-muted-foreground">
              By creating an account you agree to our <span className="text-foreground underline">Terms</span> &amp;{' '}
              <span className="text-foreground underline">Privacy Policy</span>.
            </p>
          )}

          {/* primary */}
          <button
            type="button"
            onClick={go}
            className="flex w-full items-center justify-center gap-[9px] bg-primary px-3 py-[14px] text-[12.5px] font-semibold uppercase tracking-[1.5px] text-primary-foreground transition-opacity hover:opacity-90"
          >
            {isLogin ? 'Sign in' : 'Create account'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default LandingPage
