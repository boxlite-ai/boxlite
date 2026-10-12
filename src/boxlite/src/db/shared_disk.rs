//! SQL for shared ext4 `image`, `image_disk`, and qcow2 `disk` rows.

use rusqlite::{OptionalExtension, params};

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use super::{Database, db_err};

pub(crate) fn image_key(db: &Database, image_ref: &str) -> BoxliteResult<Option<String>> {
    let conn = db.conn();
    Ok(db_err!(
        conn.query_row(
            "SELECT disk_key FROM image WHERE ref = ?1",
            params![image_ref],
            |row| row.get(0),
        )
        .optional()
    )?)
}

pub(crate) fn image_disk(
    db: &Database,
    disk_key: &str,
) -> BoxliteResult<Option<(String, String, String)>> {
    let conn = db.conn();
    Ok(db_err!(
        conn.query_row(
            "SELECT path, state, config FROM image_disk WHERE disk_key = ?1",
            params![disk_key],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
    )?)
}

pub(crate) fn image_refs_for_disk(db: &Database, disk_key: &str) -> BoxliteResult<Vec<String>> {
    let conn = db.conn();
    let mut stmt = db_err!(conn.prepare("SELECT ref FROM image WHERE disk_key = ?1 ORDER BY ref"))?;
    let rows = db_err!(stmt.query_map(params![disk_key], |row| row.get(0)))?;
    let mut refs = Vec::new();
    for row in rows {
        refs.push(db_err!(row)?);
    }
    Ok(refs)
}

#[allow(dead_code)] // direct ready insert used by the install test; builds use mark_ready
pub(crate) fn publish_ready(
    db: &Database,
    image_ref: &str,
    disk_key: &str,
    path: &str,
    config_json: &str,
) -> BoxliteResult<()> {
    let mut conn = db.conn();
    let tx = db_err!(conn.transaction())?;
    db_err!(tx.execute(
        "INSERT INTO image_disk (disk_key, path, state, config) VALUES (?1, ?2, 'ready', ?3)
         ON CONFLICT(disk_key) DO UPDATE SET
            path = excluded.path, state = excluded.state, config = excluded.config",
        params![disk_key, path, config_json],
    ))?;
    write_image(&tx, image_ref, disk_key)?;
    db_err!(tx.commit())?;
    Ok(())
}

/// Insert `image_disk` as `building` and the image row in one transaction.
///
/// Returns true when this caller inserted the disk row. An image row that
/// already points at `disk_key` is left in place.
pub(crate) fn begin_build(
    db: &Database,
    image_ref: &str,
    disk_key: &str,
    path: &str,
    config_json: &str,
) -> BoxliteResult<bool> {
    let mut conn = db.conn();
    let tx = db_err!(conn.transaction())?;
    let inserted = db_err!(tx.execute(
        "INSERT INTO image_disk (disk_key, path, state, config)
         SELECT ?1, ?2, 'building', ?3
         WHERE NOT EXISTS (SELECT 1 FROM image_disk WHERE disk_key = ?1)",
        params![disk_key, path, config_json],
    ))?;
    write_image(&tx, image_ref, disk_key)?;
    db_err!(tx.commit())?;
    Ok(inserted == 1)
}

/// Mark a `building` row ready. A missing or non-building row is left unchanged.
pub(crate) fn mark_ready(db: &Database, disk_key: &str, path: &str) -> BoxliteResult<bool> {
    let conn = db.conn();
    let changed = db_err!(conn.execute(
        "UPDATE image_disk SET state = 'ready', path = ?2
         WHERE disk_key = ?1 AND state = 'building'",
        params![disk_key, path],
    ))?;
    Ok(changed == 1)
}

pub(crate) fn ensure_image(db: &Database, image_ref: &str, disk_key: &str) -> BoxliteResult<()> {
    if let Some((_, state, _)) = image_disk(db, disk_key)?
        && state == "deleting"
    {
        return Err(BoxliteError::InvalidState(format!(
            "operation conflict: image disk {disk_key} is being deleted"
        )));
    }
    let conn = db.conn();
    write_image(&conn, image_ref, disk_key)
}

fn write_image(conn: &rusqlite::Connection, image_ref: &str, disk_key: &str) -> BoxliteResult<()> {
    db_err!(conn.execute(
        "INSERT INTO image (ref, disk_key) VALUES (?1, ?2)
         ON CONFLICT(ref) DO UPDATE SET disk_key = excluded.disk_key
         WHERE image.disk_key != excluded.disk_key",
        params![image_ref, disk_key],
    ))?;
    Ok(())
}

pub(crate) fn clear_image_disk(db: &Database, disk_key: &str) -> BoxliteResult<()> {
    let conn = db.conn();
    db_err!(conn.execute(
        "DELETE FROM image_disk WHERE disk_key = ?1",
        params![disk_key],
    ))?;
    Ok(())
}

pub(crate) fn delete_image_row(db: &Database, image_ref: &str) -> BoxliteResult<bool> {
    let conn = db.conn();
    let changed = db_err!(conn.execute("DELETE FROM image WHERE ref = ?1", params![image_ref]))?;
    Ok(changed == 1)
}

pub(crate) fn any_disk_root(db: &Database, disk_key: &str) -> BoxliteResult<bool> {
    let conn = db.conn();
    let found: Option<i64> = db_err!(
        conn.query_row(
            "SELECT 1 FROM disk WHERE root = ?1 LIMIT 1",
            params![disk_key],
            |row| row.get(0),
        )
        .optional()
    )?;
    Ok(found.is_some())
}

pub(crate) fn disk_row(db: &Database, id: &str) -> BoxliteResult<Option<(String, String)>> {
    let conn = db.conn();
    Ok(db_err!(
        conn.query_row(
            "SELECT root, parent FROM disk WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
    )?)
}

/// Insert a qcow2 row only while `image_disk` for `root` is still `ready`.
/// Zero rows means the caller must not write a qcow2 and must not leave a disk row.
pub(crate) fn commit_disk(
    db: &Database,
    id: &str,
    root: &str,
    parent: &str,
) -> BoxliteResult<bool> {
    let conn = db.conn();
    let inserted = db_err!(conn.execute(
        "INSERT INTO disk (id, root, parent)
         SELECT ?1, ?2, ?3
         FROM image_disk
         WHERE disk_key = ?2 AND state = 'ready'",
        params![id, root, parent],
    ))?;
    Ok(inserted == 1)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ForkCommit {
    /// The container has no `disk` row yet.
    NoDiskRow,
    /// `image_disk` was not `ready`, so no snapshot row was written.
    NotReady,
    Committed {
        previous_parent: String,
    },
}

/// Record a snapshot or clone-base qcow2 before the file is written.
///
/// The new row's parent is the container's parent at this moment. The container
/// row's parent becomes `new_id`. Both roots stay the ext4 key. The insert
/// itself requires `image_disk.state = 'ready'`.
pub(crate) fn commit_fork(
    db: &Database,
    container_id: &str,
    new_id: &str,
) -> BoxliteResult<ForkCommit> {
    let mut conn = db.conn();
    let tx = db_err!(conn.transaction())?;
    let current: Option<(String, String)> = db_err!(
        tx.query_row(
            "SELECT root, parent FROM disk WHERE id = ?1",
            params![container_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
    )?;
    let Some((root, previous_parent)) = current else {
        db_err!(tx.commit())?;
        return Ok(ForkCommit::NoDiskRow);
    };
    let inserted = db_err!(tx.execute(
        "INSERT INTO disk (id, root, parent)
         SELECT ?1, ?2, ?3
         FROM image_disk
         WHERE disk_key = ?2 AND state = 'ready'",
        params![new_id, root, previous_parent],
    ))?;
    if inserted != 1 {
        db_err!(tx.rollback())?;
        return Ok(ForkCommit::NotReady);
    }
    db_err!(tx.execute(
        "UPDATE disk SET parent = ?1 WHERE id = ?2",
        params![new_id, container_id],
    ))?;
    db_err!(tx.commit())?;
    Ok(ForkCommit::Committed { previous_parent })
}

/// Put the container parent back, then drop the snapshot row if nothing points at it.
pub(crate) fn abort_fork(
    db: &Database,
    container_id: &str,
    new_id: &str,
    previous_parent: &str,
) -> BoxliteResult<()> {
    let mut conn = db.conn();
    let tx = db_err!(conn.transaction())?;
    db_err!(tx.execute(
        "UPDATE disk SET parent = ?1 WHERE id = ?2",
        params![previous_parent, container_id],
    ))?;
    delete_disk_in(&tx, new_id)?;
    db_err!(tx.commit())?;
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DiskDelete {
    Removed,
    Absent,
    Blocked,
}

pub(crate) fn delete_disk_if_free(db: &Database, id: &str) -> BoxliteResult<DiskDelete> {
    let conn = db.conn();
    delete_disk_in(&conn, id)
}

fn delete_disk_in(conn: &rusqlite::Connection, id: &str) -> BoxliteResult<DiskDelete> {
    let blocked: i64 = db_err!(conn.query_row(
        "SELECT COUNT(*) FROM disk WHERE parent = ?1",
        params![id],
        |row| row.get(0),
    ))?;
    if blocked > 0 {
        return Ok(DiskDelete::Blocked);
    }
    let changed = db_err!(conn.execute("DELETE FROM disk WHERE id = ?1", params![id]))?;
    if changed == 1 {
        Ok(DiskDelete::Removed)
    } else {
        Ok(DiskDelete::Absent)
    }
}

/// `ready` → `deleting` only when no `disk.root` points here and this is the last name.
pub(crate) fn claim_deleting_last_name(
    db: &Database,
    image_ref: &str,
    disk_key: &str,
) -> BoxliteResult<bool> {
    let conn = db.conn();
    let changed = db_err!(conn.execute(
        "UPDATE image_disk SET state = 'deleting'
         WHERE disk_key = ?1
           AND state = 'ready'
           AND NOT EXISTS (SELECT 1 FROM disk WHERE root = ?1)
           AND (SELECT COUNT(*) FROM image WHERE disk_key = ?1) = 1
           AND EXISTS (SELECT 1 FROM image WHERE ref = ?2 AND disk_key = ?1)",
        params![disk_key, image_ref],
    ))?;
    Ok(changed == 1)
}

/// `ready` → `deleting` only when no image name and no `disk.root` point here.
pub(crate) fn claim_unused(db: &Database, disk_key: &str) -> BoxliteResult<bool> {
    let conn = db.conn();
    let changed = db_err!(conn.execute(
        "UPDATE image_disk SET state = 'deleting'
         WHERE disk_key = ?1
           AND state = 'ready'
           AND NOT EXISTS (SELECT 1 FROM image WHERE disk_key = ?1)
           AND NOT EXISTS (SELECT 1 FROM disk WHERE root = ?1)",
        params![disk_key],
    ))?;
    Ok(changed == 1)
}

pub(crate) fn deleting_orphan(db: &Database, disk_key: &str) -> BoxliteResult<Option<String>> {
    let conn = db.conn();
    Ok(db_err!(
        conn.query_row(
            "SELECT path FROM image_disk
             WHERE disk_key = ?1
               AND state = 'deleting'
               AND NOT EXISTS (SELECT 1 FROM image WHERE disk_key = ?1)
               AND NOT EXISTS (SELECT 1 FROM disk WHERE root = ?1)",
            params![disk_key],
            |row| row.get(0),
        )
        .optional()
    )?)
}

pub(crate) fn ready_unreferenced(db: &Database) -> BoxliteResult<Vec<String>> {
    let conn = db.conn();
    let mut stmt = db_err!(conn.prepare(
        "SELECT disk_key FROM image_disk
         WHERE state = 'ready'
           AND NOT EXISTS (SELECT 1 FROM image WHERE image.disk_key = image_disk.disk_key)
           AND NOT EXISTS (SELECT 1 FROM disk WHERE disk.root = image_disk.disk_key)
         ORDER BY disk_key"
    ))?;
    let rows = db_err!(stmt.query_map([], |row| row.get(0)))?;
    let mut keys = Vec::new();
    for row in rows {
        keys.push(db_err!(row)?);
    }
    Ok(keys)
}

pub(crate) fn deleting_unreferenced(db: &Database) -> BoxliteResult<Vec<String>> {
    let conn = db.conn();
    let mut stmt = db_err!(conn.prepare(
        "SELECT disk_key FROM image_disk
         WHERE state = 'deleting'
           AND NOT EXISTS (SELECT 1 FROM image WHERE image.disk_key = image_disk.disk_key)
           AND NOT EXISTS (SELECT 1 FROM disk WHERE disk.root = image_disk.disk_key)
         ORDER BY disk_key"
    ))?;
    let rows = db_err!(stmt.query_map([], |row| row.get(0)))?;
    let mut keys = Vec::new();
    for row in rows {
        keys.push(db_err!(row)?);
    }
    Ok(keys)
}

pub(crate) fn child_blocks(db: &Database, id: &str) -> BoxliteResult<bool> {
    let conn = db.conn();
    let blocked: i64 = db_err!(conn.query_row(
        "SELECT COUNT(*) FROM disk WHERE parent = ?1",
        params![id],
        |row| row.get(0),
    ))?;
    Ok(blocked > 0)
}

pub(crate) fn blocked_disk(id: &str) -> BoxliteError {
    BoxliteError::InvalidState(format!(
        "refusing to delete disk row {id}: a disk.parent still points at it"
    ))
}
