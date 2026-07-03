import { describe, expect, it } from 'vitest'
import {
  getOnboardingCodeExamples,
  getOnboardingInterfaces,
  renderOnboardingCodeExample,
} from './onboarding-code-examples'

describe('onboarding code examples', () => {
  it('includes SDK, CLI, and REST entrypoints', () => {
    const examples = getOnboardingCodeExamples()

    expect(Object.keys(examples).sort()).toEqual(['c', 'cli', 'go', 'python', 'rest', 'rust', 'typescript'])
  })

  it('is driven by registry entries that all render templates', () => {
    const interfaces = getOnboardingInterfaces()
    const examples = getOnboardingCodeExamples()

    expect(interfaces.map((item) => item.id)).toEqual(['python', 'typescript', 'go', 'rust', 'c', 'cli', 'rest'])

    for (const item of interfaces) {
      const example = examples[item.id]
      expect(example).toBeDefined()
      expect(example.id).toBe(item.id)
      expect(example.label).toBe(item.label)
      expect(example.install).not.toContain('{{')
      expect(example.run).not.toContain('{{')
      expect(example.example).not.toContain('{{')
      expect(example.executionDescription.length).toBeGreaterThan(20)
    }
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
    expect(examples.c.example).toContain('pthread_create')
    expect(examples.c.example).toContain('boxlite_runtime_drain(loop->runtime, 100')
    expect(examples.c.example).not.toContain('boxlite_runtime_drain(qs->runtime, -1')
    expect(examples.c.example).toContain('boxlite_execution_stdin_close')
    expect(examples.c.example).toContain('boxlite_remove')
    expect(examples.c.example).not.toContain('boxlite_options_free(box_options)')
    expect(examples.c.run).toContain('-pthread')

    expect(examples.python.example).toContain('sdk-quickstart-python-')
    expect(examples.typescript.example).toContain('sdk-quickstart-node-')
    expect(examples.go.example).toContain('sdk-quickstart-go-')
    expect(examples.rust.example).toContain('sdk-quickstart-rust-')
    expect(examples.rust.example).toContain('let mut exec =')
    expect(examples.c.example).toContain('sdk-quickstart-c-')

    expect(examples.cli.example).toContain('boxlite run --rm --name "sdk-quickstart-cli-$(date +%s)"')
    expect(examples.cli.example).toContain('echo "Hello from BoxLite CLI"')
    expect(examples.cli.example).toContain('Paste your BoxLite API key from Step 1')

    expect(examples.rest.example).toContain('Paste your BoxLite API key from Step 1')
    expect(examples.rest.example).toContain('name="sdk-quickstart-rest-$(date +%s)"')
    expect(examples.rest.example).not.toContain('"name":"sdk-quickstart"')
    expect(examples.rest.example).toContain('${BOXLITE_REST_URL}/v1/boxes')
    expect(examples.rest.example).toContain('/start')
    expect(examples.rest.example).toContain('/exec')
    expect(examples.rest.example).toContain('/executions/${exec_id}')
    expect(examples.rest.example).toContain('-X DELETE')
  })

  it('keeps REST setup focused on required local tools', () => {
    const examples = getOnboardingCodeExamples()

    expect(examples.rest.install).toBe(`command -v curl
command -v jq`)
    expect(examples.rest.install).not.toContain('box.openapi.yaml')
    expect(examples.rest.setupLabel).toBe('Check REST tools')
    expect(examples.rest.setupDescription).toContain('REST does not require an SDK install')
    expect(examples.rest.setupDescription).toContain('OpenAPI is available')
  })

  it('injects the generated API key into rendered quickstart examples', () => {
    const apiKey = 'blk_test_generated_key'
    const interfaces = getOnboardingInterfaces().map((item) => item.id)

    for (const selectedInterface of interfaces) {
      expect(
        renderOnboardingCodeExample(selectedInterface, { apiKey, restApiUrl: 'https://dev.boxlite.ai/api' }),
      ).toContain(apiKey)
    }

    expect(renderOnboardingCodeExample('cli', { apiKey, restApiUrl: 'https://dev.boxlite.ai/api' })).not.toContain(
      'Paste your BoxLite API key from Step 1',
    )
    expect(renderOnboardingCodeExample('rest', { apiKey, restApiUrl: 'https://dev.boxlite.ai/api' })).not.toContain(
      'Paste your BoxLite API key from Step 1',
    )
  })
})
