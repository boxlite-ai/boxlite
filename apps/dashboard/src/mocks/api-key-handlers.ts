import { http, HttpResponse } from 'msw'
import { ApiKeyList, CreateApiKey } from '@boxlite-ai/api-client'
import { MOCK_ORGANIZATION, MOCK_USER } from './fixtures'

const API_URL = import.meta.env.VITE_API_URL
const keys = new Map<string, ApiKeyList[]>()
const organization = (request: Request) => request.headers.get('X-BoxLite-Organization-ID') || MOCK_ORGANIZATION.id

/** Synthetic, memory-only credentials exercise the complete local creation flow. */
export const apiKeyHandlers = [
  http.get(`${API_URL}/api-keys`, ({ request }) => HttpResponse.json(keys.get(organization(request)) ?? [])),
  http.post(`${API_URL}/api-keys`, async ({ request }) => {
    const body = (await request.json()) as CreateApiKey
    const org = organization(request)
    const current = keys.get(org) ?? []
    if (current.some((key) => key.name === body.name))
      return HttpResponse.json({ message: 'A key with this name already exists' }, { status: 409 })
    const value = `bxl_mock_${crypto.randomUUID()}`
    const key = {
      name: body.name,
      permissions: body.permissions,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      lastUsedAt: null,
      createdAt: new Date(),
      userId: MOCK_USER.sub,
    }
    keys.set(org, [...current, { ...key, value: `bxl_mock_********************${value.slice(-4)}` }])
    return HttpResponse.json({ ...key, value }, { status: 201 })
  }),
  http.delete(`${API_URL}/api-keys/:userId/:name`, ({ request, params }) => {
    const org = organization(request)
    keys.set(
      org,
      (keys.get(org) ?? []).filter((key) => key.name !== params.name || key.userId !== params.userId),
    )
    return new HttpResponse(null, { status: 204 })
  }),
]
