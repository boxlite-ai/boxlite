use crate::util::map_err;
use pyo3::prelude::*;

#[pyclass(name = "SshCaConfig", get_all)]
#[derive(Clone)]
pub(crate) struct PySshCaConfig {
    pub public_key: String,
    pub principal: String,
}
#[pymethods]
impl PySshCaConfig {
    #[new]
    fn new(public_key: String, principal: String) -> Self {
        Self {
            public_key,
            principal,
        }
    }
    fn __repr__(&self) -> String {
        format!("{:?}", boxlite::SshCaConfig::from(self.clone()))
    }
}
impl From<PySshCaConfig> for boxlite::SshCaConfig {
    fn from(value: PySshCaConfig) -> Self {
        Self {
            public_key: value.public_key,
            principal: value.principal,
        }
    }
}
#[pyclass(name = "SshAccount", get_all)]
#[derive(Clone)]
pub(crate) struct PySshAccount {
    pub login: String,
    pub authorized_keys: Vec<String>,
    pub ca: Option<PySshCaConfig>,
}
#[pymethods]
impl PySshAccount {
    #[new]
    #[pyo3(signature = (login, authorized_keys, ca=None))]
    fn new(login: String, authorized_keys: Vec<String>, ca: Option<PySshCaConfig>) -> Self {
        Self {
            login,
            authorized_keys,
            ca,
        }
    }
    fn __repr__(&self) -> String {
        format!("{:?}", boxlite::SshAccount::from(self.clone()))
    }
}
impl From<PySshAccount> for boxlite::SshAccount {
    fn from(value: PySshAccount) -> Self {
        Self {
            login: value.login,
            authorized_keys: value.authorized_keys,
            ca: value.ca.map(Into::into),
        }
    }
}
#[pyclass(name = "SshConfig", get_all)]
#[derive(Clone)]
pub(crate) struct PySshConfig {
    pub listen_address: String,
    pub host_private_key: String,
    pub accounts: Vec<PySshAccount>,
}
#[pymethods]
impl PySshConfig {
    #[new]
    fn new(listen_address: String, host_private_key: String, accounts: Vec<PySshAccount>) -> Self {
        Self {
            listen_address,
            host_private_key,
            accounts,
        }
    }
    fn __repr__(&self) -> String {
        format!("{:?}", boxlite::SshConfig::from(self.clone()))
    }
}
impl From<PySshConfig> for boxlite::SshConfig {
    fn from(value: PySshConfig) -> Self {
        Self {
            listen_address: value.listen_address,
            host_private_key: value.host_private_key,
            accounts: value.accounts.into_iter().map(Into::into).collect(),
        }
    }
}
#[pyclass(name = "SshStatus", get_all)]
#[derive(Clone)]
pub(crate) struct PySshStatus {
    pub enabled: bool,
    pub generation: u64,
    pub listen_address: String,
    pub host_public_key: String,
    pub host_key_fingerprint: String,
}
impl From<boxlite::SshStatus> for PySshStatus {
    fn from(value: boxlite::SshStatus) -> Self {
        Self {
            enabled: value.enabled,
            generation: value.generation,
            listen_address: value.listen_address,
            host_public_key: value.host_public_key,
            host_key_fingerprint: value.host_key_fingerprint,
        }
    }
}
#[pyclass(name = "SshHandle")]
pub(crate) struct PySshHandle {
    pub(crate) handle: boxlite::SshHandle,
}
#[pymethods]
impl PySshHandle {
    fn configure<'py>(&self, py: Python<'py>, config: PySshConfig) -> PyResult<Bound<'py, PyAny>> {
        let handle = self.handle.clone();
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            handle
                .configure(config.into())
                .await
                .map(PySshStatus::from)
                .map_err(map_err)
        })
    }
    fn status<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        let handle = self.handle.clone();
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            handle
                .status()
                .await
                .map(PySshStatus::from)
                .map_err(map_err)
        })
    }
    fn disable<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        let handle = self.handle.clone();
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            handle
                .disable()
                .await
                .map(PySshStatus::from)
                .map_err(map_err)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ssh_binding_conversion_and_redaction() {
        let config = PySshConfig::new(
            "addr".into(),
            "sentinel-private".into(),
            vec![PySshAccount::new(
                "alice".into(),
                vec!["sentinel-key".into()],
                Some(PySshCaConfig::new("sentinel-ca".into(), "principal".into())),
            )],
        );
        assert!(!config.__repr__().contains("sentinel"));
        let native: boxlite::SshConfig = config.into();
        assert_eq!(
            native.accounts[0].ca.as_ref().unwrap().public_key,
            "sentinel-ca"
        );
        let status = PySshStatus::from(boxlite::SshStatus {
            enabled: true,
            generation: u64::MAX,
            listen_address: "addr".into(),
            host_public_key: "key".into(),
            host_key_fingerprint: "fp".into(),
        });
        assert_eq!(status.generation, u64::MAX);
    }
    #[test]
    fn ssh_python_getters_and_awaitables_cross_rest_boundary() {
        use pyo3::types::PyDict;
        let executor = tokio::runtime::Runtime::new().unwrap();
        let server = executor.block_on(boxlite_test_utils::ssh_rest::SshRestServer::start());
        let runtime =
            boxlite::runtime::BoxliteRuntime::rest(boxlite::BoxliteRestOptions::new(&server.url))
                .unwrap();
        let sandbox = executor.block_on(runtime.get("ssh-test")).unwrap().unwrap();
        Python::attach(|py| {
            let globals = PyDict::new(py);
            globals
                .set_item(
                    "box",
                    Py::new(
                        py,
                        crate::box_handle::PyBox {
                            handle: std::sync::Arc::new(sandbox),
                        },
                    )
                    .unwrap(),
                )
                .unwrap();
            globals
                .set_item("SshConfig", py.get_type::<PySshConfig>())
                .unwrap();
            globals
                .set_item("SshAccount", py.get_type::<PySshAccount>())
                .unwrap();
            globals
                .set_item("SshCaConfig", py.get_type::<PySshCaConfig>())
                .unwrap();
            py.run(
                c"
import asyncio
ssh = box.ssh
del box
ca = SshCaConfig('sentinel-ca', 'alice')
account = SshAccount('alice', ['sentinel-key'], ca)
config = SshConfig('addr', 'sentinel-private', [account])
assert ca.public_key == 'sentinel-ca' and ca.principal == 'alice'
assert account.login == 'alice' and account.authorized_keys == ['sentinel-key']
assert account.ca.public_key == 'sentinel-ca'
assert config.listen_address == 'addr' and config.host_private_key == 'sentinel-private'
assert config.accounts[0].login == 'alice'
for value in (ca, account, config):
    assert 'sentinel' not in repr(value)
async def success():
    configured = await ssh.configure(config)
    status = await ssh.status()
    disabled = await ssh.disable()
    for value in (configured, status, disabled):
        assert value.generation == 18446744073709551615
        assert value.listen_address == 'addr'
        assert value.host_public_key == 'public'
        assert value.host_key_fingerprint == 'fp'
    assert configured.enabled and status.enabled and not disabled.enabled
asyncio.run(success())
",
                Some(&globals),
                None,
            )
            .unwrap();
            server.fail();
            py.run(
                c"
async def failure():
    for call in (lambda: ssh.configure(config), ssh.status, ssh.disable):
        try:
            await call()
        except RuntimeError as error:
            assert 'SSH request failed' in str(error)
            assert 'sentinel' not in str(error)
        else:
            raise AssertionError('REST error was swallowed')
asyncio.run(failure())
",
                Some(&globals),
                None,
            )
            .unwrap();
        });
        let requests = server.requests();
        assert_eq!(
            requests[1].1["accounts"][0]["ca"]["public_key"],
            "sentinel-ca"
        );
        assert_eq!(requests[1].1["host_private_key"], "sentinel-private");
    }
}
