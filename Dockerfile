# 简历岗位雷达 · 生产镜像
FROM node:22-alpine

WORKDIR /app

# 生产环境标识
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3210 \
    TRUST_PROXY=1

# 先装依赖，利用 Docker 层缓存
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# 应用代码（不包含 tools/、data/、config.json）
COPY src ./src
COPY public ./public
COPY config.example.json ./

# 数据目录：检索结果与字体映射缓存，以卷挂载持久化
RUN mkdir -p /app/data && chown -R node:node /app
USER node

VOLUME ["/app/data"]
EXPOSE 3210

# 健康检查直接打业务接口
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3210)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.mjs"]
