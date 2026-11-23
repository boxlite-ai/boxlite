/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { InternalServerErrorException } from '@nestjs/common'
import { DataSource } from 'typeorm'
import { CancellationFeedbackService } from './cancellation-feedback.service'
import { CancellationFeedbackController } from '../controllers/cancellation-feedback.controller'

it('sanitizes persistence failures instead of leaking SQL parameters', async () => {
  const service = new CancellationFeedbackService({
    query: jest.fn().mockRejectedValue(new Error('query: private answer')),
  } as unknown as DataSource)
  await expect(
    service.save('org', 'owner', { reasons: ['other'], intent: null, note: 'private answer' }),
  ).rejects.toEqual(new InternalServerErrorException('Unable to save cancellation feedback. Please retry.'))
})

it('rejects machine credentials before membership lookup or feedback persistence', async () => {
  const save = jest.fn()
  const findOne = jest.fn()
  const controller = new CancellationFeedbackController({ save } as never, { findOne } as never)
  for (const actor of [{ userId: 'owner', apiKey: {} }, { userId: '' }]) {
    await expect(controller.save(actor as never, { reasons: ['pricing'] })).rejects.toThrow(
      'Organization owner required',
    )
  }
  expect(findOne).not.toHaveBeenCalled()
  expect(save).not.toHaveBeenCalled()
})
