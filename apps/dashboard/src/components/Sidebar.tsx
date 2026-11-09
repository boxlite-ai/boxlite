/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { LogoText } from '@/assets/Logo'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { BOXLITE_DOCS_URL, BOXLITE_SLACK_URL } from '@/constants/ExternalLinks'
import { Theme, useTheme } from '@/contexts/ThemeContext'
import { RoutePath } from '@/enums/RoutePath'
import { useOrganizations } from '@/hooks/useOrganizations'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { markJustLoggedOut } from '@/lib/auth-session'
import { ONBOARDING_OPEN_EVENT } from '@/lib/onboarding-progress'
import { cn } from '@/lib/utils'
import {
  BookOpen,
  Building2,
  Container,
  Database,
  Layers,
  HardDrive,
  Globe,
  CreditCardIcon,
  Check,
  ChevronDown,
  KeyRound,
  LogOut,
  MessageCircle,
  Monitor,
  MoonIcon,
  MoreHorizontal,
  PanelLeft,
  Settings,
  Server,
  SunIcon,
} from '@/components/ui/icon'
import { usePostHog } from 'posthog-js/react'
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useAuth } from 'react-oidc-context'
import { Link, useLocation, useNavigate } from 'react-router-dom'

interface SidebarProps {
  isBannerVisible: boolean
  version: string
  children?: ReactNode
}

interface NavItem {
  icon?: React.ReactElement
  label: string
  path: RoutePath | string
  children?: { label: string; path: RoutePath; icon: React.ReactElement }[]
}

const PRIMARY_NAV_ITEMS: NavItem[] = [
  { label: 'Boxes', icon: <Container className="size-[18px] shrink-0" aria-hidden="true" />, path: RoutePath.BOXES },
  {
    label: 'Images',
    icon: <Layers className="size-[18px] shrink-0" aria-hidden="true" />,
    path: RoutePath.IMAGES,
    children: [
      {
        label: 'Image library',
        path: RoutePath.IMAGES,
        icon: <Layers className="size-3.5 shrink-0" aria-hidden="true" />,
      },
      {
        label: 'Private registries',
        path: RoutePath.IMAGE_REGISTRIES,
        icon: <Server className="size-3.5 shrink-0" aria-hidden="true" />,
      },
    ],
  },
  {
    label: 'Volumes',
    icon: <HardDrive className="size-[18px] shrink-0" aria-hidden="true" />,
    path: RoutePath.VOLUMES,
  },
  {
    label: 'Checkpoints',
    icon: <Database className="size-[18px] shrink-0" aria-hidden="true" />,
    path: RoutePath.CHECKPOINTS,
  },
  { label: 'Domains', icon: <Globe className="size-[18px] shrink-0" aria-hidden="true" />, path: RoutePath.DOMAINS },
]

const themeOptions: { value: Theme; label: string; icon: React.ReactElement }[] = [
  { value: 'system', label: 'System', icon: <Monitor className="size-3.5" /> },
  { value: 'light', label: 'Light', icon: <SunIcon className="size-3.5" /> },
  { value: 'dark', label: 'Dark', icon: <MoonIcon className="size-3.5" /> },
]

