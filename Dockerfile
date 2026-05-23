# FlashFire JR scraper image.
# Uses Microsoft's official Playwright image — ships Chromium + every system
# lib Playwright needs (libnss3, libnspr4, fonts, etc.). Pinned to v1.59.1
# to match package-lock.json's resolved playwright version. Base image
# Chromium and npm playwright MUST match exactly, else
# launchPersistentContext errors w/ "Executable doesn't exist at
# /ms-playwright/chromium_headless_shell-<n>/...".
FROM mcr.microsoft.com/playwright:v1.59.1-jammy

# Tools used at runtime + by docker.sh's healthcheck (curl).
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Manifests first → layer caches between source-only changes.
COPY package*.json ./

# Production install. Playwright is a devDep but the scraper imports it
# at runtime — `--include=dev` keeps it. Browsers already exist at
# /ms-playwright (matching base-image tag); skip the postinstall download
# to save ~300MB + minutes of build time.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN if [ -f package-lock.json ]; then \
        npm ci --include=dev; \
    else \
        npm install --include=dev; \
    fi \
    && npm cache clean --force

# Source.
COPY . .

# Persistent data dirs — mounted as volumes by compose so storage (cookies)
# and runs (artifacts) survive container restarts.
RUN mkdir -p storage runs ai-cache \
    && chmod 0700 storage \
    && chmod 0755 runs ai-cache

# Playwright image's `pwuser` exists by default with browser deps installed.
# Run as non-root for safety. chown so storage/runs/ai-cache are writable.
RUN chown -R pwuser:pwuser /app
USER pwuser

# Default port — env.js reads PORT (default 8092). Override via .env.
EXPOSE 8092

# Healthcheck — server.js mounts GET /api/health.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS "http://localhost:${PORT:-8092}/api/health" || exit 1

# tini = PID 1 → reaps Chromium zombies + forwards SIGTERM cleanly so
# Playwright contexts close on `docker stop`.
ENTRYPOINT ["/usr/bin/tini", "--"]
# Direct node — bypass `npm start` because that wrapper runs
# `node --env-file-if-exists=.env src/server.js`, which would re-load
# whatever `.env` was COPY'd into the image at build time and silently
# override the values compose injected via `env_file`. Compose env wins.
CMD ["node", "src/server.js"]
