# Build stage
FROM node:20-alpine AS build
WORKDIR /app

# Install dependencies (reproducible via lockfile)
COPY package.json package-lock.json ./
RUN npm ci

# prisma.config.ts calls env("DATABASE_URL"), so a value must be present
# even for `prisma generate` (no DB connection is made).
ARG DATABASE_URL=postgresql://sendly:sendly_pass@postgres:5432/sendly
ENV DATABASE_URL=$DATABASE_URL

# Generate the Prisma client into src/generated/prisma
COPY prisma.config.ts ./
COPY prisma ./prisma
RUN npx prisma generate

# Compile TypeScript -> dist/
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Fail the build early if the generated client wasn't emitted into dist/
RUN test -f dist/generated/prisma/client.js

# Runtime stage
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Copy runtime code + full node_modules (keeps the prisma CLI for migrations)
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/prisma.config.ts ./

# Run as a non-root user
RUN chown -R node:node /app

# Entrypoint: applies migrations, then starts the API server + BullMQ worker
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

USER node

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:4000/api/health > /dev/null || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]