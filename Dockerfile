FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/cloud-worker/package.json apps/cloud-worker/package.json
COPY apps/connector-cli/package.json apps/connector-cli/package.json
COPY apps/desktop/package.json apps/desktop/package.json
COPY apps/web-chat/package.json apps/web-chat/package.json
COPY packages/adapter-sdk/package.json packages/adapter-sdk/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/sdk/package.json packages/sdk/package.json

RUN npm ci --omit=dev --ignore-scripts

COPY apps/cloud-worker/src apps/cloud-worker/src
COPY packages/protocol/src packages/protocol/src
COPY scripts/selfhost scripts/selfhost

ENV NODE_ENV=production
ENV PORT=8787
ENV BRIDGE_SERVER_HOST=0.0.0.0
ENV BRIDGE_LOCAL_MEMORY=1
ENV BRIDGE_PRODUCT_REGISTRY_MODE=builtin

EXPOSE 8787

ENTRYPOINT ["node", "scripts/selfhost/bridge-server.mjs"]
CMD ["serve"]
