FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:24-slim
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
ENV HOST=0.0.0.0
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=3s --start-period=25s --retries=3 CMD node -e "if (['worker', 'backup'].includes(process.env.ATHLENTRY_PROCESS_TYPE ?? '')) { try { process.kill(1, 0); process.exit(0); } catch { process.exit(1); } } else { fetch('http://127.0.0.1:' + (process.env.PORT ?? '3001') + '/healthz').then((response) => process.exit(response.ok ? 0 : 1), () => process.exit(1)); }"
CMD ["npm", "run", "start"]
