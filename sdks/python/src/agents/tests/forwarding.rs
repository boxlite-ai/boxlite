use super::*;
use pyo3::types::PyDict;
use std::ffi::CString;

#[test]
fn python_agent_bindings_forward_to_core_test_backend() {
    let home = std::env::temp_dir().join(format!("boxlite-python-agent-{}", std::process::id()));
    let runtime = boxlite::BoxliteRuntime::new_for_test(boxlite::BoxliteOptions {
        home_dir: home.clone(),
        ..Default::default()
    })
    .unwrap();
    let sandbox = pyo3_async_runtimes::tokio::get_runtime()
        .block_on(runtime.create(
            boxlite::BoxOptions {
                rootfs: boxlite::RootfsSpec::Image("alpine:latest".into()),
                ..Default::default()
            },
            None,
        ))
        .unwrap();
    Python::attach(|py| {
        py.import("sys")
            .unwrap()
            .getattr("path")
            .unwrap()
            .call_method1("insert", (0, env!("CARGO_MANIFEST_DIR")))
            .unwrap();
        py.import("boxlite.errors").unwrap();
        let globals = PyDict::new(py);
        let agents = Bound::new(py, PyAgents::new(sandbox.agents().with_test_backend())).unwrap();
        globals.set_item("agents", agents).unwrap();
        let script = CString::new(
            r#"
import asyncio, json
from boxlite.errors import InvalidArgumentError, UnsupportedError, NetworkError

async def main():
    agent = await agents.create('test', None, '{"model":"m"}', None)
    assert json.loads(agent.state)['id'] == 'agent-1'
    assert json.loads(agent.config)['tools'] == []
    assert json.loads(agent.capabilities)['operations'] == ['agent.send']
    other = await agents.get('agent-1')
    assert json.loads(other.state)['id'] == 'agent-1'
    turn = await agent.send('hello', 'reject', 'null', None)
    assert json.loads(turn.state)['id'] == 'turn-1'
    assert json.loads(await turn.wait(1))['text'] == 'hello'
    assert json.loads((await agent.get_turn('turn-1')).state)['id'] == 'turn-1'
    assert json.loads(await agent.requests())[0]['id'] == 'request-1'
    reply = await agent.respond('request-1', '{"type":"answer","text":"yes"}', None)
    assert json.loads(await reply.wait(None))['text'] == 'yes'
    for operation, error in (
        (lambda: agent.send('bad', 'bad', 'null', None), InvalidArgumentError),
        (lambda: agent.send('bad', 'queue', '{', None), InvalidArgumentError),
        (lambda: turn.wait(-1), InvalidArgumentError),
        (lambda: agent.respond('request-1', '{"type":"bad"}', None), InvalidArgumentError),
        (lambda: turn.steer('x', None), UnsupportedError),
        (lambda: turn.interrupt(None), UnsupportedError),
        (lambda: agent.close(None), UnsupportedError),
    ):
        try:
            await operation()
        except error:
            pass
        else:
            raise AssertionError('expected an error')
    stream = await agent.events('events')
    assert json.loads(await stream.next())['kind'] == 'first'
    assert json.loads(await stream.next())['kind'] == 'second'
    await stream.close()
    assert await stream.next() is None
    try:
        await agent.events('open-error')
    except NetworkError:
        pass
    else:
        raise AssertionError('expected open failure')
    failed = await agent.events('read-error')
    assert json.loads(await failed.next())['kind'] == 'first'
    try:
        await failed.next()
    except NetworkError:
        pass
    else:
        raise AssertionError('expected read failure')
    assert await failed.next() is None
    empty = await turn.events(None)
    assert await empty.next() is None
    await empty.close()

asyncio.run(main())
"#,
        )
        .unwrap();
        py.run(&script, Some(&globals), None).unwrap();
    });
    drop(runtime);
    let _ = std::fs::remove_dir_all(home);
}
