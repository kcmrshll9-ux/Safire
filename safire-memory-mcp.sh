#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

case "$(uname -s)" in
  Darwin)
    SAFIRE_EXECUTABLE="$SCRIPT_DIR/../MacOS/Safire"
    ;;
  Linux)
    SAFIRE_EXECUTABLE="$SCRIPT_DIR/../safire"
    ;;
  *)
    echo "Safire's packaged memory launcher supports macOS and Linux." >&2
    exit 1
    ;;
esac

export ELECTRON_RUN_AS_NODE=1
exec "$SAFIRE_EXECUTABLE" "$SCRIPT_DIR/app.asar.unpacked/safire-memory-mcp.mjs" "$@"
