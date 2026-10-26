# cloudfriend: one container, one SQLite file. Node runs the TypeScript sources directly
# (type stripping) and uses the built-in node:sqlite, so there is no build step.
FROM node:22.22.0-slim

WORKDIR /app
ENV NODE_ENV=production \
    CLOUDFRIEND_DATA_DIR=/data \
    PORT=8080

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY bin ./bin
RUN ln -s /app/bin/cloudfriend /usr/local/bin/cloudfriend \
 && mkdir -p /data && chown node:node /data

USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --start-interval=1s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
