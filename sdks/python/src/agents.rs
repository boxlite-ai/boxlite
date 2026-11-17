use boxlite::{
    Agent, AgentTurn, Agents,
    agents::{
        AgentControlOptions, AgentCreateOptions, AgentEventStream, AgentEventsOptions,
        AgentSendMode, AgentSendOptions, AgentWaitOptions, records,
    },
};
use futures::StreamExt;
use pyo3::prelude::*;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::util::map_err;

#[cfg(test)]
#[path = "agents/tests/forwarding.rs"]
mod forwarding_tests;

#[pyclass]
pub(crate) struct PyAgents {
    agents: Agents,
}

impl PyAgents {
    pub(crate) fn new(agents: Agents) -> Self {
        Self { agents }
    }
}

#[pyclass]
struct PyAgent {
    agent: Agent,
}

#[pyclass]
struct PyAgentTurn {
    turn: AgentTurn,
}

#[pyclass]
struct PyAgentEventStream {
    stream: Arc<Mutex<Option<AgentEventStream>>>,
}

#[pymethods]
impl PyAgentEventStream {
    fn next<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        let stream = Arc::clone(&self.stream);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let mut guard = stream.lock().await;
            let Some(stream) = guard.as_mut() else {
                return Ok(None);
            };
            match stream.next().await {
                Some(Ok(event)) => Ok(Some(records::event(&event).to_string())),
                Some(Err(error)) => {
                    *guard = None;
                    Err(map_err(error))
                }
                None => {
                    *guard = None;
                    Ok(None)
                }
            }
        })
    }
    fn close<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        let stream = Arc::clone(&self.stream);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            *stream.lock().await = None;
            Ok(())
        })
    }
}

fn control(idempotency_key: Option<String>) -> AgentControlOptions {
    AgentControlOptions { idempotency_key }
}

fn json(value: &str) -> PyResult<serde_json::Value> {
    serde_json::from_str(value)
        .map_err(|error| map_err(boxlite::BoxliteError::InvalidArgument(error.to_string())))
}

#[pymethods]
impl PyAgents {
    fn create<'py>(
        &self,
        py: Python<'py>,
        name: String,
        cwd: Option<String>,
        config: String,
        idempotency_key: Option<String>,
    ) -> PyResult<Bound<'py, PyAny>> {
        let value = json(&config)?;
        let config = records::parse_config(value).map_err(map_err)?;
        let agents = self.agents.clone();
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let options = AgentCreateOptions {
                cwd,
                config,
                idempotency_key,
            };
            let agent = agents.create(&name, options).await.map_err(map_err)?;
            Ok(PyAgent { agent })
        })
    }

    fn get<'py>(&self, py: Python<'py>, agent_id: String) -> PyResult<Bound<'py, PyAny>> {
        let agents = self.agents.clone();
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let agent = agents.get(&agent_id).await.map_err(map_err)?;
            Ok(PyAgent { agent })
        })
    }
}

