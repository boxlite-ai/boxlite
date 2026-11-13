/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { NavigationIcon, type NavigationIconName } from '@/components/NavigationIcon'
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
  Pin,
  SunIcon,
} from '@/components/ui/icon'
import { usePostHog } from 'posthog-js/react'
import { Fragment, useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useAuth } from 'react-oidc-context'
import { Link, useLocation, useNavigate } from 'react-router-dom'

interface SidebarProps {
  isBannerVisible: boolean
  version: string
  children?: ReactNode
}

interface NavItem {
  icon: NavigationIconName
  label: string
  path: RoutePath | string
  children?: { label: string; path: RoutePath; icon: NavigationIconName }[]
}

/** Navigation ownership follows declared children, even when their URLs are siblings. */
function matchesNavItem(pathname: string, item: NavItem): boolean {
  return [item.path, ...(item.children?.map((child) => child.path) ?? [])].some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  )
}

const PRIMARY_NAV_ITEMS: NavItem[] = [
  {
    label: 'Boxes',
    icon: 'box',
    path: RoutePath.BOXES,
    children: [
      {
        label: 'All Boxes',
        path: RoutePath.BOXES,
        icon: 'box',
      },
      {
        label: 'Checkpoints',
        path: RoutePath.CHECKPOINTS,
        icon: 'checkpoint',
      },
    ],
  },
  {
    label: 'Images',
    icon: 'images',
    path: RoutePath.IMAGES,
    children: [
      {
        label: 'Image library',
        path: RoutePath.IMAGES,
        icon: 'images',
      },
      {
        label: 'Private registries',
        path: RoutePath.IMAGE_REGISTRIES,
        icon: 'registry',
      },
    ],
  },
  {
    label: 'Volumes',
    icon: 'volume',
    path: RoutePath.VOLUMES,
  },
  { label: 'Domains', icon: 'domain', path: RoutePath.DOMAINS },
]

