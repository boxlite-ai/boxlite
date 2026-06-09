# Onboarding Companion UX Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Convert the dashboard onboarding from a linear wizard into a stateful Boxes-page companion that follows create, terminal, lifecycle, developer, and pricing paths.

**Architecture:** Keep the current dashboard routing and modal entry, but replace the wizard body with checklist cards. Persist lightweight onboarding progress in local storage by user. Let the Create Box sheet and Box details page update that progress through shared helpers.

**Tech Stack:** React, React Router, Tailwind, local storage, existing Radix dialog/sheet primitives.

---

### Task 1: Persist Onboarding Progress

**Files:**
- Modify: `apps/dashboard/src/enums/LocalStorageKey.ts`
- Create: `apps/dashboard/src/lib/onboarding-progress.ts`

**Steps:**
1. Add an onboarding progress local-storage prefix.
2. Add helpers to read, merge, count, and dispatch progress updates.
3. Keep progress scoped by authenticated user id.

### Task 2: Replace Wizard With Checklist Companion

**Files:**
- Modify: `apps/dashboard/src/components/OnboardingGuideDialog.tsx`

**Steps:**
1. Replace left step nav and footer wizard buttons with stacked checklist cards.
2. Show core tasks: create, terminal, lifecycle.
3. Move SDK/API examples into a single optional Connect from code section.
4. Keep language selector only inside the developer section.
5. Add pricing notice and link.
6. Make the layout full-height on mobile and card-based on desktop.

### Task 3: Wire Boxes Journey

**Files:**
- Modify: `apps/dashboard/src/pages/Sandboxes.tsx`
- Modify: `apps/dashboard/src/components/Sandbox/CreateSandboxSheet.tsx`
- Modify: `apps/dashboard/src/components/Sidebar.tsx`

**Steps:**
1. Read and update onboarding progress in Boxes.
2. Keep Guide entry visible with a progress badge.
3. When Create Box opens from guide or table, minimize onboarding context instead of ending it.
4. When Box creation succeeds, mark create complete and navigate to terminal as before.

### Task 4: Wire Terminal/Lifecycle Journey

**Files:**
- Modify: `apps/dashboard/src/components/sandboxes/SandboxDetails.tsx`

**Steps:**
1. Detect terminal tab visits and mark terminal step available.
2. Show a compact onboarding banner on Box details when core onboarding is incomplete.
3. Let users mark terminal/lifecycle as understood after they see terminal and header actions.

### Task 5: Polish Pricing, Resources, and Mobile

**Files:**
- Modify: `apps/dashboard/src/pages/Pricing.tsx`
- Modify: `apps/dashboard/src/components/ResourceChip.tsx`

**Steps:**
1. Make pricing page visually stronger with a product visual, trial message, and future billing signals.
2. Make resource chips consistent across table, create sheet, and detail panel.
3. Verify desktop and mobile browser flows.
