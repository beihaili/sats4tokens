# cashu-epay gateway. Node 22 runs the .ts sources directly (type stripping), no build step.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY web ./web
COPY scripts ./scripts
ENV NODE_ENV=production DATA_DIR=/data PORT=8090
USER node
EXPOSE 8090
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.ts"]
