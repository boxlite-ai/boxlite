use boxlite::SnapshotRecord;
use pyo3::prelude::*;

#[pyclass(name = "SnapshotRecord")]
pub(crate) struct PySnapshotRecord {
    #[pyo3(get)]
    pub id: String,
    #[pyo3(get)]
    pub box_id: String,
    #[pyo3(get)]
    pub name: String,
    #[pyo3(get)]
    pub description: String,
    #[pyo3(get)]
    pub created_at: String,
}

#[pymethods]
impl PySnapshotRecord {
    fn __repr__(&self) -> String {
        format!(
            "SnapshotRecord(name='{}', box_id='{}', created_at='{}')",
            self.name, self.box_id, self.created_at
        )
    }
}

impl From<SnapshotRecord> for PySnapshotRecord {
    fn from(r: SnapshotRecord) -> Self {
        Self {
            id: r.id,
            box_id: r.box_id,
            name: r.name,
            description: r.description,
            created_at: r.created_at,
        }
    }
}
