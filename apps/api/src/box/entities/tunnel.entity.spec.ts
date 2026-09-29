import { getMetadataArgsStorage, QueryRunner } from 'typeorm'
import { AddTunnelTable1790294400000 } from '../../migrations/pre-deploy/1790294400000-add-tunnel-table-migration'
import { Tunnel } from './tunnel.entity'

describe('Tunnel schema metadata', () => {
  it('maps the creation timestamp defined by the migration', async () => {
    const queryRunner = { query: jest.fn() } as unknown as QueryRunner
    await new AddTunnelTable1790294400000().up(queryRunner)
    const createTable = jest.mocked(queryRunner.query).mock.calls[0][0] as string
    const createdAt = getMetadataArgsStorage().columns.find(
      (column) => column.target === Tunnel && column.propertyName === 'createdAt',
    )

    expect(createTable).toContain('"created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()')
    expect(createdAt).toMatchObject({
      mode: 'createDate',
      options: { name: 'created_at', type: 'timestamp with time zone' },
    })
    expect(createdAt?.options.default()).toBe('now()')
  })

  it('uses the same key and check constraints as the migration', async () => {
    const queryRunner = { query: jest.fn() } as unknown as QueryRunner
    await new AddTunnelTable1790294400000().up(queryRunner)
    const createTable = jest.mocked(queryRunner.query).mock.calls[0][0] as string
    const metadata = getMetadataArgsStorage()
    const id = metadata.columns.find((column) => column.target === Tunnel && column.propertyName === 'id')
    const box = metadata.joinColumns.find((column) => column.target === Tunnel && column.propertyName === 'box')
    const checks = metadata.checks.filter((check) => check.target === Tunnel)

    expect(createTable).toContain('CONSTRAINT "tunnel_id_pk" PRIMARY KEY ("id")')
    expect(createTable).toContain('CONSTRAINT "tunnel_box_id_fk" FOREIGN KEY ("box_id")')
    expect(createTable).toContain('CONSTRAINT "tunnel_port_range" CHECK ("port" BETWEEN 1 AND 65535)')
    expect(createTable).toContain('CONSTRAINT "tunnel_mode_token" CHECK')
    expect(id?.options.primaryKeyConstraintName).toBe('tunnel_id_pk')
    expect(box?.foreignKeyConstraintName).toBe('tunnel_box_id_fk')
    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'tunnel_port_range', expression: '"port" BETWEEN 1 AND 65535' }),
        expect.objectContaining({
          name: 'tunnel_mode_token',
          expression: `("access_mode" = 'public' AND "token_hash" IS NULL) OR ("access_mode" = 'private' AND "token_hash" IS NOT NULL)`,
        }),
      ]),
    )
  })
})
