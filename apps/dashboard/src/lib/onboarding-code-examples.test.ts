import { describe, expect, it } from 'vitest'
import { getOnboardingCodeExamples } from './onboarding-code-examples'

describe('onboarding code examples', () => {
  it('includes SDK, CLI, and REST entrypoints', () => {
    const examples = getOnboardingCodeExamples()

    expect(Object.keys(examples).sort()).toEqual(['c', 'cli', 'go', 'python', 'rest', 'rust', 'typescript'])
  })

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

  it('executes code in a box for the added entrypoints', () => {
    const examples = getOnboardingCodeExamples()

    expect(examples.c.example).toContain('getenv("BOXLITE_API_KEY")')
    expect(examples.c.example).toContain('boxlite_create_box')
    expect(examples.c.example).toContain('boxlite_start_box')
    expect(examples.c.example).toContain('boxlite_box_exec')
    expect(examples.c.example).toContain('boxlite_remove')

    expect(examples.cli.example).toContain('boxlite run --rm --name sdk-quickstart')
    expect(examples.cli.example).toContain('echo "Hello from BoxLite CLI"')

    expect(examples.rest.example).toContain('${BOXLITE_REST_URL}/v1/boxes')
    expect(examples.rest.example).toContain('/start')
    expect(examples.rest.example).toContain('/exec')
    expect(examples.rest.example).toContain('/executions/${exec_id}')
    expect(examples.rest.example).toContain('-X DELETE')
  })
})
