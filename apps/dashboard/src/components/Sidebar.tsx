/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { LogoText } from '@/assets/Logo'
import { BoxSearchCommands } from '@/components/BoxSearchCommands'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { BOXLITE_DOCS_URL, BOXLITE_SLACK_URL } from '@/constants/ExternalLinks'
import { Theme, useTheme } from '@/contexts/ThemeContext'
import { RoutePath } from '@/enums/RoutePath'
import { useApi } from '@/hooks/useApi'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { useCopyToClipboard } from 'usehooks-ts'
import { toast } from 'sonner'
import { markJustLoggedOut } from '@/lib/auth-session'
import { ONBOARDING_OPEN_EVENT } from '@/lib/onboarding-progress'
import { cn, getMetaKey } from '@/lib/utils'
import {
  ArrowRightIcon,
  BookOpen,
  Building2,
  ChevronDown,
  Copy,
  KeyRound,
  ListChecks,
  LogOut,
  MessageCircle,
  Monitor,
  MoonIcon,
  MoreHorizontal,
  SearchIcon,
  ShieldCheck,
  SunIcon,
} from '@/components/ui/icon'
import { usePostHog } from 'posthog-js/react'
import { useQuery } from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'
import { useAuth } from 'react-oidc-context'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { CommandConfig, useCommandPaletteActions, useRegisterCommands } from './CommandPalette'

const ADMIN_UI_HEADERS = { 'X-BoxLite-Source': 'ui' } as const

interface SidebarProps {
  isBannerVisible: boolean
  billingEnabled: boolean
  version: string
}

interface NavItem {
  icon?: React.ReactElement
  label: string
  path: RoutePath | string
  onClick?: () => void
}

const themeOptions: { value: Theme; label: string; icon: React.ReactElement }[] = [
  { value: 'system', label: 'System', icon: <Monitor className="size-3.5" /> },
  { value: 'light', label: 'Light', icon: <SunIcon className="size-3.5" /> },
  { value: 'dark', label: 'Dark', icon: <MoonIcon className="size-3.5" /> },
]

function ThemeMenuItems({ theme, setTheme }: { theme: Theme; setTheme: (theme: Theme) => void }) {
  return (
    <div className="px-2 py-2">
      <div className="px-1 pb-2 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
        Theme
      </div>
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
            className="h-9 justify-center gap-1.5 rounded-none border-0 border-r border-border text-xs text-muted-foreground transition-colors last:border-r-0 hover:text-foreground data-[state=on]:bg-card data-[state=on]:font-semibold data-[state=on]:text-foreground"
          >
            {option.icon}
            <span>{option.label}</span>
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  )
}

const useNavCommands = (items: NavItem[]) => {
  const { pathname } = useLocation()
  const navigate = useNavigate()

  const navCommands: CommandConfig[] = useMemo(
    () =>
      items
        .filter((item) => item.path !== pathname)
        .map((item) => ({
          id: `nav-${item.path}`,
          label: `Go to ${item.label}`,
          icon: <ArrowRightIcon className="w-4 h-4" />,
          onSelect: () => (item.onClick ? item.onClick() : navigate(item.path)),
        })),
    [pathname, navigate, items],
  )

  useRegisterCommands(navCommands, { groupId: 'navigation', groupLabel: 'Navigation', groupOrder: 1 })
}

/**
 * Top navigation bar (ASCII/terminal restyle). Named `Sidebar` for import compatibility;
 * it has always rendered as a top header. All data/command wiring is preserved — only the
 * presentation matches the new design (Nav.dc): a single 60px monospace bar with bordered
 * segments, a standalone organization switcher, and a profile menu.
 */
