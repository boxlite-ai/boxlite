/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { join } from 'path'
import { baseDataSourceOptions } from '../data-source'
import { MigrationDataSource } from '../migration-data-source'

const PostDeployDataSource = new MigrationDataSource({
  ...baseDataSourceOptions,
  migrations: [join(__dirname, '*-migration.{ts,js}')],
})

export default PostDeployDataSource
