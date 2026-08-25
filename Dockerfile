# planfly's production image.
#
# Node 24 alpine so it matches .nvmrc. Multi-stage: the build dependencies never
# reach the final image.

# ── Dependencies ────────────────────────────────────────────────────────────
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# `npm ci` honours the exact lockfile. `--ignore-scripts` is genuinely on the
# line and not only in this comment: without it, puppeteer's postinstall pulls
# 650 MB of browser into the image — `.puppeteerrc.cjs`, which disables it, does
# not reach this stage — and on a restricted network the download fails and the
# whole build dies. Nothing running here needs those lifecycles: the build is
# `next build`, and esbuild is only used by drizzle-kit from the host.
RUN npm ci --ignore-scripts

# ── Build ───────────────────────────────────────────────────────────────────
FROM node:24-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# No telemetry: this machine sends nothing anywhere.
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ── Runtime ─────────────────────────────────────────────────────────────────
FROM node:24-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
# Dual stack: without this Next listens on IPv4 only and `localhost` from
# Windows (which resolves ::1 first) is slow to fall back to IPv4.
ENV HOSTNAME="::"

# Unprivileged user: the process does not need root.
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Rate sources do NOT go into the image: they are mounted at /app/providers at
# run time (see compose.yaml). That way changing one does not force a rebuild,
# and whatever each person plugs in does not end up inside a layer.

USER nextjs
EXPOSE 3000

# Healthcheck against the route that already exists for it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