export function Sidebar({ isBannerVisible }: SidebarProps) {
  const posthog = usePostHog()
  const { axiosInstance } = useApi()
  const { theme, setTheme } = useTheme()
  const { user, signoutRedirect } = useAuth()
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const { selectedOrganization } = useSelectedOrganization()
  const [, copyToClipboard] = useCopyToClipboard()

  const copyOrgId = useCallback(() => {
    if (!selectedOrganization) return
    copyToClipboard(selectedOrganization.id)
    toast.success('Organization ID copied to clipboard')
  }, [copyToClipboard, selectedOrganization])

  const orgCommands = useMemo<CommandConfig[]>(
    () =>
      selectedOrganization
        ? [
            {
              id: 'copy-org-id',
              label: 'Copy Organization ID',
              icon: <Copy className="w-4 h-4" />,
              onSelect: copyOrgId,
            },
          ]
        : [],
    [selectedOrganization, copyOrgId],
  )
  useRegisterCommands(orgCommands, { groupId: 'organization', groupLabel: 'Organization', groupOrder: 5 })

  const adminAccessQuery = useQuery({
    queryKey: ['admin', 'sidebar-access'],
    queryFn: async () => {
      await axiosInstance.get('/admin/overview', { headers: ADMIN_UI_HEADERS })
      return true
    },
    enabled: !!user,
    retry: false,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  })
  const canViewAdmin = adminAccessQuery.data === true

  const primaryItems = useMemo<NavItem[]>(
    () => [
      { label: 'Boxes', path: RoutePath.BOXES },
      { label: 'Billing', path: RoutePath.BILLING },
      ...(canViewAdmin ? [{ label: 'Admin', path: RoutePath.ADMIN }] : []),
    ],
    [canViewAdmin],
  )

  const openOnboardingGuide = useCallback(() => {
    const event = new Event(ONBOARDING_OPEN_EVENT, { cancelable: true })
    window.dispatchEvent(event)

    if (!event.defaultPrevented) {
      navigate(`${RoutePath.BOXES}?onboarding=1`)
    }
  }, [navigate])

  const commandItems = useMemo<NavItem[]>(
    () => [
      ...primaryItems,
      { path: RoutePath.KEYS, label: 'API Keys', icon: <KeyRound size={16} strokeWidth={1.5} /> },
      {
        path: RoutePath.ONBOARDING,
        label: 'Onboarding',
        icon: <ListChecks size={16} strokeWidth={1.5} />,
        onClick: openOnboardingGuide,
      },
    ],
    [openOnboardingGuide, primaryItems],
  )

  const handleSignOut = () => {
    posthog?.reset()
    markJustLoggedOut()
    signoutRedirect()
  }

  const commandPaletteActions = useCommandPaletteActions()
  useNavCommands(commandItems)

  const metaKey = getMetaKey()

  const openCommandPalette = (source: string) => {
    posthog?.capture('command_palette_opened', { source })
    commandPaletteActions.setIsOpen(true)
  }

  const userName = user?.profile.name || user?.profile.email || 'Profile'
  const initials =
    userName
      .split(/\s+/)
      .map((w) => w[0])
      .slice(0, 2)
      .join('')
      .toUpperCase() || 'U'

  // One full-height nav cell. Selection is conveyed purely by value/grayscale — no hue:
  // active = neutral grey fill + brightest (foreground) label; inactive = dimmer muted text.
  const navCellClass = (active: boolean, extra?: string) =>
    cn(
      'relative h-full items-center gap-2 px-[18px] text-[13px] font-medium transition-colors',
      active ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-card hover:text-foreground',
      extra,
    )

  return (
    <header
      className={cn(
        'sticky z-40 flex h-[60px] items-stretch border-b border-border bg-background font-mono text-[13px]',
        isBannerVisible ? 'top-16 md:top-12' : 'top-0',
      )}
    >
      <BoxSearchCommands />

      {/* brand */}
      <Link
        to={RoutePath.BOXES}
        className="flex shrink-0 items-center border-r border-border px-[22px] text-foreground"
        aria-label="BoxLite home"
      >
        <LogoText className="h-[26px] w-auto" />
      </Link>

      {/* primary nav */}
      {primaryItems.map((item) => {
        const active = pathname.startsWith(item.path)
        return (
          <Link key={item.label} to={item.path} className={navCellClass(active, 'hidden md:inline-flex')}>
            {item.label}
          </Link>
        )
      })}

      <div className="flex-1" />

      {/* search → command palette */}
      <button
        type="button"
        onClick={() => openCommandPalette('dashboard_header')}
        aria-label="Search"
        className="hidden min-w-[180px] items-center gap-2.5 border-l border-border px-4 text-muted-foreground transition-colors hover:text-foreground lg:flex"
      >
        <SearchIcon className="size-3.5 shrink-0" />
        <span className="flex-1 text-left">Search</span>
        <span className="rounded-none border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {metaKey} K
        </span>
      </button>

      {/* api keys */}
      <Link
        to={RoutePath.KEYS}
        className={navCellClass(pathname.startsWith(RoutePath.KEYS), 'hidden border-l border-border lg:inline-flex')}
      >
        <KeyRound className="size-3.5" />
        API Keys
      </Link>

      {/* onboarding guide */}
      <button
        type="button"
        onClick={openOnboardingGuide}
        aria-label="Open onboarding guide"
        className="hidden h-full items-center gap-2 border-l border-border px-[18px] text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground lg:inline-flex"
      >
        <BookOpen className="size-3.5" />
        <span className="hidden sm:inline">Quickstart</span>
      </button>

      {/* profile menu (organization switcher tucked inside) */}
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label="Open profile menu"
          className="inline-flex h-full items-center gap-2 border-l border-border px-3 text-[13px] font-medium text-foreground outline-none transition-colors hover:bg-card data-[state=open]:bg-card sm:px-4"
        >
          <span className="flex size-[23px] shrink-0 items-center justify-center overflow-hidden bg-brand text-[9px] font-extrabold text-white">
            {user?.profile.picture ? (
              <img src={user.profile.picture} alt={userName} className="h-full w-full object-cover" />
            ) : (
              initials
            )}
          </span>
          <span className="hidden max-w-[140px] truncate xl:inline">{userName}</span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[18rem]">
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
          {selectedOrganization && (
            <DropdownMenuItem asChild className="cursor-pointer">
              <Link to={RoutePath.SETTINGS}>
                <Building2 className="size-4" />
                Organization
              </Link>
            </DropdownMenuItem>
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
          {canViewAdmin && (
            <DropdownMenuItem asChild className="cursor-pointer">
              <Link to={RoutePath.ADMIN}>
                <ShieldCheck className="size-4" />
                Admin
              </Link>
            </DropdownMenuItem>
          )}
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
          className="inline-flex h-full items-center border-l border-border px-4 text-muted-foreground outline-none transition-colors hover:text-foreground lg:hidden"
        >
          <MoreHorizontal className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[14rem]">
          <DropdownMenuItem className="cursor-pointer" onClick={() => openCommandPalette('dashboard_mobile_menu')}>
            <SearchIcon className="size-4" />
            Search
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {primaryItems.map((item) => (
            <DropdownMenuItem key={item.label} asChild className="cursor-pointer">
              <Link to={item.path}>{item.label}</Link>
            </DropdownMenuItem>
          ))}
          <DropdownMenuItem asChild className="cursor-pointer">
            <Link to={RoutePath.KEYS}>
              <KeyRound className="size-4" />
              API Keys
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem className="cursor-pointer" onClick={openOnboardingGuide}>
            <BookOpen className="size-4" />
            Quickstart
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  )
}
