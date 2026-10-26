# cloudfriend: one container, one SQLite file. Node runs the TypeScript sources directly
# (type stripping) and uses the built-in node:sqlite, so there is no build step.
# Python with LightGBM is included only for retraining the classifier (ml/train.py);
# scoring events happens in Node.
FROM node:22.22.0-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip libgomp1 \
 && pip3 install --no-cache-dir --break-system-packages lightgbm==4.7.0 "numpy<3" \
 && apt-get purge -y python3-pip && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production \
    CLOUDFRIEND_DATA_DIR=/data \
    PORT=8080

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY bin ./bin
COPY models ./models
COPY ml/train.py ./ml/train.py
RUN ln -s /app/bin/cloudfriend /usr/local/bin/cloudfriend \
 && mkdir -p /data && chown node:node /data

USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --start-interval=1s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
