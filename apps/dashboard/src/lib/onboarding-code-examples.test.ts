import { describe, expect, it } from 'vitest'
import { getOnboardingCodeExamples } from './onboarding-code-examples'

describe('onboarding code examples', () => {
  it('reads API keys from environment variables instead of interactive prompts', () => {
    const examples = getOnboardingCodeExamples()

    expect(examples.python.example).toContain('os.environ["BOXLITE_API_KEY"]')
    expect(examples.python.example).not.toContain('getpass')
    expect(examples.python.example).not.toContain('Paste your BoxLite API key')

    expect(examples.typescript.example).toContain('process.env.BOXLITE_API_KEY')
    expect(examples.typescript.example).not.toContain('readline')
    expect(examples.typescript.example).not.toContain('question(')

    expect(examples.go.example).toContain('os.Getenv("BOXLITE_API_KEY")')
    expect(examples.go.example).not.toContain('ReadString')
    expect(examples.go.example).not.toContain('os.Stdin')

    expect(examples.rust.example).toContain('std::env::var("BOXLITE_API_KEY")')
    expect(examples.rust.example).not.toContain('stdin()')
    expect(examples.rust.example).not.toContain('read_line')
  })
})
