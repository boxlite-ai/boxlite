"""Unit tests for lsof -F parsing in doctor.check_port_free."""

from boxlite_local.doctor import _parse_lsof_F, _LsofRow


def test_parse_empty_output_returns_no_rows():
    assert _parse_lsof_F("") == []


def test_parse_single_listener():
    out = "p723\ncpostgres\nLlilongen\nn127.0.0.1:5432\n"
    assert _parse_lsof_F(out) == [
        _LsofRow(pid=723, cmd="postgres", user="lilongen", name="127.0.0.1:5432"),
    ]


def test_parse_multiple_listeners():
    out = (
        "p723\ncpostgres\nLlilongen\nn127.0.0.1:5432\n"
        "p29538\ncboxlite-s\nLlilongen\nn*:5432\n"
    )
    rows = _parse_lsof_F(out)
    assert len(rows) == 2
    assert rows[0].cmd == "postgres"
    assert rows[0].pid == 723
    assert rows[1].cmd == "boxlite-s"
    assert rows[1].pid == 29538


def test_boxlite_listener_is_acceptable():
    """boxlite-s / boxlite-serve / boxlited prefix must NOT count as a conflict."""
    from boxlite_local.doctor import _is_boxlite_owner

    assert _is_boxlite_owner("boxlite-s") is True
    assert _is_boxlite_owner("boxlite-serve") is True
    assert _is_boxlite_owner("boxlited") is True
    assert _is_boxlite_owner("postgres") is False
    assert _is_boxlite_owner("redis-server") is False
    assert _is_boxlite_owner("") is False
