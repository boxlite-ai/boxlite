/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Button } from '@/components/ui/button'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Badge } from '@/components/ui/badge'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
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
import { useCreateSandboxFromTemplateMutation } from '@/hooks/mutations/useCreateSandboxFromTemplateMutation'
import { useTemplatesQuery } from '@/hooks/queries/useTemplatesQuery'
import type { BoxTemplate } from '@/hooks/queries/useTemplatesQuery'
import { useConfig } from '@/hooks/useConfig'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { getTemplateDisplayMetadata, getTemplateDisplaySortIndex } from '@/lib/template-display'
import { handleApiError } from '@/lib/error-handling'
import { getSandboxRouteId } from '@/lib/sandbox-identity'
import { cn } from '@/lib/utils'
import type { Sandbox } from '@boxlite-ai/api-client'
import { useForm } from '@tanstack/react-form'
import { Cpu, HardDrive, MemoryStick, Plus, type LucideIcon } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  template: z.string().min(1, 'Select an image'),
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
  template: '',
  autoStopInterval: '',
  autoDeleteInterval: '',
  cpu: '',
  memory: '',
  disk: '',
}

const getTemplateName = (template: BoxTemplate) => template.name

const getTemplateLabel = (template: BoxTemplate) => {
  const templateName = getTemplateName(template)
  return template.displayName || getTemplateDisplayMetadata(templateName)?.displayName || templateName
}

const getTemplateDescription = (template: BoxTemplate) => {
  const templateName = getTemplateName(template)
  return template.description || getTemplateDisplayMetadata(templateName)?.description
}

const getTemplateCapabilities = (template: BoxTemplate) => template.capabilities ?? []

const formatCapability = (capability: string) =>
  capability
    .split('-')
    .map((word) => word.slice(0, 1).toUpperCase() + word.slice(1))
    .join(' ')

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

