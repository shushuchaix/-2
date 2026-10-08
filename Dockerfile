# Build once, then ship the same renderer used by the desktop package.
FROM node:20.20.2-bookworm-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
COPY ui/package.json ./ui/package.json
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY ui ./ui
COPY tools/build-ui.mjs ./tools/build-ui.mjs
COPY public/js ./public/js
RUN node tools/build-ui.mjs

FROM node:20.20.2-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3210 \
    TRUST_PROXY=1
COPY package.json package-lock.json ./
COPY ui/package.json ./ui/package.json
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && rm -rf /app/ui && npm cache clean --force
COPY src ./src
COPY --from=builder /app/public/app ./public/app
COPY public/login.html public/login.js public/style.css ./public/
COPY public/js/validation-rules.js public/js/diagnostic-rules.js public/js/version-management.js ./public/js/
COPY public/js/components/form-validation.js public/js/components/dom.js ./public/js/components/
COPY config.example.json ./
RUN mkdir -p /app/data && chown -R node:node /app
USER node
VOLUME ["/app/data"]
EXPOSE 3210
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3210)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.mjs"]
