import { Test, type TestingModule } from '@nestjs/testing'
import type { IncomingMessage } from 'http'
import { createProxyMiddleware } from 'http-proxy-middleware'
import { BoxAutoResumeService } from '../box/services/box-auto-resume.service'
import { BoxService } from '../box/services/box.service'
import { RunnerService } from '../box/services/runner.service'
import { BoxliteProxyController } from './boxlite-proxy.controller'
import { BoxliteWsProxyService } from './boxlite-ws-proxy.service'

jest.mock('http-proxy-middleware', () => ({ createProxyMiddleware: jest.fn(), fixRequestBody: jest.fn() }))
jest.mock('uuid', () => ({ v4: jest.fn(() => 'mock-uuid'), validate: jest.fn(() => true) }))

describe('existing-session recovery', () => {
  let module: TestingModule
  const auth = { organizationId: 'org-1', organization: { id: 'org-1', suspended: false } }
  const boxService = {
    findOneByIdOrName: jest.fn(),
    updateLastActivityAt: jest.fn().mockResolvedValue(undefined),
  }
  const autoResume = { ensureReady: jest.fn().mockResolvedValue(undefined) }
  const proxy = Object.assign(jest.fn(), { upgrade: jest.fn() })

  beforeEach(async () => {
    jest.clearAllMocks()
    boxService.findOneByIdOrName.mockResolvedValue({
      id: 'box-uuid',
      runnerId: 'runner-1',
      state: 'stopped',
      autoResume: true,
    })
    jest.mocked(createProxyMiddleware).mockReturnValue(proxy as never)
    module = await Test.createTestingModule({
      providers: [
        BoxliteWsProxyService,
        BoxliteProxyController,
        { provide: BoxService, useValue: boxService },
        { provide: BoxAutoResumeService, useValue: autoResume },
        {
          provide: RunnerService,
          useValue: {
            findOne: jest.fn().mockResolvedValue({ apiUrl: 'http://runner.local', apiKey: 'runner-key' }),
          },
        },
      ],
    })
      .useMocker(() => ({}))
      .compile()
  })

  afterEach(async () => {
    await module.close()
  })

  it('keeps the main session stopped across initial attach and execution reconnect', async () => {
    const service = module.get(BoxliteWsProxyService)
    jest.spyOn(service as any, 'authenticate').mockResolvedValue(auth)
    const socket = { write: jest.fn(), destroy: jest.fn() }
    const head = Buffer.alloc(0)

    for (const suffix of ['attach', 'executions/main-1/attach']) {
      const req = {
        url: `/api/v1/org-1/boxes/public-box/${suffix}`,
        headers: { authorization: 'Bearer test' },
      } as IncomingMessage
      await service.upgrade(req, socket as never, head)
      expect(autoResume.ensureReady).not.toHaveBeenCalled()
      expect(proxy.upgrade).toHaveBeenLastCalledWith(req, socket, head)
      expect(req).toMatchObject({ __boxliteRunnerBoxId: 'box-uuid' })
      expect(socket.destroy).not.toHaveBeenCalled()
    }
  })

  it.each([
    ['proxyExecStatus', ''],
    ['proxyExecSignal', '/signal'],
    ['proxyExecResize', '/resize'],
    ['proxyExecKill', ''],
  ] as const)('%s never restarts a box to address an existing session', async (method, suffix) => {
    const controller = module.get(BoxliteProxyController)
    const req = { url: `/api/v1/boxes/public-box/executions/main-1${suffix}` }
    const res = {}
    const next = jest.fn()
    await controller[method](auth as never, 'public-box', 'main-1', req as never, res as never, next)
    expect(autoResume.ensureReady).not.toHaveBeenCalled()
    expect(boxService.updateLastActivityAt).toHaveBeenCalledWith('box-uuid', expect.any(Date))
    expect(proxy).toHaveBeenCalledWith(req, res, next)
    const options = jest.mocked(createProxyMiddleware).mock.calls.at(-1)![0]
    expect((options.pathRewrite as () => string)()).toBe(`/v1/boxes/box-uuid/executions/main-1${suffix}`)
  })
})
