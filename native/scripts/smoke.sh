#!/bin/bash
# Builds the helper and runs the capture smoke test against it. Needs microphone and System
# Audio Recording permission for the terminal app, and plays speech through the default output.
set -euo pipefail
cd "$(dirname "$0")/.."
./build.sh >/dev/null
exec python3 scripts/smoke.py --helper dist/granola-helper "$@"
