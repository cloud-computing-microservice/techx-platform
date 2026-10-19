# syntax=docker/dockerfile:1.7
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS build
WORKDIR /workspace

COPY package.json package-lock.json tsconfig.base.json ./
COPY src/catalog-api/package.json ./src/catalog-api/package.json
COPY src/order-api/package.json src/order-api/tsconfig.json ./src/order-api/
COPY src/frontend/package.json ./src/frontend/package.json
RUN npm ci --ignore-scripts

COPY src/order-api/src ./src/order-api/src
RUN npm run build -w @techx/order-api
RUN npm prune --omit=dev

FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS runtime
RUN apk add --no-cache zlib=1.3.2-r1
ENV NODE_ENV=production \
    ORDER_PORT=3002
WORKDIR /app
COPY --from=build --chown=10002:10002 /workspace/node_modules ./node_modules
COPY --from=build --chown=10002:10002 /workspace/src/order-api/dist ./dist
USER 10002:10002
EXPOSE 3002
CMD ["node", "dist/src/main.js"]
