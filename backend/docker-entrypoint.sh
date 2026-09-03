#!/bin/sh
set -e

echo "[entrypoint] Applying database migrations (prisma migrate deploy)..."
./node_modules/.bin/prisma migrate deploy

echo "[entrypoint] Starting Sendly backend..."
# tsx loader resolves the extensionless ESM imports emitted by tsc
# (required for the compiled output, incl. the generated Prisma client)
exec node --import tsx dist/index.js