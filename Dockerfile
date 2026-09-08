# ── Builder ─────────────────────────────────────────────────────────────
FROM node:22-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Runtime ─────────────────────────────────────────────────────────────
FROM node:22-slim

# Depop / Poshmark need a headless browser. Facebook and eBay work without it.
# Build with `--build-arg INSTALL_CHROME=true` (or set it in docker-compose)
# to also enable Depop and Poshmark.
ARG INSTALL_CHROME=false
RUN if [ "$INSTALL_CHROME" = "true" ]; then \
      apt-get update && \
      apt-get install -y --no-install-recommends chromium && \
      rm -rf /var/lib/apt/lists/*; \
    fi

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# Internal default; override with env or docker-compose.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/api.js"]
