# syntax=docker/dockerfile:1.7
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS build
WORKDIR /workspace

COPY package.json package-lock.json tsconfig.base.json ./
COPY src/catalog-api/package.json src/catalog-api/tsconfig.json ./src/catalog-api/
COPY src/order-api/package.json ./src/order-api/package.json
COPY src/frontend/package.json ./src/frontend/package.json
RUN npm ci --ignore-scripts

COPY src/catalog-api/src ./src/catalog-api/src
COPY src/catalog-api/data ./src/catalog-api/data
RUN npm run build -w @techx/catalog-api

FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS runtime
ENV NODE_ENV=production \
    CATALOG_PORT=3001
WORKDIR /app
COPY --from=build --chown=10001:10001 /workspace/src/catalog-api/dist ./dist
USER 10001:10001
EXPOSE 3001
CMD ["node", "dist/src/main.js"]
