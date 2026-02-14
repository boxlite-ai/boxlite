#![allow(unsafe_op_in_unsafe_fn, non_local_definitions)]

mod advanced_options;
mod box_handle;
mod exec;
mod info;
mod metrics;
mod options;
mod runtime;
mod util;

use crate::advanced_options::{PyAdvancedBoxOptions, PySecurityOptions};
use crate::box_handle::PyBox;
use crate::exec::{PyExecStderr, PyExecStdin, PyExecStdout, PyExecution};
use crate::info::{PyBoxInfo, PyBoxStateInfo};
use crate::metrics::{PyBoxMetrics, PyRuntimeMetrics};
use crate::options::{PyBoxOptions, PyBoxliteRestOptions, PyCopyOptions, PyOptions};
use crate::runtime::PyBoxlite;
use pyo3::prelude::*;

#[pymodule(name = "boxlite")]
fn boxlite_python(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_class::<PyOptions>()?;
    m.add_class::<PyBoxOptions>()?;
    m.add_class::<PySecurityOptions>()?;
    m.add_class::<PyAdvancedBoxOptions>()?;
    m.add_class::<PyBoxlite>()?;
    m.add_class::<PyBox>()?;
    m.add_class::<PyExecution>()?;
    m.add_class::<PyExecStdin>()?;
    m.add_class::<PyExecStdout>()?;
    m.add_class::<PyExecStderr>()?;
    m.add_class::<PyBoxInfo>()?;
    m.add_class::<PyBoxStateInfo>()?;
    m.add_class::<PyRuntimeMetrics>()?;
    m.add_class::<PyBoxMetrics>()?;
    m.add_class::<PyCopyOptions>()?;
    m.add_class::<PyBoxliteRestOptions>()?;

    Ok(())
}
