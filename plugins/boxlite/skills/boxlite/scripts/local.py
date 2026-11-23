#!/usr/bin/env python3
"""Run the selected local BoxLite runtime without inherited cloud routing."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

COMMANDS = {'create', 'run', 'start', 'stop', 'restart', 'rm', 'list', 'inspect',
            'exec', 'cp', 'top', 'attach', 'kill', 'signal', 'pull', 'images', 'info', 'logs'}
ROUTING = {'--home', '--profile', '--context', '--url', '--path-prefix', '--config'}
ENVIRONMENT = {'BOXLITE_HOME', 'BOXLITE_PROFILE', 'BOXLITE_CONTEXT',
               'BOXLITE_REST_URL', 'BOXLITE_REST_PATH_PREFIX', 'BOXLITE_API_KEY'}


def run(config_path, arguments, **options):
    """Validate the selected backend before starting a child; never authenticate."""
    try:
        config = json.loads(Path(config_path).read_text())
    except (OSError, ValueError):
        raise ValueError('Cannot read the private local-mode configuration') from None
    if not isinstance(config, dict) or set(config) - {'mode', 'home', 'cli'}:
        raise ValueError('Local configuration accepts only mode, home, and cli')
    if config.get('mode') != 'local':
        raise ValueError('Cloud modes use host MCP tools; this launcher is local-only')
    home = config.get('home')
    cli = config.get('cli', 'boxlite')
    if not isinstance(home, str) or not Path(home).is_absolute() or '\0' in home:
        raise ValueError('Local home must be an absolute directory')
    if not isinstance(cli, str) or not cli or '\0' in cli:
        raise ValueError('CLI must name one executable')
    if Path(home).exists() and not Path(home).is_dir():
        raise ValueError('Local home must be a directory')
    if os.path.lexists(Path(home) / 'credentials.toml'):
        raise ValueError('Local home must have no credential store; choose a dedicated runtime home')
    if not arguments or arguments[0] not in COMMANDS:
        raise ValueError('Only local workload commands are allowed; auth, context, and serve are excluded')
    selectors = arguments[:arguments.index('--')] if '--' in arguments else arguments
    if any(argument.split('=', 1)[0] in ROUTING for argument in selectors):
        raise ValueError('Routing overrides are forbidden; select the runtime in the private configuration')
    environment = {key: value for key, value in os.environ.items() if key not in ENVIRONMENT}
    command = [cli, '--home', home, '--profile', 'default', *arguments]
    return subprocess.run(command, env=environment, timeout=600, **options)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('configuration', type=Path)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    try:
        result = run(args.configuration, command)
        return result.returncode if result.returncode >= 0 else 128 - result.returncode
    except (ValueError, OSError):
        print('Local setup or command rejected; check the configuration, executable, and routing restrictions.', file=sys.stderr)
        return 2
    except subprocess.TimeoutExpired:
        print('Local command timed out; inspect its Box before retrying.', file=sys.stderr)
        return 124


if __name__ == '__main__':
    sys.exit(main())
