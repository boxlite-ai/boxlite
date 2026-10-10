/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

const sendMail = jest.fn(async () => undefined)
jest.mock('nodemailer', () => ({ createTransport: () => ({ sendMail }) }))
// Hand back the template data so the test can read the link the service built.
jest.mock('ejs', () => ({ renderFile: jest.fn(async (_path: string, data: unknown) => JSON.stringify(data)) }))

import { EmailService } from './email.service'
import { OrganizationInvitationCreatedEvent } from '../../organization/events/organization-invitation-created.event'

describe('EmailService invitation email', () => {
  it('links to the invitations page under the dashboard router', async () => {
    const service = new EmailService({
      host: 'smtp.example.com',
      port: 587,
      from: 'noreply@example.com',
      dashboardUrl: 'https://console.example.com',
    } as never)

    await service.handleOrganizationInvitationCreated(
      new OrganizationInvitationCreatedEvent(
        'Acme',
        'owner@example.com',
        'invitee@example.com',
        'inv-1',
        new Date('2026-10-05T00:00:00.000Z'),
      ),
    )

    const [message] = sendMail.mock.calls[0] as unknown as [{ html: string }]
    expect(JSON.parse(message.html).invitationLink).toBe(
      'https://console.example.com/dashboard/user/invitations?id=inv-1',
    )
  })
})
