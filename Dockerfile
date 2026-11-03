# syntax=docker/dockerfile:1
#
# 课堂系统 · 镜像
#
#   构建：docker build -t teach-system .
#   运行：docker run -d --name teach-system -p 18730:18730 -v "$PWD/data:/data" teach-system
#   编排：docker compose up -d        （同目录 docker-compose.yml）
#
# 三段：前端构建 → 运行期依赖 → 运行镜像（只带 server + web/dist + production 依赖）。

################ 1) 前端构建（vite） ################
FROM node:20-bookworm-slim AS web
WORKDIR /src/web
# 先只拷 manifest，依赖能吃到层缓存
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

################ 2) 运行期依赖（只要 exceljs / yauzl） ################
FROM node:20-bookworm-slim AS deps
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

################ 3) 运行 ################
FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    TS_PORT=18730 \
    TS_HOST=0.0.0.0 \
    TS_DATA_DIR=/data

WORKDIR /app

COPY --from=deps /src/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY --from=web /src/web/dist ./web/dist
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

# 数据目录（CSV / 学生提交 / 上传 / 回收站）挂卷；先建好并把属主给 node
RUN mkdir -p /data && chown -R node:node /data /app

USER node
VOLUME ["/data"]
EXPOSE 18730

# 容器自己要能判断「活着」：用 /api/health（接口可用即算健康）
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.TS_PORT||18730)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 入口先检查数据目录能不能写（不可写就给人话，而不是 EACCES 栈），再起服务；
# 收到 SIGTERM 会先把 CSV 落盘再退出（server/index.js 里已实现）
ENTRYPOINT ["/app/docker-entrypoint.sh"]
