/*
 * Shared thin-line SVG icons. Preserve caller overrides and native refs while
 * matching the console's light visual weight by default.
 */
import { forwardRef } from 'react'
import {
  Activity as LucideActivity,
  AlertCircle as LucideAlertCircle,
  AlertCircleIcon as LucideAlertCircleIcon,
  AlertTriangle as LucideAlertTriangle,
  AlertTriangleIcon as LucideAlertTriangleIcon,
  TriangleAlert as LucideTriangleAlert,
  TriangleAlertIcon as LucideTriangleAlertIcon,
  AlignCenterIcon as LucideAlignCenterIcon,
  AlignLeftIcon as LucideAlignLeftIcon,
  AlignRightIcon as LucideAlignRightIcon,
  ArrowDown as LucideArrowDown,
  ArrowDownIcon as LucideArrowDownIcon,
  ArrowLeft as LucideArrowLeft,
  ArrowRightIcon as LucideArrowRightIcon,
  ArrowUp as LucideArrowUp,
  ArrowUpIcon as LucideArrowUpIcon,
  ArrowUpDownIcon as LucideArrowUpDownIcon,
  ArrowUpRight as LucideArrowUpRight,
  BarChart3 as LucideBarChart3,
  BoldIcon as LucideBoldIcon,
  BookOpen as LucideBookOpen,
  BookSearchIcon as LucideBookSearchIcon,
  Bot as LucideBot,
  Building2 as LucideBuilding2,
  Calendar as LucideCalendar,
  CalendarIcon as LucideCalendarIcon,
  Check as LucideCheck,
  CheckIcon as LucideCheckIcon,
  CheckCircle as LucideCheckCircle,
  CheckCircle2 as LucideCheckCircle2,
  CheckCircle2Icon as LucideCheckCircle2Icon,
  CheckCircleIcon as LucideCheckCircleIcon,
  CheckSquare2Icon as LucideCheckSquare2Icon,
  ChevronDown as LucideChevronDown,
  ChevronDownIcon as LucideChevronDownIcon,
  ChevronLeft as LucideChevronLeft,
  ChevronLeftIcon as LucideChevronLeftIcon,
  ChevronRight as LucideChevronRight,
  ChevronRightIcon as LucideChevronRightIcon,
  ChevronUp as LucideChevronUp,
  ChevronsDownUp as LucideChevronsDownUp,
  ChevronsUpDown as LucideChevronsUpDown,
  ChevronsLeft as LucideChevronsLeft,
  ChevronsRight as LucideChevronsRight,
  Circle as LucideCircle,
  CircleDashed as LucideCircleDashed,
  Clipboard as LucideClipboard,
  ClipboardPaste as LucideClipboardPaste,
  Clock as LucideClock,
  Code2 as LucideCode2,
  CommandIcon as LucideCommandIcon,
  Box as LucideContainer,
  Cookie as LucideCookie,
  Copy as LucideCopy,
  CopyIcon as LucideCopyIcon,
  Cpu as LucideCpu,
  CpuIcon as LucideCpuIcon,
  CreditCardIcon as LucideCreditCardIcon,
  Database as LucideDatabase,
  DollarSign as LucideDollarSign,
  ExternalLink as LucideExternalLink,
  ExternalLinkIcon as LucideExternalLinkIcon,
  Eye as LucideEye,
  EyeIcon as LucideEyeIcon,
  EyeOff as LucideEyeOff,
  FileText as LucideFileText,
  Github as LucideGithub,
  HardDrive as LucideHardDrive,
  HardDriveIcon as LucideHardDriveIcon,
  Home as LucideHome,
  HomeIcon as LucideHomeIcon,
  Info as LucideInfo,
  InfoIcon as LucideInfoIcon,
  KeyRound as LucideKeyRound,
  LifeBuoyIcon as LucideLifeBuoyIcon,
  Link2 as LucideLink2,
  ListChecks as LucideListChecks,
  Loader2 as LucideLoader2,
  Loader2Icon as LucideLoader2Icon,
  LoaderCircle as LucideLoaderCircle,
  LogOut as LucideLogOut,
  Mail as LucideMail,
  MailIcon as LucideMailIcon,
  MapPinned as LucideMapPinned,
  Maximize2 as LucideMaximize2,
  MegaphoneIcon as LucideMegaphoneIcon,
  MemoryStick as LucideMemoryStick,
  MemoryStickIcon as LucideMemoryStickIcon,
  MessageCircle as LucideMessageCircle,
  MinusIcon as LucideMinusIcon,
  MinusSquareIcon as LucideMinusSquareIcon,
  Monitor as LucideMonitor,
  MoonIcon as LucideMoonIcon,
  MoreHorizontal as LucideMoreHorizontal,
  MoreHorizontalIcon as LucideMoreHorizontalIcon,
  MoreVertical as LucideMoreVertical,
  PanelLeft as LucidePanelLeft,
  Pause as LucidePause,
  Pencil as LucidePencil,
  Play as LucidePlay,
  PlayIcon as LucidePlayIcon,
  Plus as LucidePlus,
  PlusIcon as LucidePlusIcon,
  PlusCircle as LucidePlusCircle,
  RefreshCcw as LucideRefreshCcw,
  RefreshCw as LucideRefreshCw,
  RotateCcw as LucideRotateCcw,
  Search as LucideSearch,
  SearchIcon as LucideSearchIcon,
  Server as LucideServer,
  Settings as LucideSettings,
  SettingsIcon as LucideSettingsIcon,
  ShieldCheck as LucideShieldCheck,
  SparklesIcon as LucideSparklesIcon,
  Square as LucideSquare,
  SquareIcon as LucideSquareIcon,
  SquareTerminal as LucideSquareTerminal,
  SunIcon as LucideSunIcon,
  SunMoon as LucideSunMoon,
  Tag as LucideTag,
  Terminal as LucideTerminal,
  TerminalSquare as LucideTerminalSquare,
  TextSearch as LucideTextSearch,
  Timer as LucideTimer,
  Trash as LucideTrash,
  Trash2 as LucideTrash2,
  TrashIcon as LucideTrashIcon,
  Users as LucideUsers,
  UsersIcon as LucideUsersIcon,
  UsersRound as LucideUsersRound,
  Wrench as LucideWrench,
  X as LucideX,
  XIcon as LucideXIcon,
  XCircle as LucideXCircle,
  XCircleIcon as LucideXCircleIcon,
  Globe as LucideGlobe,
  Braces as LucideBraces,
  Layers as LucideLayers,
  type LucideIcon,
  type LucideProps,
} from 'lucide-react'

