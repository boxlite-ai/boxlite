/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Button } from '@/components/ui/button'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import { Spinner } from '@/components/ui/spinner'
import { RoutePath } from '@/enums/RoutePath'
import { useCreateBoxMutation } from '@/hooks/mutations/useCreateBoxMutation'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { handleApiError } from '@/lib/error-handling'
import { getBoxRouteId } from '@/lib/box-identity'
import { cn } from '@/lib/utils'
import type { Box } from '@boxlite-ai/api-client'
import { useForm } from '@tanstack/react-form'
import { Cpu, HardDrive, MemoryStick, Plus, type LucideIcon } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { NumericFormat } from 'react-number-format'
import { createSearchParams, generatePath, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { z } from 'zod'
import { ScrollArea } from '../ui/scroll-area'

const NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/
const MAX_INTERVAL_MINUTES = 2_147_483_647

const isOptionalIntegerInRange = (value: string | undefined, min: number) => {
  const trimmedValue = value?.trim()
  if (!trimmedValue) return true
  if (!/^-?\d+$/.test(trimmedValue)) return false

  const numericValue = Number(trimmedValue)
  return Number.isSafeInteger(numericValue) && numericValue >= min && numericValue <= MAX_INTERVAL_MINUTES
}

const isOptionalPositiveInteger = (value: string | undefined) => {
  const trimmedValue = value?.trim()
  if (!trimmedValue) return true
  if (!/^\d+$/.test(trimmedValue)) return false

  const numericValue = Number(trimmedValue)
  return Number.isSafeInteger(numericValue) && numericValue >= 1
}

const parseOptionalInteger = (value: string | undefined) => {
  const trimmedValue = value?.trim()
  return trimmedValue ? Number(trimmedValue) : undefined
}

const formSchema = z.object({
  name: z
    .string()
    .optional()
    .refine((val) => !val || NAME_REGEX.test(val), 'Only letters, digits, dots, underscores and dashes are allowed'),
  autoStopInterval: z
    .string()
    .optional()
    .refine((val) => isOptionalIntegerInRange(val, 0), 'Enter a whole number of minutes, 0 or greater'),
  autoDeleteInterval: z
    .string()
    .optional()
    .refine((val) => isOptionalIntegerInRange(val, -1), 'Enter a whole number of minutes, -1 or greater'),
  cpu: z.string().optional().refine(isOptionalPositiveInteger, 'Enter a whole number, 1 or greater'),
  memory: z.string().optional().refine(isOptionalPositiveInteger, 'Enter a whole number, 1 or greater'),
  disk: z.string().optional().refine(isOptionalPositiveInteger, 'Enter a whole number, 1 or greater'),
})

type FormValues = z.input<typeof formSchema>

const defaultValues: FormValues = {
  name: '',
  autoStopInterval: '',
  autoDeleteInterval: '',
  cpu: '',
  memory: '',
  disk: '',
}

type ResourceFieldName = 'cpu' | 'memory' | 'disk'

const RESOURCE_FIELDS: Array<{
  name: ResourceFieldName
  label: string
  unit: string
  Icon: LucideIcon
}> = [
  { name: 'cpu', label: 'CPU', unit: 'vCPU', Icon: Cpu },
  { name: 'memory', label: 'Memory', unit: 'GiB', Icon: MemoryStick },
  { name: 'disk', label: 'Disk', unit: 'GiB', Icon: HardDrive },
]

export const CreateBoxSheet = ({
  className,
  triggerClassName,
  open: controlledOpen,
  onOpenChange,
  onCreated,
}: {
  className?: string
  triggerClassName?: string
  open?: boolean
  onOpenChange?: (open: boolean) => void
  onCreated?: (box: Box) => void
}) => {
  const navigate = useNavigate()
  const [internalOpen, setInternalOpen] = useState(false)
  const [advancedOptionsOpen, setAdvancedOptionsOpen] = useState(false)
  const [focusedAdvancedField, setFocusedAdvancedField] = useState<string | null>(null)
  const open = controlledOpen ?? internalOpen
  const setOpen = onOpenChange ?? setInternalOpen

  const { selectedOrganization } = useSelectedOrganization()
  const { reset: resetCreateBoxMutation, ...createBoxMutation } = useCreateBoxMutation()
  const formRef = useRef<HTMLFormElement>(null)

  const form = useForm({
    defaultValues,
    validators: {
      onSubmit: formSchema,
    },
    onSubmitInvalid: () => {
      const formEl = formRef.current
      if (!formEl) return
      const invalidInput = formEl.querySelector('[aria-invalid="true"]') as HTMLInputElement | null
      if (invalidInput) {
        invalidInput.scrollIntoView({ behavior: 'smooth', block: 'center' })
        invalidInput.focus()
      }
    },
    onSubmit: async ({ value }) => {
      if (!selectedOrganization?.id) {
        toast.error('Select an organization to create a box.')
        return
      }

      let boxId: string | undefined = undefined
      try {
        // TODO(image-rewrite): the image/template picker was removed with the image/template
        // subsystem; box creation no longer selects an image. Rebuild image selection here once
        // the new model lands.
        const box = await createBoxMutation.mutateAsync({
          name: value.name?.trim() || undefined,
          public: false,
          networkBlockAll: false,
          autoStopInterval: parseOptionalInteger(value.autoStopInterval),
          autoDeleteInterval: parseOptionalInteger(value.autoDeleteInterval),
          cpu: parseOptionalInteger(value.cpu),
          memory: parseOptionalInteger(value.memory),
          disk: parseOptionalInteger(value.disk),
        })
        boxId = getBoxRouteId(box)
        onCreated?.(box)

        toast.success('Box created')
        setOpen(false)

        if (boxId) {
          navigate({
            pathname: generatePath(RoutePath.BOX_DETAILS, { boxId }),
            search: `${createSearchParams({
              tab: 'terminal',
            })}`,
          })
        }
      } catch (error) {
        handleApiError(error, 'Failed to create box')
      }
    },
  })

  const resetState = useCallback(() => {
    form.reset(defaultValues)
    setAdvancedOptionsOpen(false)
    setFocusedAdvancedField(null)
    resetCreateBoxMutation()
  }, [resetCreateBoxMutation, form])

  useEffect(() => {
    if (open) {
      resetState()
    }
  }, [open, resetState])

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="default" size="sm" title="Create Box" className={cn('w-full sm:w-auto', triggerClassName)}>
          <Plus className="size-4" />
          <span>Create Box</span>
        </Button>
      </SheetTrigger>
      <SheetContent className={`w-dvw sm:w-[600px] p-0 flex flex-col gap-0 ${className ?? ''}`}>
        <SheetHeader className="border-b border-border p-5 px-6 items-center flex text-left flex-row">
          <SheetTitle className="text-lg font-semibold leading-tight">Create Box</SheetTitle>
          <SheetDescription className="sr-only">Create a new box in your organization.</SheetDescription>
        </SheetHeader>
        <ScrollArea fade="mask" className="flex-1 min-h-0">
          <form
            ref={formRef}
            id="create-box-form"
            className="gap-5 flex flex-col p-5 sm:p-6"
            onSubmit={(e) => {
              e.preventDefault()
              e.stopPropagation()
              form.handleSubmit()
            }}
          >
            <form.Field name="name">
              {(field) => {
                const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid
                return (
                  <Field data-invalid={isInvalid}>
                    <FieldLabel htmlFor={field.name} className="text-sm font-semibold">
                      Name
                    </FieldLabel>
                    <Input
                      aria-invalid={isInvalid}
                      id={field.name}
                      name={field.name}
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(e) => field.handleChange(e.target.value)}
                      placeholder="my-box"
                    />
                    {field.state.meta.errors.length > 0 && field.state.meta.isTouched && (
                      <FieldError errors={field.state.meta.errors} />
                    )}
                  </Field>
                )
              }}
            </form.Field>

            {/* TODO(image-rewrite): image/template picker removed with the image/template subsystem; rebuild here. */}

            <Accordion
              type="single"
              collapsible
              value={advancedOptionsOpen ? 'advanced-options' : ''}
              onValueChange={(value) => setAdvancedOptionsOpen(value === 'advanced-options')}
              className="mt-3 flex flex-col gap-3"
            >
              <AccordionItem value="advanced-options" className="border-b-0">
                <AccordionTrigger className="py-1 text-sm font-semibold hover:no-underline [&>svg]:size-5">
                  Advanced options
                </AccordionTrigger>
                <AccordionContent className="pb-0 pt-4">
                  <div className="space-y-5">
                    <div className="space-y-3">
                      <div>
                        <Label className="text-sm font-semibold">Resources</Label>
                        <p className="text-xs text-muted-foreground">Blank uses defaults.</p>
                      </div>
                      <div className="grid gap-3">
                        {RESOURCE_FIELDS.map(({ name, label, unit, Icon }) => (
                          <form.Field key={name} name={name}>
                            {(field) => {
                              const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid
                              return (
                                <div className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_11rem] sm:items-center">
                                  <div className="min-w-0">
                                    <Label
                                      htmlFor={field.name}
                                      className="flex items-center gap-1 text-xs font-medium text-muted-foreground"
                                    >
                                      <Icon className="size-3.5" />
                                      {label}
                                    </Label>
                                    <p className="mt-0.5 text-xs text-muted-foreground">Optional.</p>
                                  </div>
                                  <div className="relative min-w-0">
                                    <NumericFormat
                                      customInput={Input}
                                      aria-invalid={isInvalid}
                                      id={field.name}
                                      className="h-8 w-full pr-11 text-right font-medium tabular-nums placeholder:font-normal placeholder:text-muted-foreground/45"
                                      placeholder={focusedAdvancedField === field.name ? '' : 'Default'}
                                      decimalScale={0}
                                      allowNegative={false}
                                      isAllowed={(values) => values.floatValue === undefined || values.floatValue >= 1}
                                      value={field.state.value ?? ''}
                                      onFocus={() => setFocusedAdvancedField(field.name)}
                                      onBlur={() => {
                                        field.handleBlur()
                                        setFocusedAdvancedField((currentField) =>
                                          currentField === field.name ? null : currentField,
                                        )
                                      }}
                                      onValueChange={(values) => field.handleChange(values.value)}
                                    />
                                    <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-muted-foreground">
                                      {unit}
                                    </span>
                                    {field.state.meta.errors.length > 0 && field.state.meta.isTouched && (
                                      <FieldError errors={field.state.meta.errors} />
                                    )}
                                  </div>
                                </div>
                              )
                            }}
                          </form.Field>
                        ))}
                      </div>
                    </div>

                    <div className="space-y-3 border-t pt-4">
                      <div>
                        <Label className="text-sm font-semibold">Lifecycle</Label>
                        <p className="text-xs text-muted-foreground">Blank uses defaults.</p>
                      </div>
                      <div className="grid gap-3">
                        <form.Field name="autoStopInterval">
                          {(field) => {
                            const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid
                            return (
                              <div className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_11rem] sm:items-center">
                                <div className="min-w-0">
                                  <Label htmlFor={field.name} className="text-xs font-medium text-muted-foreground">
                                    Auto-stop
                                  </Label>
                                  <p className="mt-0.5 text-xs text-muted-foreground">Default: 15 min</p>
                                </div>
                                <div className="relative min-w-0">
                                  <NumericFormat
                                    customInput={Input}
                                    aria-invalid={isInvalid}
                                    id={field.name}
                                    className="h-8 w-full pr-10 text-right font-medium tabular-nums placeholder:font-normal placeholder:text-muted-foreground/45"
                                    placeholder={focusedAdvancedField === field.name ? '' : '15'}
                                    decimalScale={0}
                                    allowNegative={false}
                                    value={field.state.value ?? ''}
                                    onFocus={() => setFocusedAdvancedField(field.name)}
                                    onBlur={() => {
                                      field.handleBlur()
                                      setFocusedAdvancedField((currentField) =>
                                        currentField === field.name ? null : currentField,
                                      )
                                    }}
                                    onValueChange={(values) => field.handleChange(values.value)}
                                  />
                                  <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-muted-foreground">
                                    min
                                  </span>
                                  {field.state.meta.errors.length > 0 && field.state.meta.isTouched && (
                                    <FieldError errors={field.state.meta.errors} />
                                  )}
                                </div>
                              </div>
                            )
                          }}
                        </form.Field>

                        <form.Field name="autoDeleteInterval">
                          {(field) => {
                            const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid
                            return (
                              <div className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_11rem] sm:items-center">
                                <div className="min-w-0">
                                  <Label htmlFor={field.name} className="text-xs font-medium text-muted-foreground">
                                    Auto-delete
                                  </Label>
                                  <p className="mt-0.5 text-xs text-muted-foreground">Default: Disabled</p>
                                </div>
                                <div className="min-w-0">
                                  <NumericFormat
                                    customInput={Input}
                                    aria-invalid={isInvalid}
                                    id={field.name}
                                    className="h-8 w-full text-right font-medium tabular-nums placeholder:font-normal placeholder:text-muted-foreground/45"
                                    placeholder={focusedAdvancedField === field.name ? '' : 'Disabled'}
                                    decimalScale={0}
                                    allowNegative
                                    isAllowed={(values) => {
                                      if (values.floatValue === undefined) return true
                                      return values.floatValue === -1 || values.floatValue >= 0
                                    }}
                                    value={field.state.value ?? ''}
                                    onFocus={() => setFocusedAdvancedField(field.name)}
                                    onBlur={() => {
                                      field.handleBlur()
                                      setFocusedAdvancedField((currentField) =>
                                        currentField === field.name ? null : currentField,
                                      )
                                    }}
                                    onValueChange={(values) => field.handleChange(values.value)}
                                  />
                                  {field.state.meta.errors.length > 0 && field.state.meta.isTouched && (
                                    <FieldError errors={field.state.meta.errors} />
                                  )}
                                </div>
                              </div>
                            )
                          }}
                        </form.Field>
                      </div>
                    </div>
                  </div>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </form>
        </ScrollArea>
        <SheetFooter className="border-t border-border p-5 pt-3 sm:justify-start">
          <form.Subscribe
            selector={(state) => state.isSubmitting}
            children={(isSubmitting) => (
              <Button
                type="submit"
                form="create-box-form"
                variant="default"
                disabled={isSubmitting || !selectedOrganization?.id}
                className="w-full sm:w-auto"
              >
                {isSubmitting && <Spinner />}
                Create
              </Button>
            )}
          />
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
