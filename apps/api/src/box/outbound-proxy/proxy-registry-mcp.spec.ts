import { McpCatalog } from '../../mcp/mcp-catalog'

describe('proxy registry routes in the MCP catalog', () => {
  it('keeps reads and mutations out of every catalog even when delegated and served', () => {
    const paths = {
      '/boxes': { get: { operationId: 'listBoxes' } },
      '/proxies': { post: { operationId: 'registerProxy' }, get: { operationId: 'listProxies' } },
      '/{prefix}/proxies/{name}': { patch: { operationId: 'updateProxy' } },
    }
    const dashboardPaths = {
      '/api/v1/proxies': { post: { operationId: 'registerDashboardProxy' } },
      '/api/v1/{prefix}/proxies/{name}': { patch: { operationId: 'updateDashboardProxy' } },
    }
    for (const source of ['box', 'admin'] as const) {
      const catalog = new McpCatalog({
        box: {},
        admin: {},
        dashboard: { paths: dashboardPaths },
        [source]: { paths },
        served: () => true,
        delegable: () => true,
      })
      expect(catalog.all().map(({ operationId }) => operationId)).toEqual(['listBoxes'])
      expect(catalog.get('registerProxy')).toBeUndefined()
      expect(catalog.get('updateProxy')).toBeUndefined()
      expect(catalog.get('registerDashboardProxy')).toBeUndefined()
      expect(catalog.get('updateDashboardProxy')).toBeUndefined()
    }
  })
})
