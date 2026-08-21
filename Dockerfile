FROM node:24-bookworm-slim AS build

RUN corepack enable && corepack prepare pnpm@10.33.2 --activate
WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json biome.json ./
COPY packages ./packages
COPY apps ./apps

RUN pnpm --config.auto-install-peers=false install --frozen-lockfile
RUN pnpm build
RUN pnpm --filter @shelf/api deploy --prod --legacy /opt/shelf
RUN mkdir -p /opt/shelf/web && cp -R apps/web/dist/. /opt/shelf/web/

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /opt/shelf
COPY --from=build --chown=node:node /opt/shelf ./
RUN mkdir -p /var/lib/shelf/content && chown -R node:node /var/lib/shelf

USER node
EXPOSE 3000
CMD ["node", "dist/server-cli.js"]
