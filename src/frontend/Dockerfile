# syntax=docker/dockerfile:1.7
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS build
WORKDIR /workspace

COPY package.json package-lock.json tsconfig.base.json ./
COPY src/catalog-api/package.json ./src/catalog-api/package.json
COPY src/order-api/package.json ./src/order-api/package.json
COPY src/frontend/package.json src/frontend/tsconfig.json src/frontend/next.config.mjs src/frontend/next-env.d.ts ./src/frontend/
RUN npm ci --ignore-scripts

COPY src/frontend/app ./src/frontend/app
COPY src/frontend/components ./src/frontend/components
COPY src/frontend/lib ./src/frontend/lib
COPY src/frontend/public ./src/frontend/public
RUN npm run build -w @techx/frontend

FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS runtime
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000
WORKDIR /app
COPY --from=build --chown=10000:10000 /workspace/src/frontend/.next/standalone ./
COPY --from=build --chown=10000:10000 /workspace/src/frontend/.next/static ./src/frontend/.next/static
COPY --from=build --chown=10000:10000 /workspace/src/frontend/public ./src/frontend/public
USER 10000:10000
EXPOSE 3000
CMD ["node", "src/frontend/server.js"]
