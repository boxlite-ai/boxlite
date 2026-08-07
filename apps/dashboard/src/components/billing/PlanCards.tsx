/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { OrganizationTier, Tier } from '@/billing-api'
import { AsciiButton, BRAND } from '@/components/ascii'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { TIER_RATE_LIMITS } from '@/constants/limits'
import {
  canUpgradeTo,
  formatDollars,
  getUpgradeRequirements,
  type TierRequirement,
  type TierRequirementsState,
} from '@/components/billing/tierRequirements'
import { useDowngradeTierMutation } from '@/hooks/mutations/useDowngradeTierMutation'
import { useUpgradeTierMutation } from '@/hooks/mutations/useUpgradeTierMutation'
import { handleApiError } from '@/lib/error-handling'
import { useState } from 'react'
import { toast } from 'sonner'

/**
 * Tier catalogue as a card grid. Every value comes from `Tier` — the API exposes
 * resource ceilings and a top-up requirement, not prices or quotas, so the cards
 * are specced on what a tier actually grants.
 */

function topUpRequirement(tier: Tier): string | null {
  if (!tier.minTopUpAmountCents) {
    return null
  }
  const amount = formatDollars(tier.minTopUpAmountCents)
  return tier.topUpIntervalDays ? `${amount} every ${tier.topUpIntervalDays} days` : `${amount} one time`
}

function SpecRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2 font-mono text-[12px]">
      <span className="uppercase tracking-[0.5px] text-muted-foreground">{label}</span>
      <span className="tabular-nums text-foreground">{value}</span>
    </div>
  )
}

/** With no tier assigned yet, tier 0 is the floor — every real tier is an upgrade. */
function isUpgradeTo(tier: Tier, currentTier?: number): boolean {
  return tier.tier > (currentTier ?? 0)
}

function PlanCard({
  tier,
  currentTier,
  onSwitch,
  pending,
  requirements,
}: {
  tier: Tier
  currentTier?: number
  onSwitch: (tier: Tier) => void
  pending: boolean
  requirements: TierRequirement[]
}) {
  const isActive = tier.tier === currentTier
  const isUpgrade = isUpgradeTo(tier, currentTier)
  const requirement = topUpRequirement(tier)
  const rateLimits = TIER_RATE_LIMITS[tier.tier]
  const unmet = requirements.filter((item) => !item.isChecked)
  const upgradeBlocked = isUpgrade && !canUpgradeTo(requirements)

  return (
    <div
      className={`flex flex-col border bg-card px-[22px] py-5 transition-transform hover:-translate-y-0.5 ${
        isActive ? 'border-brand/60' : 'border-border hover:border-brand/40'
      }`}
    >
      <div className="mb-4 flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[1.5px] text-muted-foreground">
          <span style={{ color: BRAND }}>▸</span> Tier {tier.tier}
        </span>
        {isActive && (
          <span className="bg-foreground px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[1px] text-background">
            current
          </span>
        )}
      </div>

      <div className="mb-4">
        <span className="font-mono text-[26px] font-semibold leading-none tracking-tight tabular-nums text-foreground">
          T{tier.tier}
        </span>
      </div>

      <div className="mb-5 flex-1 divide-y divide-border/40">
        <SpecRow label="Compute" value={`${tier.tierLimit.concurrentCPU} vCPU`} />
        <SpecRow label="Memory" value={`${tier.tierLimit.concurrentRAMGiB} GiB`} />
        <SpecRow label="Storage" value={`${tier.tierLimit.concurrentDiskGiB} GiB`} />
        {rateLimits && (
          <>
            <SpecRow label="API req/min" value={rateLimits.authenticatedRateLimit.toLocaleString()} />
            <SpecRow label="Creates/min" value={rateLimits.boxCreateRateLimit.toLocaleString()} />
            <SpecRow label="Lifecycle/min" value={rateLimits.boxLifecycleRateLimit.toLocaleString()} />
          </>
        )}
      </div>

      {isUpgrade && unmet.length ? (
        <div className="mb-4 flex flex-col gap-1">
          {unmet.map((item) => (
            <span key={item.label} className="font-mono text-[11px] leading-relaxed text-warning">
              &#9633; {item.label}
            </span>
          ))}
        </div>
      ) : (
        <p className="mb-4 font-mono text-[11px] leading-relaxed text-muted-foreground">
          {requirement ? `Requires a top-up of ${requirement}.` : 'No top-up requirement.'}
        </p>
      )}

      {isActive ? (
        <AsciiButton disabled className="w-full text-muted-foreground">
          Current tier
        </AsciiButton>
      ) : isUpgrade ? (
        <AsciiButton
          variant="primary"
          className="w-full"
          disabled={pending || upgradeBlocked}
          title={upgradeBlocked ? 'Complete the requirements above to upgrade' : undefined}
          onClick={() => onSwitch(tier)}
        >
          Upgrade →
        </AsciiButton>
      ) : (
        <AsciiButton className="w-full" disabled={pending} onClick={() => onSwitch(tier)}>
          Downgrade
        </AsciiButton>
      )}
    </div>
  )
}

