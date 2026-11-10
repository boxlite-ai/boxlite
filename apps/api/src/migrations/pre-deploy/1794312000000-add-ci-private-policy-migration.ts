/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { MigrationInterface, QueryRunner } from 'typeorm'

/** Development cutover only: old Public consent must never become Private consent. */
export class AddCiPrivatePolicy1794312000000 implements MigrationInterface {
  private async rename(
    runner: QueryRunner,
    oldName: 'allow_public' | 'allow_private',
    newName: 'allow_public' | 'allow_private',
  ) {
    await runner.query(`DO $$ BEGIN
      LOCK TABLE ci_installation_binding,ci_connect_attempt,ci_listener_state IN ACCESS EXCLUSIVE MODE;
      IF EXISTS (SELECT 1 FROM ci_installation_binding) OR EXISTS (SELECT 1 FROM ci_connect_attempt)
        OR EXISTS (SELECT 1 FROM ci_listener_state) THEN
        RAISE EXCEPTION 'Finish CI resource cleanup, stop Listeners and reset CI state before changing visibility policy';
      END IF;
      ALTER TABLE ci_installation_binding RENAME COLUMN ${oldName} TO ${newName};
      ALTER TABLE ci_connect_attempt RENAME COLUMN ${oldName} TO ${newName};
      ALTER TABLE ci_installation_binding ALTER COLUMN ${newName} SET DEFAULT false;
      ALTER TABLE ci_connect_attempt ALTER COLUMN ${newName} SET DEFAULT false;
    END $$`)
  }
  up(runner: QueryRunner) {
    return this.rename(runner, 'allow_public', 'allow_private')
  }
  down(runner: QueryRunner) {
    return this.rename(runner, 'allow_private', 'allow_public')
  }
}
