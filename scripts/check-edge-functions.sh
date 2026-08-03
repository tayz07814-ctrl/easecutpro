#!/usr/bin/env bash
# Undefined-identifier check for the Deno edge functions.
#
# These files are never covered by tsconfig.node/web (they are Deno, with npm:
# and jsr: specifiers), so nothing used to typecheck them — a bad `export … from`
# that re-exported a name without binding it in module scope shipped to
# production and threw "wavSeconds is not defined" on every transcription.
#
# esbuild only parses, so it cannot see an unbound name. tsc can: run it with
# --noResolve (the npm:/jsr: specifiers are unresolvable here and irrelevant to
# this check) and fail only on TS2304 "Cannot find name", ignoring the Deno
# runtime globals.
set -uo pipefail
cd "$(dirname "$0")/.."

out=$(npx tsc --noEmit --skipLibCheck --module esnext --target es2022 \
        --moduleResolution bundler --noResolve \
        supabase/functions/_shared/*.ts supabase/functions/*/index.ts 2>&1 \
      | grep "TS2304" \
      | grep -v "Cannot find name 'Deno'" \
      | grep -v "Cannot find name 'crypto'" || true)

if [ -n "$out" ]; then
  echo "Undefined identifiers in edge functions:"
  echo "$out"
  exit 1
fi
echo "edge functions: no undefined identifiers"
