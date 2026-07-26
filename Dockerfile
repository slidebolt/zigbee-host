FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    ZIGBEE_HOST_ADDRESS=0.0.0.0 \
    ZIGBEE_HOST_PORT=47831 \
    ZIGBEE_ADAPTER=/dev/zigbee \
    ZIGBEE_DATA_DIR=/data \
    ZIGBEE_RUNTIME_DIR=/data/runtime \
    ZIGBEE_LOG_DIR=/data/logs

WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN mkdir -p /data && chown -R node:node /data
USER node
EXPOSE 47831
VOLUME ["/data"]
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:47831/v1/health',{headers:{authorization:'Bearer '+process.env.ZIGBEE_HOST_TOKEN}}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/host.js"]
