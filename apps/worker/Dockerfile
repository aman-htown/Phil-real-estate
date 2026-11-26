# Worker image. Build from the repository root:
#   docker build -f apps/worker/Dockerfile -t whatsapp-worker .
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app

# Install only the worker's (and @phil/core's) runtime dependencies.
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --workspace @phil/worker --workspace @phil/core && npm cache clean --force

COPY packages/core packages/core
COPY apps/worker apps/worker

USER node
EXPOSE 8080
CMD ["npm", "run", "start", "--workspace", "@phil/worker"]