#[pymethods]
impl PyAgent {
    fn events<'py>(&self, py: Python<'py>, after: Option<String>) -> PyResult<Bound<'py, PyAny>> {
        let agent = self.agent.clone();
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let stream = agent
                .events(AgentEventsOptions { after })
                .await
                .map_err(map_err)?;
            Ok(PyAgentEventStream {
                stream: Arc::new(Mutex::new(Some(stream))),
            })
        })
    }
    fn close<'py>(&self, py: Python<'py>, key: Option<String>) -> PyResult<Bound<'py, PyAny>> {
        let agent = self.agent.clone();
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            agent.close(control(key)).await.map_err(map_err)
        })
    }

    fn send<'py>(
        &self,
        py: Python<'py>,
        text: String,
        mode: String,
        data: String,
        key: Option<String>,
    ) -> PyResult<Bound<'py, PyAny>> {
        let mode = match mode.as_str() {
            "queue" => AgentSendMode::Queue,
            "reject" => AgentSendMode::Reject,
            _ => {
                return Err(map_err(boxlite::BoxliteError::InvalidArgument(format!(
                    "unknown send mode: {mode}"
                ))));
            }
        };
        let data = json(&data)?;
        let agent = self.agent.clone();
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let turn = agent
                .send(
                    &text,
                    AgentSendOptions {
                        mode,
                        data: if data.is_null() { None } else { Some(data) },
                        idempotency_key: key,
                    },
                )
                .await
                .map_err(map_err)?;
            Ok(PyAgentTurn { turn })
        })
    }

    fn get_turn<'py>(&self, py: Python<'py>, id: String) -> PyResult<Bound<'py, PyAny>> {
        let agent = self.agent.clone();
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            Ok(PyAgentTurn {
                turn: agent.get_turn(&id).await.map_err(map_err)?,
            })
        })
    }

    fn requests<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        let agent = self.agent.clone();
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            Ok(records::requests(&agent.requests().await.map_err(map_err)?).to_string())
        })
    }

    fn respond<'py>(
        &self,
        py: Python<'py>,
        id: String,
        response: String,
        key: Option<String>,
    ) -> PyResult<Bound<'py, PyAny>> {
        let response = records::parse_response(json(&response)?).map_err(map_err)?;
        let agent = self.agent.clone();
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            Ok(PyAgentTurn {
                turn: agent
                    .respond(&id, response, control(key))
                    .await
                    .map_err(map_err)?,
            })
        })
    }

    #[getter]
    fn state(&self) -> PyResult<String> {
        Ok(records::agent_state(&self.agent.state().map_err(map_err)?).to_string())
    }
    #[getter]
    fn config(&self) -> PyResult<String> {
        Ok(records::config(&self.agent.config().map_err(map_err)?).to_string())
    }
    #[getter]
    fn capabilities(&self) -> PyResult<String> {
        Ok(records::capabilities(&self.agent.capabilities().map_err(map_err)?).to_string())
    }
}

#[pymethods]
impl PyAgentTurn {
    fn events<'py>(&self, py: Python<'py>, after: Option<String>) -> PyResult<Bound<'py, PyAny>> {
        let turn = self.turn.clone();
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let stream = turn
                .events(AgentEventsOptions { after })
                .await
                .map_err(map_err)?;
            Ok(PyAgentEventStream {
                stream: Arc::new(Mutex::new(Some(stream))),
            })
        })
    }
    fn wait<'py>(&self, py: Python<'py>, timeout: Option<f64>) -> PyResult<Bound<'py, PyAny>> {
        let timeout = timeout
            .map(|seconds| {
                std::time::Duration::try_from_secs_f64(seconds).map_err(|_| {
                    map_err(boxlite::BoxliteError::InvalidArgument(
                        "timeout must be a non-negative finite representable number".into(),
                    ))
                })
            })
            .transpose()?;
        let turn = self.turn.clone();
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            Ok(records::result(
                &turn
                    .wait(AgentWaitOptions { timeout })
                    .await
                    .map_err(map_err)?,
            )
            .to_string())
        })
    }
    fn steer<'py>(
        &self,
        py: Python<'py>,
        text: String,
        key: Option<String>,
    ) -> PyResult<Bound<'py, PyAny>> {
        let turn = self.turn.clone();
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            Ok(
                records::receipt(&turn.steer(&text, control(key)).await.map_err(map_err)?)
                    .to_string(),
            )
        })
    }
    fn interrupt<'py>(&self, py: Python<'py>, key: Option<String>) -> PyResult<Bound<'py, PyAny>> {
        let turn = self.turn.clone();
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            turn.interrupt(control(key)).await.map_err(map_err)
        })
    }
    #[getter]
    fn state(&self) -> PyResult<String> {
        Ok(records::turn_state(&self.turn.state().map_err(map_err)?).to_string())
    }
}
