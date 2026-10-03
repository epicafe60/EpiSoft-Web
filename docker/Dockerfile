# EpiSoft-Web application image: the API also serves the built web app (spec §7.3).
# Build from the repository root:  docker build -f docker/Dockerfile -t episoft-web .

FROM node:22-slim AS build
RUN npm install -g pnpm@10.34.6
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @episoft/web build && pnpm --filter @episoft/api build
# Production node_modules for the API only (workspace packages are bundled by tsup).
RUN pnpm --filter @episoft/api deploy --legacy --prod /out

FROM node:22-slim
ENV NODE_ENV=production \
    API_HOST=0.0.0.0 \
    API_PORT=3000 \
    WEB_DIST=/app/web \
    MIGRATIONS_DIR=/app/drizzle \
    MIGRATE_ON_START=true \
    COOKIE_SECURE=true
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./package.json
COPY --from=build /src/apps/api/dist ./dist
COPY --from=build /src/apps/web/dist ./web
COPY --from=build /src/packages/db/drizzle ./drizzle
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:3000/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "dist/server.js"]
