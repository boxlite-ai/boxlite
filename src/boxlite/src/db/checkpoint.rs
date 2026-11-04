//! Checkpoint catalog records deliberately have no source-box foreign key.

use super::{Database, db_err};
use crate::runtime::checkpoints::CheckpointInfo;
use crate::{BoxliteError, BoxliteResult};
use rusqlite::{OptionalExtension, params};

#[derive(Clone)]
pub(crate) struct CheckpointStore(pub(crate) Database);

impl CheckpointStore {
    pub(crate) fn list(&self, source: Option<&str>) -> BoxliteResult<Vec<CheckpointInfo>> {
        let conn = self.0.conn();
        let mut query = db_err!(conn.prepare("SELECT json FROM checkpoint WHERE (?1 IS NULL OR box_id=?1) ORDER BY created_at DESC, id"))?;
        let rows = db_err!(query.query_map(params![source], |row| row.get::<_, String>(0)))?;
        rows.map(|row| {
            serde_json::from_str(&db_err!(row)?).map_err(|e| BoxliteError::Database(e.to_string()))
        })
        .collect()
    }

    pub(crate) fn get(
        &self,
        source: Option<&str>,
        key: &str,
    ) -> BoxliteResult<Option<CheckpointInfo>> {
        let id = uuid::Uuid::parse_str(key).ok().map(|id| id.to_string());
        let conn = self.0.conn();
        let json: Option<String> = db_err!(conn.query_row(
            "SELECT json FROM checkpoint WHERE (?1 IS NULL OR box_id=?1) AND (id=?2 OR (name=?3 AND status!='deleting')) ORDER BY CASE WHEN id=?2 THEN 0 ELSE 1 END LIMIT 1",
            params![source, id, key], |row| row.get(0)).optional())?;
        json.map(|json| {
            serde_json::from_str(&json).map_err(|e| BoxliteError::Database(e.to_string()))
        })
        .transpose()
    }

    pub(crate) fn insert(&self, info: &CheckpointInfo) -> BoxliteResult<()> {
        let json =
            serde_json::to_string(info).map_err(|e| BoxliteError::Database(e.to_string()))?;
        self.0.conn().execute("INSERT INTO checkpoint(id,box_id,name,status,created_at,json) VALUES(?1,?2,?3,?4,?5,?6)",
            params![info.id, info.box_id, info.name, info.status, info.created_at, json]).map_err(|e| {
                if e.sqlite_error_code() == Some(rusqlite::ErrorCode::ConstraintViolation) {
                    BoxliteError::InvalidState(format!("checkpoint ID or name '{}' already exists", info.name))
                } else { BoxliteError::Database(e.to_string()) }
            })?;
        Ok(())
    }

    pub(crate) fn update(&self, info: &CheckpointInfo) -> BoxliteResult<()> {
        let json =
            serde_json::to_string(info).map_err(|e| BoxliteError::Database(e.to_string()))?;
        db_err!(self.0.conn().execute(
            "UPDATE checkpoint SET status=?2,json=?3 WHERE id=?1",
            params![info.id, info.status, json]
        ))?;
        Ok(())
    }

    pub(crate) fn remove(&self, id: &str) -> BoxliteResult<()> {
        db_err!(
            self.0
                .conn()
                .execute("DELETE FROM checkpoint WHERE id=?1", params![id])
        )?;
        Ok(())
    }
}
