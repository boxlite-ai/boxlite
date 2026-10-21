import { Column, Entity, PrimaryColumn, Unique } from 'typeorm'
import { CreateBoxDto } from '../box/dto/create-box.dto'

@Entity('filesystem_snapshot')
@Unique(['organizationId', 'sourceBoxId', 'name'])
export class FilesystemSnapshot {
  @PrimaryColumn('uuid') id: string
  @Column('uuid') organizationId: string
  @Column('uuid') runnerId: string
  @Column() nativeId: string
  @Column() sourceBoxId: string
  @Column() name: string
  @Column('jsonb') metadata: Record<string, unknown>
  @Column('jsonb') createOptions: CreateBoxDto
}
