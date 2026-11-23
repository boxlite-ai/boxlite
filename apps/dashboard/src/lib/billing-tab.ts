export function billingTab(params: URLSearchParams) {
  const tab = params.get('tab')
  return tab && ['plans', 'usage', 'wallet'].includes(tab) ? tab : 'overview'
}
