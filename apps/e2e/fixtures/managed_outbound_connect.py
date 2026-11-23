"""Extract attempted IPv4 destinations from per-thread Linux strace files."""

from argparse import ArgumentParser
from ipaddress import IPv4Address, IPv6Address
import json
from pathlib import Path
import re


CONNECT = re.compile(r"(?P<seconds>[0-9]+)\.(?P<fraction>[0-9]{1,9})\s+connect\(")
FAMILY = re.compile(r"\bsa_family=(AF_[A-Z0-9_]+)")
IPV4 = re.compile(r'\bsin_port=htons\(([0-9]+)\).*?\bsin_addr=inet_addr\("([0-9.]+)"\)')
IPV6 = re.compile(r'\bsin6_port=htons\(([0-9]+)\).*?\binet_pton\(AF_INET6, "([0-9a-fA-F:.]+)"')
RESULT = re.compile(r"\s+= (?:-1 ([A-Z][A-Z0-9_]+)\b|(0)\b)")


def connect_records(lines, address, port, started_ns, completed_ns):
    records = []
    for line in lines:
        match = CONNECT.match(line)
        if match is None:
            continue
        timestamp = int(match["seconds"]) * 1_000_000_000 + int(match["fraction"].ljust(9, "0"))
        if not started_ns <= timestamp <= completed_ns:
            continue
        family = FAMILY.search(line)
        if family is None:
            raise ValueError("connect trace has an undecodable socket address")
        if family[1] not in ("AF_INET", "AF_INET6"):
            continue
        ipv4 = family[1] == "AF_INET"
        endpoint = (IPV4 if ipv4 else IPV6).search(line)
        if endpoint is None:
            raise ValueError("connect trace has an undecodable IP endpoint")
        destination = (IPv4Address if ipv4 else IPv6Address)(endpoint[2])
        normalized = destination if ipv4 else destination.ipv4_mapped
        if normalized != address or int(endpoint[1]) != port:
            continue
        result = RESULT.search(line)
        if result is None and "<unfinished ...>" not in line:
            raise ValueError("connect trace has an undecodable result")
        records.append({
            "time_ns": timestamp, "address": str(destination), "port": port,
            "family": "inet" if ipv4 else "inet6",
            "result": (result[1] or "ok") if result else "unfinished",
        })
    return records


def main():
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("--address", type=IPv4Address, required=True)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--started-ns", type=int, required=True)
    parser.add_argument("--completed-ns", type=int, required=True)
    parser.add_argument("trace", type=Path, nargs="+")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535 or not 0 < args.started_ns <= args.completed_ns:
        parser.error("invalid IPv4 target port or probe window")
    records = []
    try:
        for path in args.trace:
            with path.open() as lines:
                records.extend(connect_records(lines, args.address, args.port, args.started_ns, args.completed_ns))
    except (OSError, ValueError):
        parser.exit(1, "connect trace could not be read or decoded\n")
    print(json.dumps(sorted(records, key=lambda record: record["time_ns"])))


if __name__ == "__main__":
    main()
