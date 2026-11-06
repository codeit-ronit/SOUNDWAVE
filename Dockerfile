FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
COPY client/package.json client/package.json
COPY server/package.json server/package.json
RUN npm ci
COPY client client
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
COPY client/package.json client/package.json
COPY server/package.json server/package.json
RUN npm ci --omit=dev && npm cache clean --force
COPY server server
COPY --from=build /app/client/dist client/dist
USER node
EXPOSE 3001
FROM runtime AS worker
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s CMD ["node","server/scripts/worker-health.js"]
CMD ["node","server/scripts/worker.js"]

FROM runtime AS api
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/ready',{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","server/index.js"]
