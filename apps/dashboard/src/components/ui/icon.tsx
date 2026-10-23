/*
 * ASCII / pixel icon shim — drop-in replacement for lucide-react.
 * Every lucide name used in the app is re-exported here under the SAME name, mapped to the
 * semantically-equivalent pixelarticons (8-bit, angular) glyph. Call sites only swap the import
 * source ('lucide-react' -> '@/components/ui/icon'); props (className/size/style) are unchanged.
 * The logo is the only mark NOT routed through here.
 */
import React from 'react'
import { Icon as IconifyIcon, addCollection } from '@iconify/react'
import {
  ArrowUpRight as LucideArrowUpRight,
  Check as LucideCheck,
  ChevronDown as LucideChevronDown,
  ChevronRight as LucideChevronRight,
  Copy as LucideCopy,
  ExternalLink as LucideExternalLink,
  MoreHorizontal as LucideMoreHorizontal,
  MoreVertical as LucideMoreVertical,
  Plus as LucidePlus,
  RefreshCw as LucideRefreshCw,
  Search as LucideSearch,
  Settings as LucideSettings,
  Trash2 as LucideTrash2,
  X as LucideX,
} from 'lucide-react'
import pixelarticons from '@iconify-json/pixelarticons/icons.json'

// Register the collection once (offline — no network fetch) so "pixelarticons:*" resolves.
addCollection(pixelarticons)

export type LucideProps = React.SVGProps<SVGSVGElement> & {
  size?: number | string
  absoluteStrokeWidth?: boolean
}
export type LucideIcon = React.FC<LucideProps>

// Utility actions (copy, open, settings, overflow, chevrons, search, add,
// delete, close) use one thin line family so a control reads as a control.
// Pixel glyphs stay for brand and resource identity.
function utility(Line: React.ComponentType<LucideProps>): LucideIcon {
  const Cmp: LucideIcon = ({ strokeWidth = 1.6, ...rest }) => <Line strokeWidth={strokeWidth} {...rest} />
  Cmp.displayName = `Line${Line.displayName ?? ''}`
  return Cmp
}

function makeIcon(pixelName: string): LucideIcon {
  const Cmp: LucideIcon = ({ size = 24, width, height, strokeWidth, absoluteStrokeWidth, mode, ...rest }) => {
    void strokeWidth
    void absoluteStrokeWidth
    void mode

    const iconProps = rest as Omit<React.ComponentProps<typeof IconifyIcon>, 'icon' | 'width' | 'height'>

    return (
      <IconifyIcon icon={`pixelarticons:${pixelName}`} width={width ?? size} height={height ?? size} {...iconProps} />
    )
  }
  Cmp.displayName = pixelName
  return Cmp
}

