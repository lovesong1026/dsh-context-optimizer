#!/usr/bin/env bash
# Build the context-optimizer external plugin against a local DSH checkout.
#
# Steps: locate the DSH checkout → link dev dependencies → compile src → lib
# (tsc emits lib/types; tsdown bundles lib/index.js + lib/client.js).
# Requires `dsh` on PATH (or --checkout <path>).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# 1. Locate the DSH checkout and link dev dependencies
CHECKOUT=""
if [ "${1:-}" = "--checkout" ] && [ -n "${2:-}" ]; then
  CHECKOUT="$2"
elif command -v dsh &>/dev/null; then
  DSH_BIN=$(readlink -f "$(command -v dsh)" 2>/dev/null || command -v dsh)
  CHECKOUT=$(cd "$(dirname "$DSH_BIN")/.." 2>/dev/null && pwd)
fi
if [ -z "$CHECKOUT" ] || [ ! -d "$CHECKOUT/packages" ]; then
  echo "build: cannot locate the dsh checkout (dsh not on PATH?)" >&2
  echo "usage: ./scripts/build.sh [--checkout /path/to/dsh]" >&2
  exit 1
fi

node scripts/setup-dsh-deps.mjs --checkout "$CHECKOUT"

TSC="$CHECKOUT/node_modules/.bin/tsc"
TSDOWN="$CHECKOUT/node_modules/.bin/tsdown"
if [ ! -x "$TSC" ] || [ ! -x "$TSDOWN" ]; then
  echo "build: tsc/tsdown not found in checkout ($CHECKOUT)" >&2
  exit 1
fi

echo "=== Compiling src → lib (tsc $("$TSC" --version)) ==="
"$TSC" -p tsconfig.json

echo "=== Bundling host + client (tsdown) ==="
"$TSDOWN" -c tsdown.config.ts --tsconfig tsconfig.down.json

echo "=== Build complete ==="
ls -la lib/ lib/types/ | head -12
