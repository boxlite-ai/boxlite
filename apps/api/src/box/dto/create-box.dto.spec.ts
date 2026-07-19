import 'reflect-metadata'
import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'
import { CreateBoxDto } from './create-box.dto'

describe('CreateBoxDto auto-stop interval', () => {
  it.each([0, 1, 300])('accepts non-negative integer seconds: %s', async (interval) => {
    const errors = await validate(plainToInstance(CreateBoxDto, { autoStopInterval: interval }))

    expect(errors).toHaveLength(0)
  })

  it.each([-1, 1.5, 2_147_483_648])('rejects invalid auto-stop interval: %s', async (interval) => {
    const errors = await validate(plainToInstance(CreateBoxDto, { autoStopInterval: interval }))

    expect(JSON.stringify(errors)).toMatch(/(min|isInt|max)/)
  })
})
