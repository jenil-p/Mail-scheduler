# Build stage
FROM node:20-alpine AS build
WORKDIR /app

# Install dependencies (reproducible via lockfile)
COPY package.json package-lock.json ./
RUN npm ci

# NEXT_PUBLIC_* vars are inlined into the client bundle at build time.
# Browsers cannot resolve Docker service names, so these must be the
# host-published URLs (overridden via compose build args).
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ARG NEXT_PUBLIC_GOOGLE_CLIENT_ID=
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_GOOGLE_CLIENT_ID=$NEXT_PUBLIC_GOOGLE_CLIENT_ID

# Copy source + config, then build
COPY next.config.js postcss.config.js tailwind.config.ts tsconfig.json next-env.d.ts ./
COPY src ./src
RUN npm run build

# Runtime stage
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Copy build output, prod dependencies, and runtime config
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/next.config.js ./
COPY --from=build /app/.next ./.next

# Run as a non-root user
RUN chown -R node:node /app
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:3000 > /dev/null || exit 1

CMD ["./node_modules/.bin/next", "start"]