export const CreateSandboxSheet = ({
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
  onCreated?: (sandbox: Sandbox) => void
}) => {
  const navigate = useNavigate()
  const [internalOpen, setInternalOpen] = useState(false)
  const [advancedOptionsOpen, setAdvancedOptionsOpen] = useState(false)
  const [focusedAdvancedField, setFocusedAdvancedField] = useState<string | null>(null)
  const open = controlledOpen ?? internalOpen
  const setOpen = onOpenChange ?? setInternalOpen

  const { defaultTemplate } = useConfig()
  const { selectedOrganization } = useSelectedOrganization()
  const { reset: resetCreateSandboxMutation, ...createSandboxMutation } = useCreateSandboxFromTemplateMutation()
  const formRef = useRef<HTMLFormElement>(null)

  const { data: templatesData, isLoading: templatesLoading } = useTemplatesQuery()

  const templates = useMemo(() => {
    const items = templatesData ?? []
    return [...items].sort((a, b) => {
      if (a.name === defaultTemplate || a.id === defaultTemplate) return -1
      if (b.name === defaultTemplate || b.id === defaultTemplate) return 1
      const order = getTemplateDisplaySortIndex(getTemplateName(a)) - getTemplateDisplaySortIndex(getTemplateName(b))
      if (order !== 0) return order

      return getTemplateLabel(a).localeCompare(getTemplateLabel(b))
    })
  }, [defaultTemplate, templatesData])

  const defaultTemplateId = templates[0]?.id ?? ''

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

      if (!value.template) {
        toast.error('Select an image to create a box.')
        return
      }

      let sandboxId: string | undefined = undefined
      try {
        // Product copy calls this an Image. The API keeps templateId because
        // BoxTemplate owns defaults, visibility, and the runtime artifactRef.
        const sandbox = await createSandboxMutation.mutateAsync({
          name: value.name?.trim() || undefined,
          templateId: value.template,
          public: false,
          networkBlockAll: false,
          autoStopInterval: parseOptionalInteger(value.autoStopInterval),
          autoDeleteInterval: parseOptionalInteger(value.autoDeleteInterval),
          cpu: parseOptionalInteger(value.cpu),
          memory: parseOptionalInteger(value.memory),
          disk: parseOptionalInteger(value.disk),
        })
        sandboxId = getSandboxRouteId(sandbox)
        onCreated?.(sandbox)

        toast.success('Box created')
        setOpen(false)

        if (sandboxId) {
          navigate({
            pathname: generatePath(RoutePath.BOX_DETAILS, { sandboxId }),
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
    resetCreateSandboxMutation()
  }, [resetCreateSandboxMutation, form])

  useEffect(() => {
    if (open) {
      resetState()
    }
  }, [open, resetState])

  useEffect(() => {
    if (!open || !defaultTemplateId || form.getFieldValue('template')) {
      return
    }
    form.setFieldValue('template', defaultTemplateId)
  }, [defaultTemplateId, form, open])

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
            id="create-sandbox-form"
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

            <form.Field name="template">
              {(field) => {
                const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid
                return (
                  <Field data-invalid={isInvalid}>
                    <FieldLabel id={`${field.name}-label`} className="text-sm font-semibold">
                      Image
                    </FieldLabel>
                    <FieldDescription>Pick a runtime image.</FieldDescription>
                    {templatesLoading ? (
                      <div className="flex items-center gap-2 rounded-md border bg-muted/25 px-3 py-3 text-sm text-muted-foreground">
                        <Spinner className="size-4" />
                        Loading images...
                      </div>
                    ) : (
                      <RadioGroup
                        aria-invalid={isInvalid}
                        aria-labelledby={`${field.name}-label`}
                        className="gap-2"
                        value={field.state.value}
                        onValueChange={field.handleChange}
                      >
                        {templates.map((template) => {
                          const templateName = getTemplateName(template)
                          const templateLabel = getTemplateLabel(template)
                          const templateDescription = getTemplateDescription(template)
                          const capabilities = getTemplateCapabilities(template)
                          const isDefault = template.name === defaultTemplate || template.id === defaultTemplate
                          const isSelected = field.state.value === template.id
                          const radioId = `${field.name}-${template.id}`

                          return (
                            <div
                              key={template.id}
                              className={cn(
                                'group flex min-w-0 cursor-pointer items-start gap-3 rounded-md border bg-background p-3 text-left transition-colors hover:border-primary/35 hover:bg-muted/30',
                                isSelected &&
                                  'border-primary/60 bg-primary/5 shadow-[inset_2px_0_0_hsl(var(--primary))]',
                              )}
                            >
                              <RadioGroupItem id={radioId} value={template.id} className="mt-1 shrink-0" />
                              <Label htmlFor={radioId} className="flex min-w-0 flex-1 cursor-pointer flex-col gap-1.5">
                                <span className="flex min-w-0 items-start justify-between gap-3">
                                  <span className="min-w-0">
                                    <span className="block truncate text-sm font-medium leading-5 text-foreground">
                                      {templateLabel}
                                    </span>
                                    {templateName !== templateLabel && (
                                      <span className="block truncate font-mono text-[11px] leading-4 text-muted-foreground">
                                        {templateName}
                                      </span>
                                    )}
                                  </span>
                                  {isDefault && (
                                    <Badge
                                      variant="secondary"
                                      className="h-5 shrink-0 rounded-sm px-1.5 text-[11px] font-medium leading-none"
                                    >
                                      Default
                                    </Badge>
                                  )}
                                </span>
                                {templateDescription && (
                                  <span className="line-clamp-2 text-xs leading-4 text-muted-foreground">
                                    {templateDescription}
                                  </span>
                                )}
                                {capabilities.length > 0 && (
                                  <span className="flex flex-wrap gap-1.5 pt-0.5">
                                    {capabilities.map((capability) => (
                                      <span
                                        key={capability}
                                        className="rounded-sm border bg-background px-1.5 py-0.5 text-[11px] font-medium leading-4 text-foreground/70"
                                      >
                                        {formatCapability(capability)}
                                      </span>
                                    ))}
                                  </span>
                                )}
                              </Label>
                            </div>
                          )
                        })}
                      </RadioGroup>
                    )}
                    {!templatesLoading && templates.length === 0 && (
                      <div className="rounded-md border bg-muted/35 p-4 text-sm text-muted-foreground">
                        No images available.
                      </div>
                    )}
                    {field.state.meta.errors.length > 0 && field.state.meta.isTouched && (
                      <FieldError errors={field.state.meta.errors} />
                    )}
                  </Field>
                )
              }}
            </form.Field>

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
                form="create-sandbox-form"
                variant="default"
                disabled={isSubmitting || !selectedOrganization?.id || templates.length === 0}
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