export const Activity = makeIcon('trending')
export const AlertCircle = makeIcon('warning-box')
export const AlertCircleIcon = makeIcon('warning-box')
export const AlertTriangle = makeIcon('alert')
export const AlertTriangleIcon = makeIcon('alert')
export const TriangleAlert = makeIcon('alert')
export const TriangleAlertIcon = makeIcon('alert')
export const AlignCenterIcon = makeIcon('align-center')
export const AlignLeftIcon = makeIcon('align-left')
export const AlignRightIcon = makeIcon('align-right')
export const ArrowDown = makeIcon('arrow-down')
export const ArrowDownIcon = makeIcon('arrow-down')
export const ArrowLeft = makeIcon('arrow-left')
export const ArrowRightIcon = makeIcon('arrow-right')
export const ArrowUp = makeIcon('arrow-up')
export const ArrowUpIcon = makeIcon('arrow-up')
export const ArrowUpDownIcon = makeIcon('arrows-vertical')
export const ArrowUpRight = utility(LucideArrowUpRight)
export const BarChart3 = makeIcon('chart-bar')
export const BoldIcon = makeIcon('heading')
export const BookOpen = makeIcon('book-open')
export const BookSearchIcon = makeIcon('book-open')
export const Bot = makeIcon('robot')
export const Building2 = makeIcon('building')
export const Calendar = makeIcon('calendar')
export const CalendarIcon = makeIcon('calendar')
export const Check = utility(LucideCheck)
export const CheckIcon = makeIcon('check')
export const CheckCircle = makeIcon('check')
export const CheckCircle2 = makeIcon('check')
export const CheckCircle2Icon = makeIcon('check')
export const CheckCircleIcon = makeIcon('check')
export const CheckSquare2Icon = makeIcon('checkbox-on')
export const ChevronDown = utility(LucideChevronDown)
export const ChevronDownIcon = makeIcon('chevron-down')
export const ChevronLeft = makeIcon('chevron-left')
export const ChevronLeftIcon = makeIcon('chevron-left')
export const ChevronRight = utility(LucideChevronRight)
export const ChevronRightIcon = makeIcon('chevron-right')
export const ChevronUp = makeIcon('chevron-up')
export const ChevronsDownUp = makeIcon('chevrons-vertical')
export const ChevronsUpDown = makeIcon('chevrons-vertical')
export const ChevronsLeft = makeIcon('chevron-left-2')
export const ChevronsRight = makeIcon('chevron-right-2')
export const Circle = makeIcon('circle')
export const CircleDashed = makeIcon('circle')
export const Clipboard = makeIcon('clipboard')
export const ClipboardPaste = makeIcon('clipboard')
export const Clock = makeIcon('clock')
export const Code2 = makeIcon('braces')
export const CommandIcon = makeIcon('command')
export const Container = makeIcon('package')
export const Cookie = makeIcon('info-box')
export const Copy = utility(LucideCopy)
export const CopyIcon = makeIcon('copy')
export const Cpu = makeIcon('cpu')
export const CpuIcon = makeIcon('cpu')
export const CreditCardIcon = makeIcon('credit-card')
export const Database = makeIcon('database')
export const Braces = makeIcon('braces')
export const CloudUpload = makeIcon('cloud-upload')
export const Folder = makeIcon('folder')
export const Globe = makeIcon('globe')
export const LayoutDashboard = makeIcon('dashboard')
export const DollarSign = makeIcon('dollar')
export const ExternalLink = utility(LucideExternalLink)
export const ExternalLinkIcon = makeIcon('external-link')
export const Eye = makeIcon('eye')
export const EyeIcon = makeIcon('eye')
export const EyeOff = makeIcon('eye-off')
export const FileText = makeIcon('file-text')
export const Github = makeIcon('github')
/** An environment: a branch of the app. */
export const GitBranch = makeIcon('git-branch')
/** An App: an app window an agent built (not a Box). */
export const AgentApp = makeIcon('ai-app-mac')
export const HardDrive = makeIcon('database')
export const HardDriveIcon = makeIcon('database')
export const Home = makeIcon('home')
export const HomeIcon = makeIcon('home')
export const Info = makeIcon('info-box')
export const InfoIcon = makeIcon('info-box')
export const KeyRound = makeIcon('lock')
export const LifeBuoyIcon = makeIcon('headset')
export const Link2 = makeIcon('link')
export const ListChecks = makeIcon('checklist')
export const Loader2 = makeIcon('loader')
export const Loader2Icon = makeIcon('loader')
export const LoaderCircle = makeIcon('loader')
export const LogOut = makeIcon('logout')
export const Mail = makeIcon('mail')
export const MailIcon = makeIcon('mail')
export const MapPinned = makeIcon('map-pin')
export const Maximize2 = makeIcon('expand')
export const MegaphoneIcon = makeIcon('megaphone')
export const MemoryStick = makeIcon('memory-stick')
export const MemoryStickIcon = makeIcon('memory-stick')
export const MessageCircle = makeIcon('message')
export const MinusIcon = makeIcon('minus')
export const MinusSquareIcon = makeIcon('minus-box')
export const Monitor = makeIcon('monitor')
export const MoonIcon = makeIcon('moon')
export const MoreHorizontal = utility(LucideMoreHorizontal)
export const MoreHorizontalIcon = makeIcon('more-horizontal')
export const MoreVertical = utility(LucideMoreVertical)
export const PanelLeft = makeIcon('layout-sidebar-left')
export const Pause = makeIcon('pause')
export const Pencil = makeIcon('edit')
export const Play = makeIcon('play')
export const PlayIcon = makeIcon('play')
export const Plus = utility(LucidePlus)
export const PlusIcon = makeIcon('plus')
export const PlusCircle = makeIcon('plus-box')
export const RefreshCcw = makeIcon('reload')
export const RefreshCw = utility(LucideRefreshCw)
export const RotateCcw = makeIcon('reload')
export const Search = utility(LucideSearch)
export const SearchIcon = makeIcon('search')
export const Server = makeIcon('server')
export const Settings = utility(LucideSettings)
export const SettingsIcon = makeIcon('settings-cog')
export const ShieldCheck = makeIcon('shield')
export const SparklesIcon = makeIcon('sparkles')
export const Square = makeIcon('square')
export const SquareIcon = makeIcon('square')
export const SquareTerminal = makeIcon('terminal')
export const SunIcon = makeIcon('sun')
export const SunMoon = makeIcon('moon-star')
export const Tag = makeIcon('label')
export const Terminal = makeIcon('terminal')
export const TerminalSquare = makeIcon('terminal')
export const TextSearch = makeIcon('text-search')
export const Timer = makeIcon('hourglass')
export const Trash = makeIcon('trash')
export const Trash2 = utility(LucideTrash2)
export const TrashIcon = makeIcon('trash')
export const Users = makeIcon('users')
export const UsersIcon = makeIcon('users')
export const UsersRound = makeIcon('users')
export const Wrench = makeIcon('tool-case')
export const X = utility(LucideX)
export const XIcon = makeIcon('close')
export const XCircle = makeIcon('close-box')
export const XCircleIcon = makeIcon('close-box')
