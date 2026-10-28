# cloudfriend: one image for every role (CLOUDFRIEND_ROLE=all, web or worker). All state lives in
# Postgres (CLOUDFRIEND_DATABASE_URL); /data holds only trained model files. Node runs the
# TypeScript sources directly (type stripping), so there is no build step.
#
# Python with LightGBM is included only for retraining the classifier (ml/train.py); scoring
# events happens in Node. It is installed in its own stage, so pip and its caches stay out of
# the image. Both stages use the same base, so the wheels match the image's Python.
FROM node:22.22.0-slim AS python-deps
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3-pip \
 && pip3 install --no-cache-dir --no-compile --break-system-packages --target /opt/python \
      lightgbm==4.7.0 "numpy<3" \
 && find /opt/python -depth -type d -name tests -exec rm -rf {} + \
 && rm -rf /opt/python/bin

FROM node:22.22.0-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 libgomp1 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=python-deps /opt/python /opt/python

WORKDIR /app
ENV NODE_ENV=production \
    PYTHONPATH=/opt/python \
    PYTHONDONTWRITEBYTECODE=1 \
    CLOUDFRIEND_DATA_DIR=/data \
    PORT=8080

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY bin ./bin
COPY models ./models
COPY regression ./regression
COPY ml/train.py ./ml/train.py
# Includes src/migrations (applied at boot) and src/ui/static (the dashboard).
COPY src ./src
RUN ln -s /app/bin/cloudfriend /usr/local/bin/cloudfriend \
 && mkdir -p /data && chown node:node /data

USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --start-interval=1s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
