/**
 * フルマージのあいだトリガーを外す／戻す。
 *
 * トリガーが付いたままフルマージを走らせると、**取り込んだ行が自分の変更として
 * `_changelog` に記録され直す**（相手の変更が自分の変更に化け、次の同期でそのまま
 * 送り返される）。外している間の変更は呼び出し元が別に記録する。
 *
 * @module sync/triggers
 * @internal
 */
import Database from 'better-sqlite3'
import { TableConfig } from '../types'
import { NOW_SQL } from '../setup'
import { escapeIdentifier } from './sql'

/**
 * 対象テーブルのトリガーを無効化する。
 *
 * フルマージ中にchangelogが汚染されるのを防ぐため。
 *
 * @returns 無効化したトリガー名のリスト（再有効化用）
 * @internal
 */
export function disableTriggers(
  db: Database.Database,
  tables: TableConfig[]
): string[] {
  const triggers: string[] = []
  for (const tableConfig of tables) {
    const table = tableConfig.name
    const triggerNames = [
      `_changelog_after_insert_${table}`,
      `_changelog_after_update_${table}`,
      `_changelog_after_delete_${table}`,
    ]
    for (const name of triggerNames) {
      // トリガーが存在するか確認してからDROP
      const exists = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='trigger' AND name=?`
        )
        .get(name)
      if (exists) {
        db.exec(`DROP TRIGGER ${escapeIdentifier(name)}`)
        triggers.push(name)
      }
    }
  }
  return triggers
}

/**
 * 対象テーブルのトリガーを再作成する。
 *
 * @internal
 */
export function reEnableTriggers(
  db: Database.Database,
  tables: TableConfig[],
  primaryKey: string
): void {
  const escapedPk = escapeIdentifier(primaryKey)

  for (const tableConfig of tables) {
    const table = tableConfig.name
    const escapedTable = escapeIdentifier(table)

    db.exec(`
      CREATE TRIGGER IF NOT EXISTS _changelog_after_insert_${table}
      AFTER INSERT ON ${escapedTable} FOR EACH ROW
      BEGIN
        INSERT INTO _changelog (tableName, recordId, operation, changedAt)
        VALUES ('${table}', NEW.${escapedPk}, 'INSERT', ${NOW_SQL});
      END
    `)

    db.exec(`
      CREATE TRIGGER IF NOT EXISTS _changelog_after_update_${table}
      AFTER UPDATE ON ${escapedTable} FOR EACH ROW
      BEGIN
        INSERT INTO _changelog (tableName, recordId, operation, changedAt)
        VALUES ('${table}', NEW.${escapedPk}, 'UPDATE', ${NOW_SQL});
      END
    `)

    db.exec(`
      CREATE TRIGGER IF NOT EXISTS _changelog_after_delete_${table}
      AFTER DELETE ON ${escapedTable} FOR EACH ROW
      BEGIN
        INSERT INTO _changelog (tableName, recordId, operation, changedAt)
        VALUES ('${table}', OLD.${escapedPk}, 'DELETE', ${NOW_SQL});
        INSERT OR REPLACE INTO _tombstone (tableName, recordId, deletedAt)
        VALUES ('${table}', OLD.${escapedPk}, ${NOW_SQL});
      END
    `)
  }
}