const APPLICATION_NAV_ITEMS: NavItem[] = [
  {
    label: 'CI',
    icon: 'ci',
    path: RoutePath.CI,
    children: [
      { label: 'Runners', path: RoutePath.CI, icon: 'box' },
      {
        label: 'Connects',
        path: RoutePath.CI_CONNECTS,
        icon: 'github',
      },
    ],
  },
]
const NAV_SECTIONS = [
  { label: 'Infrastructure', items: PRIMARY_NAV_ITEMS },
  { label: 'Applications', items: APPLICATION_NAV_ITEMS },
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
      <div className="px-1 pb-2 font-sans text-meta uppercase tracking-[0.18em] text-muted-foreground">Theme</div>
      <ToggleGroup
        type="single"
        value={theme}
        onValueChange={(value) => {
          if (value) setTheme(value as Theme)
        }}
        size="sm"
        className="grid w-full grid-cols-3 gap-0"
      >
        {themeOptions.map((option) => (
          <ToggleGroupItem
            key={option.value}
            value={option.value}
            aria-label={`Use ${option.label.toLowerCase()} theme`}
            // Collapse shared borders; focus must paint above a selected neighbor.
            className={cn(
              'relative -ml-px h-9 justify-center gap-1.5 rounded-none border border-border text-meta text-muted-foreground transition-colors first:ml-0',
              'hover:bg-control-hover hover:text-foreground',
              'data-[state=on]:z-10 data-[state=on]:bg-selection data-[state=on]:text-selection-foreground data-[state=on]:font-semibold data-[state=on]:hover:bg-selection data-[state=on]:hover:text-selection-foreground',
              'focus-visible:z-20 focus-visible:border-border focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-background data-[state=on]:focus-visible:z-20',
            )}
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
const CURRENT_NAV_ITEM_CLASS = 'bg-sidebar-accent font-medium text-sidebar-accent-foreground hover:bg-sidebar-accent'

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
  const [activeTooltip, setActiveTooltip] = useState<string | null>(null)
  useEffect(() => setActiveTooltip(null), [showLabels, pathname])
  /** Only compact navigation needs labels; stale close events cannot dismiss another item. */
  const navigationTooltipProps = (label: string) => ({
    open: !showLabels && activeTooltip === label,
    delayDuration: 300,
    disableHoverableContent: true,
    onOpenChange: (open: boolean) => {
      setActiveTooltip((current) => (open && !showLabels ? label : current === label ? null : current))
    },
  })
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
    const activeGroup = [...PRIMARY_NAV_ITEMS, ...APPLICATION_NAV_ITEMS].find(
      (item) => item.children && matchesNavItem(pathname, item),
    )
    if (activeGroup)
      setOpenGroups((groups) => (groups.includes(activeGroup.path) ? groups : [...groups, activeGroup.path]))
    if ([RoutePath.BILLING, RoutePath.SETTINGS].some((path) => pathname === path || pathname.startsWith(`${path}/`)))
      setManagementOpen(true)
  }, [pathname])
  const { selectedOrganization, onSelectOrganization } = useSelectedOrganization()
  const { organizations } = useOrganizations()

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
      'flex h-[38px] min-w-0 shrink items-center gap-3 rounded-none text-em leading-5 font-normal text-foreground transition-colors hover:bg-[hsl(var(--sidebar-hover))] hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
      showLabels ? 'w-full justify-start px-3' : 'w-10 justify-center',
      active && CURRENT_NAV_ITEM_CLASS,
    )
  const childItemClass = (active: boolean) =>
    cn(
      'flex min-h-8 items-center gap-3 rounded-none px-3 text-body font-normal text-muted-foreground transition-colors hover:bg-[hsl(var(--sidebar-hover))] hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring',
      active && CURRENT_NAV_ITEM_CLASS,
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

  const navigationControl = (
    <button
      ref={expanded ? navigationToggleRef : undefined}
      type="button"
      aria-label={expanded ? 'Collapse navigation' : 'Pin navigation'}
      aria-expanded={expanded ? true : undefined}
      aria-controls="primary-navigation"
      title={expanded ? 'Collapse navigation' : 'Pin navigation'}
      onClick={toggleNavigation}
      className="mr-2 flex size-9 shrink-0 items-center justify-center rounded-none text-muted-foreground hover:bg-control-hover hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
    >
      {expanded ? (
        <PanelLeft className="size-[18px]" aria-hidden="true" />
      ) : (
        <Pin className="size-[18px]" aria-hidden="true" />
      )}
    </button>
  )

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <aside
        aria-label="Feature navigation"
        style={{ '--navigation-width': expanded ? '224px' : '64px' } as CSSProperties}
        className="sticky top-[var(--app-banner-height,0px)] z-[45] hidden h-[calc(100svh_-_var(--app-banner-height,0px))] w-[var(--navigation-width)] shrink-0 font-sans text-body md:block"
      >
        <div
          ref={panelRef}
          data-state={expanded ? 'expanded' : peeking ? 'preview' : 'compact'}
          style={{ width: showLabels ? '224px' : '64px' }}
          className={cn(
            'absolute inset-y-0 left-0 flex flex-col items-center border-r border-sidebar-border bg-sidebar pb-3',
            peeking && !expanded && 'shadow-[8px_0_24px_-12px_rgba(0,0,0,0.3)] bg-popover',
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
                  className="flex h-full items-center px-3 text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <span className="flex w-[115px] shrink-0 overflow-hidden">
                    <LogoText className="h-[43.2px] w-auto max-w-none shrink-0" />
                  </span>
                </Link>
                {navigationControl}
              </>
            ) : (
              <>
                <button
                  ref={navigationToggleRef}
                  type="button"
                  aria-label={peeking ? 'Keep navigation expanded' : 'Expand navigation'}
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
                  className="flex h-full min-w-0 flex-1 items-center px-3 text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <span className={cn('flex shrink-0 overflow-hidden', peeking ? 'w-[115px]' : 'w-[38px]')}>
                    <LogoText className="h-[43.2px] w-auto max-w-none shrink-0" />
                  </span>
                </button>
                {peeking && navigationControl}
              </>
            )}
          </div>
          <nav
            id="primary-navigation"
            aria-label="Primary"
            className="hidden min-h-0 w-full flex-1 flex-col items-center gap-3 overflow-y-auto overflow-x-hidden px-2 py-4 md:flex"
          >
            {NAV_SECTIONS.map((section, index) => (
              <div
                key={section.label}
                role="group"
                aria-label={section.label}
                className={cn(
                  'flex w-full shrink-0 flex-col items-center gap-0.5',
                  index > 0 && 'border-t border-border pt-3',
                )}
              >
                {showLabels && (
                  <div className="w-full px-3 pb-2 text-label leading-4 uppercase tracking-[0.1em] text-muted-foreground">
                    {section.label}
                  </div>
                )}
                {section.items.map((item) => {
                  const groupOpen = openGroups.includes(item.path)
                  const expandedGroup = showLabels && Boolean(item.children)
                  const groupActive = matchesNavItem(pathname, item)
                  const selected = groupActive && !(expandedGroup && groupOpen)
                  const currentChild = item.children?.filter((child) => isActive(child.path)).at(-1)
                  return (
                    <div key={item.path} className={cn('shrink-0', showLabels && 'w-full')}>
                      <div
                        className={cn(
                          'group/nav-row flex items-center rounded-none',
                          expandedGroup && 'hover:bg-[hsl(var(--sidebar-hover))]',
                          expandedGroup && selected && CURRENT_NAV_ITEM_CLASS,
                        )}
                      >
                        <Tooltip {...navigationTooltipProps(item.label)}>
                          <TooltipTrigger asChild>
                            <Link
                              to={item.path}
                              onClick={() => {
                                if (!showLabels && item.children) setExpanded(true)
                              }}
                              aria-label={
                                !showLabels && currentChild
                                  ? `${item.label}, current section: ${currentChild.label}`
                                  : undefined
                              }
                              aria-current={
                                isActive(item.path) && !(showLabels && item.children && groupOpen) ? 'page' : undefined
                              }
                              className={cn(
                                railItemClass(selected && !expandedGroup),
                                expandedGroup && 'hover:bg-transparent group-hover/nav-row:text-foreground',
                                groupActive && 'text-foreground',
                                selected && 'font-medium',
                              )}
                            >
                              <NavigationIcon name={item.icon} selected={selected} />
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
                            className="mr-1 flex size-8 shrink-0 items-center justify-center rounded-none text-muted-foreground group-hover/nav-row:text-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                          >
                            <ChevronDown
                              className={cn('size-3.5 transition-transform', !groupOpen && '-rotate-90')}
                              aria-hidden="true"
                            />
                          </button>
                        )}
                      </div>
                      {showLabels && item.children && (
                        <div
                          id={`${item.label.toLowerCase()}-navigation`}
                          hidden={!groupOpen}
                          className="mt-0.5 space-y-0.5 pb-2"
                        >
                          {item.children.map((child) => (
                            <Link
                              key={child.path}
                              to={child.path}
                              aria-current={currentChild === child ? 'page' : undefined}
                              className={childItemClass(currentChild === child)}
                            >
                              <span className="inline-flex size-[18px] shrink-0 items-center justify-center">
                                <NavigationIcon
                                  name={child.icon}
                                  selected={currentChild === child}
                                  className="size-4"
                                />
                              </span>
                              <span className="truncate">{child.label}</span>
                            </Link>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            ))}
            <div className="h-px w-full shrink-0 bg-border" />
            <div className={cn('shrink-0', showLabels && 'w-full')}>
              <Tooltip {...navigationTooltipProps('Management')}>
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
                    <NavigationIcon name="management" selected={managementActive && !(showLabels && managementOpen)} />
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
              <div
                id="management-navigation"
                hidden={!showLabels || !managementOpen}
                className="mt-0.5 space-y-0.5 pb-2"
              >
                {[
                  {
                    label: 'Billing',
                    path: RoutePath.BILLING,
                    icon: 'billing' as const,
                  },
                  ...(selectedOrganization
                    ? [
                        {
                          label: 'Organization',
                          path: RoutePath.SETTINGS,
                          icon: 'organization' as const,
                        },
                      ]
                    : []),
                ].map((item) => (
                  <Link
                    key={item.path}
                    to={item.path}
                    aria-current={isActive(item.path) ? 'page' : undefined}
                    className={childItemClass(isActive(item.path))}
                  >
                    <span className="inline-flex size-[18px] shrink-0 items-center justify-center">
                      <NavigationIcon name={item.icon} selected={isActive(item.path)} className="size-4" />
                    </span>
                    <span className="truncate">{item.label}</span>
                  </Link>
                ))}
              </div>
            </div>
          </nav>
          <div className="flex w-full shrink-0 flex-col items-center gap-2 px-2 pt-2">
            <Tooltip {...navigationTooltipProps('Quickstart')}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={openOnboardingGuide}
                  aria-label="Open onboarding guide"
                  aria-current={isActive(RoutePath.QUICKSTART) ? 'page' : undefined}
                  className={railItemClass(isActive(RoutePath.QUICKSTART))}
                >
                  <NavigationIcon name="quickstart" selected={isActive(RoutePath.QUICKSTART)} />
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
            'sticky z-40 flex h-[var(--app-header-height,60px)] w-full shrink-0 items-center border-b border-border bg-background font-sans text-body',
            isBannerVisible ? 'top-16 md:top-12' : 'top-0',
          )}
        >
          <Link
            to={RoutePath.BOXES}
            className="flex h-full shrink-0 items-center md:hidden px-2 xs:px-[14px] text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
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
              'mr-2 md:mr-8 inline-flex h-9 shrink-0 items-center gap-2 px-3 text-muted-foreground hover:bg-control-hover hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring',
              isActive(RoutePath.KEYS) && 'bg-selection text-selection-foreground hover:bg-selection',
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
              className="mr-0 xs:mr-3 inline-flex h-9 max-w-[240px] shrink-0 items-center justify-center gap-2 px-2 text-body font-medium text-foreground transition-colors hover:bg-control-hover data-[state=open]:bg-selection data-[state=open]:hover:bg-selection focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
            >
              <span className="flex size-[23px] shrink-0 items-center justify-center overflow-hidden bg-brand text-meta font-bold text-brand-foreground">
                {user?.profile.picture ? (
                  <img src={user.profile.picture} alt={userName} className="h-full w-full object-cover" />
                ) : (
                  initials
                )}
              </span>
              <span className="hidden min-w-0 truncate md:inline">{userName}</span>
              <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              side="bottom"
              align="end"
              sideOffset={8}
              collisionPadding={8}
              className="max-h-[var(--radix-dropdown-menu-content-available-height)] min-w-[min(18rem,calc(100vw_-_1rem))] max-w-[calc(100vw_-_1rem)] overflow-y-auto"
            >
              <DropdownMenuLabel className="flex flex-col gap-0.5">
                <span className="truncate text-body font-semibold text-foreground">{userName}</span>
                {user?.profile.email && user.profile.email !== userName && (
                  <span className="truncate font-mono text-meta font-normal text-muted-foreground">
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
                  <DropdownMenuLabel className="font-sans text-meta font-normal uppercase tracking-[0.18em] text-muted-foreground">
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
                          <span className="ml-auto text-meta text-muted-foreground">Personal</span>
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
            <DropdownMenuContent
              align="end"
              collisionPadding={8}
              className="max-h-[var(--radix-dropdown-menu-content-available-height)] min-w-[14rem] overflow-y-auto"
            >
              {NAV_SECTIONS.map((section) => (
                <div key={section.label}>
                  <DropdownMenuLabel>{section.label}</DropdownMenuLabel>
                  {section.items.map((item) => (
                    <Fragment key={item.path}>
                      {item.children && <DropdownMenuLabel>{item.label}</DropdownMenuLabel>}
                      {(item.children ?? [item]).map((child) => (
                        <DropdownMenuItem key={child.path} asChild className="cursor-pointer">
                          <Link to={child.path}>{child.label}</Link>
                        </DropdownMenuItem>
                      ))}
                    </Fragment>
                  ))}
                </div>
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