export type { LucideIcon, LucideProps } from 'lucide-react'

/** Supplies the console stroke weight without discarding native SVG props or refs. */
function thinIcon(Icon: LucideIcon): LucideIcon {
  const ThinIcon = forwardRef<SVGSVGElement, LucideProps>((props, ref) => (
    <Icon strokeWidth={1.3} {...props} ref={ref} />
  ))
  ThinIcon.displayName = Icon.displayName
  return ThinIcon
}

export const Activity = thinIcon(LucideActivity)
export const AlertCircle = thinIcon(LucideAlertCircle)
export const AlertCircleIcon = thinIcon(LucideAlertCircleIcon)
export const AlertTriangle = thinIcon(LucideAlertTriangle)
export const AlertTriangleIcon = thinIcon(LucideAlertTriangleIcon)
export const TriangleAlert = thinIcon(LucideTriangleAlert)
export const TriangleAlertIcon = thinIcon(LucideTriangleAlertIcon)
export const AlignCenterIcon = thinIcon(LucideAlignCenterIcon)
export const AlignLeftIcon = thinIcon(LucideAlignLeftIcon)
export const AlignRightIcon = thinIcon(LucideAlignRightIcon)
export const ArrowDown = thinIcon(LucideArrowDown)
export const ArrowDownIcon = thinIcon(LucideArrowDownIcon)
export const ArrowLeft = thinIcon(LucideArrowLeft)
export const ArrowRightIcon = thinIcon(LucideArrowRightIcon)
export const ArrowUp = thinIcon(LucideArrowUp)
export const ArrowUpIcon = thinIcon(LucideArrowUpIcon)
export const ArrowUpDownIcon = thinIcon(LucideArrowUpDownIcon)
export const ArrowUpRight = thinIcon(LucideArrowUpRight)
export const BarChart3 = thinIcon(LucideBarChart3)
export const BoldIcon = thinIcon(LucideBoldIcon)
export const BookOpen = thinIcon(LucideBookOpen)
export const BookSearchIcon = thinIcon(LucideBookSearchIcon)
export const Bot = thinIcon(LucideBot)
export const Building2 = thinIcon(LucideBuilding2)
export const Calendar = thinIcon(LucideCalendar)
export const CalendarIcon = thinIcon(LucideCalendarIcon)
export const Check = thinIcon(LucideCheck)
export const CheckIcon = thinIcon(LucideCheckIcon)
export const CheckCircle = thinIcon(LucideCheckCircle)
export const CheckCircle2 = thinIcon(LucideCheckCircle2)
export const CheckCircle2Icon = thinIcon(LucideCheckCircle2Icon)
export const CheckCircleIcon = thinIcon(LucideCheckCircleIcon)
export const CheckSquare2Icon = thinIcon(LucideCheckSquare2Icon)
export const ChevronDown = thinIcon(LucideChevronDown)
export const ChevronDownIcon = thinIcon(LucideChevronDownIcon)
export const ChevronLeft = thinIcon(LucideChevronLeft)
export const ChevronLeftIcon = thinIcon(LucideChevronLeftIcon)
export const ChevronRight = thinIcon(LucideChevronRight)
export const ChevronRightIcon = thinIcon(LucideChevronRightIcon)
export const ChevronUp = thinIcon(LucideChevronUp)
export const ChevronsDownUp = thinIcon(LucideChevronsDownUp)
export const ChevronsUpDown = thinIcon(LucideChevronsUpDown)
export const ChevronsLeft = thinIcon(LucideChevronsLeft)
export const ChevronsRight = thinIcon(LucideChevronsRight)
export const Circle = thinIcon(LucideCircle)
export const CircleDashed = thinIcon(LucideCircleDashed)
export const Clipboard = thinIcon(LucideClipboard)
export const ClipboardPaste = thinIcon(LucideClipboardPaste)
export const Clock = thinIcon(LucideClock)
export const Code2 = thinIcon(LucideCode2)
export const CommandIcon = thinIcon(LucideCommandIcon)
export const Container = thinIcon(LucideContainer)
export const Cookie = thinIcon(LucideCookie)
export const Copy = thinIcon(LucideCopy)
export const CopyIcon = thinIcon(LucideCopyIcon)
export const Cpu = thinIcon(LucideCpu)
export const CpuIcon = thinIcon(LucideCpuIcon)
export const CreditCardIcon = thinIcon(LucideCreditCardIcon)
export const Database = thinIcon(LucideDatabase)
export const DollarSign = thinIcon(LucideDollarSign)
export const ExternalLink = thinIcon(LucideExternalLink)
export const ExternalLinkIcon = thinIcon(LucideExternalLinkIcon)
export const Eye = thinIcon(LucideEye)
export const EyeIcon = thinIcon(LucideEyeIcon)
export const EyeOff = thinIcon(LucideEyeOff)
export const FileText = thinIcon(LucideFileText)
export const Github = thinIcon(LucideGithub)
export const HardDrive = thinIcon(LucideHardDrive)
export const HardDriveIcon = thinIcon(LucideHardDriveIcon)
export const Home = thinIcon(LucideHome)
export const HomeIcon = thinIcon(LucideHomeIcon)
export const Info = thinIcon(LucideInfo)
export const InfoIcon = thinIcon(LucideInfoIcon)
export const KeyRound = thinIcon(LucideKeyRound)
export const LifeBuoyIcon = thinIcon(LucideLifeBuoyIcon)
export const Link2 = thinIcon(LucideLink2)
export const ListChecks = thinIcon(LucideListChecks)
export const Loader2 = thinIcon(LucideLoader2)
export const Loader2Icon = thinIcon(LucideLoader2Icon)
export const LoaderCircle = thinIcon(LucideLoaderCircle)
export const LogOut = thinIcon(LucideLogOut)
export const Mail = thinIcon(LucideMail)
export const MailIcon = thinIcon(LucideMailIcon)
export const MapPinned = thinIcon(LucideMapPinned)
export const Maximize2 = thinIcon(LucideMaximize2)
export const MegaphoneIcon = thinIcon(LucideMegaphoneIcon)
export const MemoryStick = thinIcon(LucideMemoryStick)
export const MemoryStickIcon = thinIcon(LucideMemoryStickIcon)
export const MessageCircle = thinIcon(LucideMessageCircle)
export const MinusIcon = thinIcon(LucideMinusIcon)
export const MinusSquareIcon = thinIcon(LucideMinusSquareIcon)
export const Monitor = thinIcon(LucideMonitor)
export const MoonIcon = thinIcon(LucideMoonIcon)
export const MoreHorizontal = thinIcon(LucideMoreHorizontal)
export const MoreHorizontalIcon = thinIcon(LucideMoreHorizontalIcon)
export const MoreVertical = thinIcon(LucideMoreVertical)
export const PanelLeft = thinIcon(LucidePanelLeft)
export const Pause = thinIcon(LucidePause)
export const Pencil = thinIcon(LucidePencil)
export const Play = thinIcon(LucidePlay)
export const PlayIcon = thinIcon(LucidePlayIcon)
export const Plus = thinIcon(LucidePlus)
export const PlusIcon = thinIcon(LucidePlusIcon)
export const PlusCircle = thinIcon(LucidePlusCircle)
export const RefreshCcw = thinIcon(LucideRefreshCcw)
export const RefreshCw = thinIcon(LucideRefreshCw)
export const RotateCcw = thinIcon(LucideRotateCcw)
export const Search = thinIcon(LucideSearch)
export const SearchIcon = thinIcon(LucideSearchIcon)
export const Server = thinIcon(LucideServer)
export const Settings = thinIcon(LucideSettings)
export const SettingsIcon = thinIcon(LucideSettingsIcon)
export const ShieldCheck = thinIcon(LucideShieldCheck)
export const SparklesIcon = thinIcon(LucideSparklesIcon)
export const Square = thinIcon(LucideSquare)
export const SquareIcon = thinIcon(LucideSquareIcon)
export const SquareTerminal = thinIcon(LucideSquareTerminal)
export const SunIcon = thinIcon(LucideSunIcon)
export const SunMoon = thinIcon(LucideSunMoon)
export const Tag = thinIcon(LucideTag)
export const Terminal = thinIcon(LucideTerminal)
export const TerminalSquare = thinIcon(LucideTerminalSquare)
export const TextSearch = thinIcon(LucideTextSearch)
export const Timer = thinIcon(LucideTimer)
export const Trash = thinIcon(LucideTrash)
export const Trash2 = thinIcon(LucideTrash2)
export const TrashIcon = thinIcon(LucideTrashIcon)
export const Users = thinIcon(LucideUsers)
export const UsersIcon = thinIcon(LucideUsersIcon)
export const UsersRound = thinIcon(LucideUsersRound)
export const Wrench = thinIcon(LucideWrench)
export const X = thinIcon(LucideX)
export const XIcon = thinIcon(LucideXIcon)
export const XCircle = thinIcon(LucideXCircle)
export const XCircleIcon = thinIcon(LucideXCircleIcon)
export const Globe = thinIcon(LucideGlobe)
export const Braces = thinIcon(LucideBraces)

export const Layers = thinIcon(LucideLayers)
