# syntax=docker/dockerfile:1.7
FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS build
WORKDIR /workspace

COPY package.json package-lock.json tsconfig.base.json ./
COPY src/catalog-api/package.json ./src/catalog-api/package.json
COPY src/order-api/package.json src/order-api/tsconfig.json ./src/order-api/
COPY src/frontend/package.json ./src/frontend/package.json
RUN npm ci --ignore-scripts

COPY src/order-api/src ./src/order-api/src
RUN npm run build -w @techx/order-api

FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS runtime
ENV NODE_ENV=production \
    ORDER_PORT=3002
WORKDIR /app
COPY --from=build --chown=10002:10002 /workspace/node_modules ./node_modules
COPY --from=build --chown=10002:10002 /workspace/src/order-api/dist ./dist
USER 10002:10002
EXPOSE 3002
CMD ["node", "dist/src/main.js"]
