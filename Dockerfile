FROM node:22-bookworm-slim AS build

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.18.2 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages

RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0
# disabled fail-closes the API: non-public routes return 401.
# Development bearer tokens cannot be enabled while NODE_ENV=production.
ENV AUTH_MODE=disabled
ENV LOG_LEVEL=info

COPY --from=build /app /app

USER node
EXPOSE 8080

CMD ["node", "apps/api/dist/server.js"]
