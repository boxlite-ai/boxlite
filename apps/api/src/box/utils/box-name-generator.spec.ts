import { generateBoxName, persistWithGeneratedBoxName } from './box-name-generator'

const uniqueViolation = () => Object.assign(new Error('duplicate key'), { code: '23505' })

describe('generateBoxName', () => {
  it('defaults to a clean {adjective}-{animal} name (no suffix)', () => {
    for (let i = 0; i < 100; i++) {
      const name = generateBoxName()
      const parts = name.split('-')
      expect(parts).toHaveLength(2)
      expect(parts[0]).toMatch(/^[a-z]+$/)
      expect(parts[1]).toMatch(/^[a-z]+$/)
    }
  })

  it('produces variety across many calls', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 50; i++) seen.add(generateBoxName())
    // 9600 base combos — <40 uniques out of 50 picks would mean the generator
    // is stuck on a near-constant.
    expect(seen.size).toBeGreaterThan(40)
  })
})

describe('persistWithGeneratedBoxName', () => {
  it('persists a clean (unsuffixed) name on the first try', async () => {
    const names: string[] = []
    const result = await persistWithGeneratedBoxName('aB3kF9mZ2pQ7', async (name) => {
      names.push(name)
      return name
    })
    expect(names).toHaveLength(1)
    expect(result.split('-')).toHaveLength(2) // clean: adjective-animal
  })

  it('appends the box id when the clean name collides', async () => {
    const names: string[] = []
    const result = await persistWithGeneratedBoxName('aB3kF9mZ2pQ7', async (name) => {
      names.push(name)
      if (names.length === 1) throw uniqueViolation() // clean name taken
      return name
    })
    expect(names).toHaveLength(2)
    expect(names[0].split('-')).toHaveLength(2) // first attempt: clean adjective-animal
    expect(result).toBe(`${names[0]}-aB3kF9mZ2pQ7`) // fallback reuses the base + box id
    expect(result.endsWith('-aB3kF9mZ2pQ7')).toBe(true)
  })

  it('does not fall back on a non-unique-violation error', async () => {
    let calls = 0
    await expect(
      persistWithGeneratedBoxName('aB3kF9mZ2pQ7', async () => {
        calls++
        throw new Error('connection reset')
      }),
    ).rejects.toThrow('connection reset')
    expect(calls).toBe(1)
  })
})
