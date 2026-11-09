/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { CreditCardIcon } from '@/components/ui/icon'
import visa from '@/assets/payment-brands/visa.svg'
import mastercard from '@/assets/payment-brands/mastercard.svg'
import amex from '@/assets/payment-brands/amex.svg'
import discover from '@/assets/payment-brands/discover.svg'
import diners from '@/assets/payment-brands/diners.svg'
import jcb from '@/assets/payment-brands/jcb.svg'
import unionpay from '@/assets/payment-brands/unionpay.svg'

const logos: Record<string, string | undefined> = {
  VISA: visa,
  MASTERCARD: mastercard,
  AMEX: amex,
  'AMERICAN EXPRESS': amex,
  DISCOVER: discover,
  DINERS: diners,
  'DINERS CLUB': diners,
  JCB: jcb,
  UNIONPAY: unionpay,
}

export function PaymentBrand({ brand }: { brand: string }) {
  const logo = logos[brand]
  return (
    <span
      role="img"
      aria-label={brand}
      className="inline-flex h-10 w-16 shrink-0 items-center justify-center overflow-hidden border border-border bg-card"
    >
      {logo ? (
        <img src={logo} alt="" className="h-full w-full object-contain" />
      ) : (
        <CreditCardIcon aria-hidden="true" className="size-6 text-muted-foreground" />
      )}
      <span className="sr-only" aria-hidden="true">
        {brand}
      </span>
    </span>
  )
}
