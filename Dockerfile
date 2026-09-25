# =============================================================================
#  SIBO heartbeat server — container image
#  Build context = repo root (this file builds the ./server app).
#  In Coolify: choose Build Pack "Dockerfile" — default paths work as-is.
# =============================================================================
FROM node:22-alpine

# tini = proper PID 1: forwards SIGTERM so Coolify stops/restarts are clean,
# and reaps any zombies.
RUN apk add --no-cache tini

ENV NODE_ENV=production
WORKDIR /app

# Install deps first for better layer caching.
# --omit=dev drops devDependencies but KEEPS optionalDependencies
# (twilio + nodemailer), so the email/call channels stay available.
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# App source.
COPY server/ ./

ENV PORT=8080
EXPOSE 8080
USER node

# Container-level health check (Coolify can also use this).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-8080}/healthz" >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "index.js"]
