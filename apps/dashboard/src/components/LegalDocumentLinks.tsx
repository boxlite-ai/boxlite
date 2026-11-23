/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

export function LegalDocumentLinks({
  legal,
  acknowledge = false,
}: {
  legal: { tosUrl: string; privacyUrl: string }
  acknowledge?: boolean
}) {
  return (
    <>
      <a href={legal.tosUrl} target="_blank" rel="noreferrer" className="text-foreground underline underline-offset-4">
        Terms of Service
      </a>
      {acknowledge ? ' and acknowledge the ' : ' and '}
      <a
        href={legal.privacyUrl}
        target="_blank"
        rel="noreferrer"
        className="text-foreground underline underline-offset-4"
      >
        Privacy Policy
      </a>
    </>
  )
}