/** Loading state shaped like the grid it replaces, not like the old tier table. */
export function PlanCardsSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 gap-[14px] md:grid-cols-2 xl:grid-cols-4">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex flex-col gap-3 border border-border bg-card px-[22px] py-5">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-7 w-16" />
          <Skeleton className="h-[132px] w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      ))}
    </div>
  )
}

/**
 * Enterprise sits below the grid rather than in it: the API returns four real
 * tiers, so a fifth card would orphan onto its own row.
 */
export function EnterpriseRow() {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border border-border bg-card px-[22px] py-4">
      <div className="flex flex-col gap-1">
        <span className="font-mono text-[11px] text-muted-foreground">
          Custom limits and compliance review. Contact sales at{' '}
          <a href="mailto:sales@boxlite.ai" className="underline hover:text-foreground">
            sales@boxlite.ai
          </a>
          .
        </span>
      </div>
      <a
        href="mailto:sales@boxlite.ai?subject=Custom%20Tier%20Inquiry&body=Hi%20BoxLite%20Team%2C%0A%0AI%27m%20interested%20in%20a%20custom%20plan%20and%20would%20like%20to%20learn%20more%20about%20your%20options.%0A%0AHere%27s%20some%20context%3A%0A%0A-%20Your%20use%20case%3A%20%0A-%20Current%20technology%3A%20%0A-%20Requirements%3A%20%0A-%20Typical%20box%20size%3A%20%0A-%20Peak%20concurrent%20boxes%3A%20%0A%0AThanks."
        className="border border-border px-4 py-2 font-mono text-[12px] text-foreground transition-colors hover:border-brand"
      >
        Contact sales →
      </a>
    </div>
  )
}

export function PlanCards({
  tiers,
  organizationTier,
  organizationId,
  requirementsState,
}: {
  tiers: Tier[]
  organizationTier?: OrganizationTier | null
  organizationId: string
  requirementsState: TierRequirementsState
}) {
  const [confirmTier, setConfirmTier] = useState<Tier | null>(null)
  const upgradeTier = useUpgradeTierMutation()
  const downgradeTier = useDowngradeTierMutation()
  const pending = upgradeTier.isPending || downgradeTier.isPending
  const currentTier = organizationTier?.tier

  const isUpgrade = !!confirmTier && isUpgradeTo(confirmTier, currentTier)

  const handleConfirm = async () => {
    if (!confirmTier) {
      return
    }
    const target = confirmTier.tier
    const upgrading = isUpgradeTo(confirmTier, currentTier)
    setConfirmTier(null)
    try {
      if (upgrading) {
        await upgradeTier.mutateAsync({ organizationId, tier: target })
        toast.success('Tier upgraded successfully')
      } else {
        await downgradeTier.mutateAsync({ organizationId, tier: target })
        toast.success('Tier downgraded successfully')
      }
    } catch (error) {
      handleApiError(error, `Failed to ${upgrading ? 'upgrade' : 'downgrade'} organization tier`)
    }
  }

  return (
    <>
      <div className="grid grid-cols-1 gap-[14px] md:grid-cols-2 xl:grid-cols-4">
        {tiers.map((tier) => (
          <PlanCard
            key={tier.tier}
            tier={tier}
            currentTier={currentTier}
            onSwitch={setConfirmTier}
            pending={pending}
            requirements={getUpgradeRequirements(requirementsState, organizationTier, tier, tiers)}
          />
        ))}
      </div>

      <AlertDialog open={!!confirmTier} onOpenChange={(open) => !open && setConfirmTier(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{isUpgrade ? 'Upgrade tier' : 'Downgrade tier'}</AlertDialogTitle>
            <AlertDialogDescription>
              {isUpgrade
                ? `Switch to Tier ${confirmTier?.tier}. Higher resource ceilings apply once the tier requirements are met.`
                : `Switch to Tier ${confirmTier?.tier}. Your resource ceilings drop to that tier's limits.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirm}>Confirm</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
