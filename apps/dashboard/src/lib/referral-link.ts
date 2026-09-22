export function registrationLink(origin: string, referralCode: string): string {
  const url = new URL('/register', origin)
  url.searchParams.set('referredCode', referralCode)
  return url.toString()
}