/** Offers explicit light/dark choices while preserving the system-theme option in the account menu. */
function ThemeMenuItems({ theme, setTheme }: { theme: Theme; setTheme: (theme: Theme) => void }) {
  return (
    <div className="px-2 py-2">
      <div className="px-1 pb-2 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Theme</div>
      <ToggleGroup
        type="single"
        value={theme}
        onValueChange={(value) => {
          if (value) setTheme(value as Theme)
        }}
        variant="outline"
        size="sm"
        className="grid w-full grid-cols-3 gap-0 border border-border"
      >
        {themeOptions.map((option) => (
          <ToggleGroupItem
            key={option.value}
            value={option.value}
            aria-label={`Use ${option.label.toLowerCase()} theme`}
            className="h-9 justify-center gap-1.5 rounded-none border-0 border-r border-border text-xs text-muted-foreground transition-colors last:border-r-0 hover:text-foreground data-[state=on]:bg-card data-[state=on]:font-semibold data-[state=on]:text-foreground data-[state=on]:shadow-[inset_0_0_0_1px_hsl(var(--border-selected))]"
          >
            {option.icon}
            <span>{option.label}</span>
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  )
}

const NAVIGATION_EXPANDED_KEY = 'boxlite-navigation-expanded'

/** Storage may be unavailable; the navigation still defaults to a usable compact rail. */
function readExpandedPreference(): boolean {
  try {
    return localStorage.getItem(NAVIGATION_EXPANDED_KEY) === 'true'
  } catch {
    return false
  }
}

/** Full-height desktop navigation beside the application header and route content. */
export function Sidebar({ isBannerVisible, children }: SidebarProps) {
  const posthog = usePostHog()
  const { theme, setTheme } = useTheme()
  const { user, signoutRedirect } = useAuth()
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const [expanded, setExpanded] = useState(readExpandedPreference)
  const [peeking, setPeeking] = useState(false)
  const showLabels = expanded || peeking
  const panelRef = useRef<HTMLDivElement>(null)
  const pointerInside = useRef(false)
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const navigationToggleRef = useRef<HTMLButtonElement>(null)
  const restoreToggleFocus = useRef(false)
  /** Explicit toggles persist; a hover preview never changes the saved layout. */
  const toggleNavigation = () => {
    clearTimeout(openTimer.current)
    clearTimeout(closeTimer.current)
    setPeeking(false)
    restoreToggleFocus.current = true
    setExpanded((value) => !value)
  }
  /** Dismiss temporary navigation without changing the persistent layout choice. */
  const dismissPreview = () => {
    clearTimeout(openTimer.current)
    clearTimeout(closeTimer.current)
    setPeeking(false)
    navigationToggleRef.current?.focus()
  }
  /** Keep keyboard-operated children mounted until focus leaves the preview. */
  const schedulePreviewClose = () => {
    clearTimeout(openTimer.current)
    clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => {
      const focusedChild =
        panelRef.current?.contains(document.activeElement) &&
        document.activeElement !== navigationToggleRef.current &&
        document.activeElement?.matches(':focus-visible')
      if (!focusedChild) setPeeking(false)
    }, 150)
  }
  useEffect(
    () => () => {
      clearTimeout(openTimer.current)
      clearTimeout(closeTimer.current)
    },
    [],
  )
  const [managementOpen, setManagementOpen] = useState(false)
  const [openGroups, setOpenGroups] = useState<string[]>([])
  useEffect(() => {
    try {
      localStorage.setItem(NAVIGATION_EXPANDED_KEY, String(expanded))
    } catch {
      /* Optional preference. */
    }
    if (restoreToggleFocus.current) {
      navigationToggleRef.current?.focus()
      restoreToggleFocus.current = false
    }
  }, [expanded])
  useEffect(() => {
    const activeGroup = PRIMARY_NAV_ITEMS.find(
      (item) => item.children && (pathname === item.path || pathname.startsWith(`${item.path}/`)),
    )
    if (activeGroup)
      setOpenGroups((groups) => (groups.includes(activeGroup.path) ? groups : [...groups, activeGroup.path]))
    if ([RoutePath.BILLING, RoutePath.SETTINGS].some((path) => pathname === path || pathname.startsWith(`${path}/`)))
      setManagementOpen(true)
  }, [pathname])
  const { selectedOrganization, onSelectOrganization } = useSelectedOrganization()
  const { organizations } = useOrganizations()

  const primaryItems: NavItem[] = PRIMARY_NAV_ITEMS

  const openOnboardingGuide = useCallback(() => {
    const event = new Event(ONBOARDING_OPEN_EVENT, { cancelable: true })
    window.dispatchEvent(event)

    if (!event.defaultPrevented) {
      navigate(`${RoutePath.BOXES}?onboarding=1`)
    }
  }, [navigate])

  const handleSignOut = () => {
    posthog?.reset()
    markJustLoggedOut()
    signoutRedirect()
  }

  const userName = user?.profile.name || user?.profile.email || 'Profile'
  const initials =
    userName
      .split(/\s+/)
      .map((w) => w[0])
      .slice(0, 2)
      .join('')
      .toUpperCase() || 'U'

  const isActive = (path: string) => pathname === path || pathname.startsWith(`${path}/`)
  const railItemClass = (active: boolean) =>
    cn(
      'flex h-10 min-w-0 shrink items-center gap-3 text-muted-foreground transition-colors hover:bg-card hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground',
      showLabels ? 'w-full justify-start px-3' : 'w-10 justify-center',
      active && 'bg-accent text-foreground hover:bg-accent',
    )

  const managementActive = isActive(RoutePath.BILLING) || isActive(RoutePath.SETTINGS)
  const managementEntries = (
    <>
      <DropdownMenuItem asChild>
        <Link to={RoutePath.BILLING} aria-current={isActive(RoutePath.BILLING) ? 'page' : undefined}>
          <CreditCardIcon className="size-4" />
          Billing
        </Link>
      </DropdownMenuItem>
      {selectedOrganization && (
        <DropdownMenuItem asChild>
          <Link to={RoutePath.SETTINGS} aria-current={isActive(RoutePath.SETTINGS) ? 'page' : undefined}>
            <Building2 className="size-4" />
            Organization
          </Link>
        </DropdownMenuItem>
      )}
    </>
  )

  const collapseControl = (
    <button
      ref={expanded ? navigationToggleRef : undefined}
      type="button"
      aria-label="Collapse navigation"
      aria-expanded={true}
      aria-controls="primary-navigation"
      title="Collapse navigation"
      onClick={expanded ? toggleNavigation : dismissPreview}
      className="mr-2 flex size-9 shrink-0 items-center justify-center text-muted-foreground hover:bg-card hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-foreground"
    >
      <PanelLeft className="size-[18px]" aria-hidden="true" />
    </button>
  )

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <aside
        aria-label="Feature navigation"
        style={{ '--navigation-width': expanded ? '224px' : '64px' } as CSSProperties}
        className="sticky top-[var(--app-banner-height,0px)] z-[45] hidden h-[calc(100svh_-_var(--app-banner-height,0px))] w-[var(--navigation-width)] shrink-0 font-mono text-[13px] md:block"
      >
        <div
          ref={panelRef}
          data-state={expanded ? 'expanded' : peeking ? 'preview' : 'compact'}
          style={{ width: showLabels ? '224px' : '64px' }}
          className={cn(
            'absolute inset-y-0 left-0 flex flex-col items-center border-r border-border bg-background pb-3',
            peeking && !expanded && 'shadow-[8px_0_24px_-12px_rgba(0,0,0,0.3)]',
          )}
          onPointerEnter={() => {
            pointerInside.current = true
            clearTimeout(closeTimer.current)
          }}
          onPointerLeave={() => {
            pointerInside.current = false
            schedulePreviewClose()
          }}
          onBlur={(event) => {
            if (!pointerInside.current && !event.currentTarget.contains(event.relatedTarget)) schedulePreviewClose()
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && peeking) {
              event.preventDefault()
              dismissPreview()
            }
          }}
        >
          <div className="flex h-[var(--app-header-height,48px)] w-full shrink-0 items-center justify-between border-b border-border">
            {expanded ? (
              <>
                <Link
                  to={RoutePath.BOXES}
                  aria-label="BoxLite home"
                  className="flex h-full items-center px-3 text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-foreground"
                >
                  <span className="flex w-[115px] shrink-0 overflow-hidden">
                    <LogoText className="h-[43.2px] w-auto max-w-none shrink-0" />
                  </span>
                </Link>
                {collapseControl}
              </>
            ) : (
              <>
                <button
                  ref={navigationToggleRef}
                  type="button"
                  aria-label={peeking ? 'Pin navigation' : 'Expand navigation'}
                  aria-expanded={peeking}
                  aria-controls="primary-navigation"
                  title={peeking ? 'Keep navigation expanded' : 'Expand navigation'}
                  onPointerEnter={(event) => {
                    if (event.pointerType !== 'mouse') return
                    clearTimeout(openTimer.current)
                    openTimer.current = setTimeout(() => setPeeking(true), 350)
                  }}
                  onPointerLeave={() => clearTimeout(openTimer.current)}
                  onClick={toggleNavigation}
                  className="flex h-full min-w-0 flex-1 items-center px-3 text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-foreground"
                >
                  <span className={cn('flex shrink-0 overflow-hidden', peeking ? 'w-[115px]' : 'w-[38px]')}>
                    <LogoText className="h-[43.2px] w-auto max-w-none shrink-0" />
                  </span>
                </button>
                {peeking && collapseControl}
              </>
            )}
          </div>
          <nav
            id="primary-navigation"
            aria-label="Primary"
            className="hidden min-h-0 w-full flex-1 flex-col items-center gap-2 overflow-y-auto overflow-x-hidden px-2 py-4 md:flex"
          >
            <div role="group" aria-label="Infrastructure" className="flex w-full shrink-0 flex-col items-center gap-2">
              {showLabels && (
                <div className="w-full px-3 pb-1 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                  Infrastructure
                </div>
              )}
              {primaryItems.map((item) => {
                const groupOpen = openGroups.includes(item.path)
                const expandedGroup = showLabels && Boolean(item.children)
                const selected = isActive(item.path) && !(expandedGroup && groupOpen)
                const currentChild = item.children?.filter((child) => isActive(child.path)).at(-1)
                return (
                  <div key={item.path} className={cn('shrink-0', showLabels && 'w-full')}>
                    <div
                      className={cn(
                        'flex items-center',
                        expandedGroup && 'hover:bg-card',
                        expandedGroup && selected && 'bg-accent hover:bg-accent',
                      )}
                    >
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Link
                            to={item.path}
                            onClick={() => {
                              if (!showLabels && item.children) setExpanded(true)
                            }}
                            aria-current={
                              isActive(item.path) && !(showLabels && item.children && groupOpen) ? 'page' : undefined
                            }
                            className={cn(
                              railItemClass(selected && !expandedGroup),
                              expandedGroup && 'hover:bg-transparent',
                              isActive(item.path) && 'text-foreground',
                            )}
                          >
                            {item.icon}
                            <span className={showLabels ? 'truncate' : 'sr-only'}>{item.label}</span>
                          </Link>
                        </TooltipTrigger>
                        {!showLabels && (
                          <TooltipContent side="right" sideOffset={12}>
                            {item.label}
                          </TooltipContent>
                        )}
                      </Tooltip>
                      {showLabels && item.children && (
                        <button
                          type="button"
                          aria-label={`Toggle ${item.label} navigation`}
                          aria-expanded={groupOpen}
                          aria-controls={`${item.label.toLowerCase()}-navigation`}
                          onClick={() =>
                            setOpenGroups((groups) =>
                              groupOpen ? groups.filter((path) => path !== item.path) : [...groups, item.path],
                            )
                          }
                          className="flex size-8 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-foreground"
                        >
                          <ChevronDown
                            className={cn('size-3.5 transition-transform', !groupOpen && '-rotate-90')}
                            aria-hidden="true"
                          />
                        </button>
                      )}
                    </div>
                    {showLabels && item.children && (
                      <div id={`${item.label.toLowerCase()}-navigation`} hidden={!groupOpen} className="mt-1">
                        {item.children.map((child) => (
                          <Link
                            key={child.path}
                            to={child.path}
                            aria-current={currentChild === child ? 'page' : undefined}
                            className={cn(
                              'flex min-h-9 items-center gap-2 pl-7 pr-2 text-xs text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-foreground',
                              currentChild === child && 'bg-accent text-foreground hover:bg-accent',
                            )}
                          >
                            {child.icon}
                            <span className="truncate">{child.label}</span>
                          </Link>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
            <div className="my-1 h-px w-full shrink-0 bg-border" />
            <div className={cn('shrink-0', showLabels && 'w-full')}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label="Toggle Management navigation"
                    aria-expanded={showLabels && managementOpen}
                    aria-controls="management-navigation"
                    onClick={() => {
                      if (!showLabels) setExpanded(true)
                      setManagementOpen(showLabels ? !managementOpen : true)
                    }}
                    className={cn(
                      railItemClass(managementActive && !(showLabels && managementOpen)),
                      managementActive && 'text-foreground',
                    )}
                  >
                    <Settings className="size-[18px] shrink-0" aria-hidden="true" />
                    {showLabels && (
                      <>
                        <span>Management</span>
                        <ChevronDown
                          className={cn('ml-auto size-3.5 shrink-0', !managementOpen && '-rotate-90')}
                          aria-hidden="true"
                        />
                      </>
                    )}
                  </button>
                </TooltipTrigger>
                {!showLabels && <TooltipContent side="right">Management</TooltipContent>}
              </Tooltip>
              <div id="management-navigation" hidden={!showLabels || !managementOpen} className="mt-1">
                {[
                  {
                    label: 'Billing',
                    path: RoutePath.BILLING,
                    icon: <CreditCardIcon className="size-3.5 shrink-0" aria-hidden="true" />,
                  },
                  ...(selectedOrganization
                    ? [
                        {
                          label: 'Organization',
                          path: RoutePath.SETTINGS,
                          icon: <Building2 className="size-3.5 shrink-0" aria-hidden="true" />,
                        },
                      ]
                    : []),
                ].map((item) => (
                  <Link
                    key={item.path}
                    to={item.path}
                    aria-current={isActive(item.path) ? 'page' : undefined}
                    className={cn(
                      'flex min-h-9 items-center gap-2 pl-7 pr-2 text-xs text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-foreground',
                      isActive(item.path) && 'bg-accent text-foreground hover:bg-accent',
                    )}
                  >
                    {item.icon}
                    <span className="truncate">{item.label}</span>
                  </Link>
                ))}
              </div>
            </div>
          </nav>
          <div className="flex w-full shrink-0 flex-col items-center gap-2 px-2 pt-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={openOnboardingGuide}
                  aria-label="Open onboarding guide"
                  aria-current={isActive(RoutePath.QUICKSTART) ? 'page' : undefined}
                  className={railItemClass(isActive(RoutePath.QUICKSTART))}
                >
                  <BookOpen className="size-[18px] shrink-0" aria-hidden="true" />
                  {showLabels && <span>Quickstart</span>}
                </button>
              </TooltipTrigger>
              {!showLabels && (
                <TooltipContent side="right" sideOffset={12}>
                  Quickstart
                </TooltipContent>
              )}
            </Tooltip>
          </div>
        </div>
      </aside>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header
          aria-label="Application navigation"
          className={cn(
            'sticky z-40 flex h-[var(--app-header-height,60px)] w-full shrink-0 items-center border-b border-border bg-background font-mono text-[13px]',
            isBannerVisible ? 'top-16 md:top-12' : 'top-0',
          )}
        >
          <Link
            to={RoutePath.BOXES}
            className="flex h-full shrink-0 items-center md:hidden px-[14px] text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-foreground"
            aria-label="BoxLite home"
          >
            <LogoText className="h-9 w-auto" />
          </Link>

          <div className="min-w-0 flex-1" />

          <Link
            to={RoutePath.KEYS}
            aria-label="API Keys"
            aria-current={isActive(RoutePath.KEYS) ? 'page' : undefined}
            title="API Keys"
            className={cn(
              'mr-2 md:mr-8 inline-flex h-9 shrink-0 items-center gap-2 px-3 text-muted-foreground hover:bg-card hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-foreground',
              isActive(RoutePath.KEYS) && 'bg-accent text-foreground hover:bg-accent',
            )}
          >
            <KeyRound className="size-[18px]" aria-hidden="true" />
            <span className="hidden sm:inline">API Keys</span>
          </Link>

          {/* profile menu (organization switcher tucked inside) */}
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label="Open profile menu"
              title="Profile"
              className="mr-3 inline-flex h-9 max-w-[240px] shrink-0 items-center justify-center gap-2 px-2 text-[13px] font-medium text-foreground transition-colors hover:bg-card data-[state=open]:bg-card focus-visible:outline focus-visible:outline-2 focus-visible:outline-foreground"
            >
              <span className="flex size-[23px] shrink-0 items-center justify-center overflow-hidden bg-brand text-[9px] font-extrabold text-white">
                {user?.profile.picture ? (
                  <img src={user.profile.picture} alt={userName} className="h-full w-full object-cover" />
                ) : (
                  initials
                )}
              </span>
              <span className="hidden min-w-0 truncate md:inline">{userName}</span>
              <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
            </DropdownMenuTrigger>
            <DropdownMenuContent side="bottom" align="end" sideOffset={8} className="min-w-[18rem]">
              <DropdownMenuLabel className="flex flex-col gap-0.5">
                <span className="truncate text-[13px] font-semibold text-foreground">{userName}</span>
                {user?.profile.email && user.profile.email !== userName && (
                  <span className="truncate font-mono text-[11px] font-normal text-muted-foreground">
                    {user.profile.email}
                  </span>
                )}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <ThemeMenuItems theme={theme} setTheme={setTheme} />
              <DropdownMenuSeparator />
              {/* The selection persists in localStorage, so the chosen organization opens on the next login. */}
              {organizations.length > 1 && (
                <>
                  <DropdownMenuLabel className="font-mono text-[11px] font-normal uppercase tracking-[0.18em] text-muted-foreground">
                    Organizations
                  </DropdownMenuLabel>
                  {organizations.map((organization) => {
                    const isSelected = organization.id === selectedOrganization?.id
                    return (
                      <DropdownMenuItem
                        key={organization.id}
                        className="cursor-pointer"
                        onClick={() => {
                          if (!isSelected) void onSelectOrganization(organization.id)
                        }}
                      >
                        <Check className={cn('size-4', isSelected ? 'opacity-100' : 'opacity-0')} />
                        <span className="truncate">{organization.name}</span>
                        {organization.isDefaultForAuthenticatedUser && (
                          <span className="ml-auto text-[11px] text-muted-foreground">Personal</span>
                        )}
                      </DropdownMenuItem>
                    )
                  })}
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuItem asChild className="cursor-pointer">
                <a href={BOXLITE_DOCS_URL} target="_blank" rel="noopener noreferrer">
                  <BookOpen className="size-4" />
                  Docs
                </a>
              </DropdownMenuItem>
              <DropdownMenuItem asChild className="cursor-pointer">
                <a href={BOXLITE_SLACK_URL} target="_blank" rel="noopener noreferrer">
                  <MessageCircle className="size-4" />
                  Discord
                </a>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="cursor-pointer" onClick={handleSignOut}>
                <LogOut className="size-4" />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* mobile: search + nav */}
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label="Open navigation menu"
              className="inline-flex h-full items-center border-l border-border px-5 text-muted-foreground outline-none transition-colors hover:text-foreground md:hidden"
            >
              <MoreHorizontal className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[14rem]">
              {primaryItems.map((item) => (
                <DropdownMenuItem key={item.label} asChild className="cursor-pointer">
                  <Link to={item.path}>{item.label}</Link>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Management</DropdownMenuLabel>
              {managementEntries}
              <DropdownMenuSeparator />
              <DropdownMenuItem className="cursor-pointer" onClick={openOnboardingGuide}>
                <BookOpen className="size-4" />
                Quickstart
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>
        {children}
      </div>
    </div>
  )
}
