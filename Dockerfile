# syntax=docker/dockerfile:1
#
# 课堂系统 · 镜像
#
#   构建：docker build -t teach-system .
#   运行：docker run -d --name teach-system -p 18730:18730 -v "$PWD/data:/data" teach-system
#   编排：docker compose up -d        （同目录 docker-compose.yml）
#
# 四段：前端构建 → 根依赖 → 后端依赖 → 运行镜像
#       （只带 api + web/dist + 两套 production 依赖，不含课程内容与数据）

################ 1) 前端构建（vite） ################
FROM node:20-bookworm-slim AS web
WORKDIR /src/web
# 先只拷 manifest，依赖能吃到层缓存
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

################ 2) 根依赖（exceljs / yauzl —— 表格解析、zip 解压） ################
FROM node:20-bookworm-slim AS deps
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

################ 3) 后端依赖（fastify / better-sqlite3 …） ################
# better-sqlite3 是原生模块：优先用预编译包，没有就得现编，
# 所以这一层装了 python3/make/g++。编译产物只留在本阶段，不进最终镜像。
FROM node:20-bookworm-slim AS api-deps
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src/api
COPY api/package.json api/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

################ 4) 运行 ################
FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    TS_PORT=18730 \
    TS_HOST=0.0.0.0 \
    TS_DATA_DIR=/data

WORKDIR /app

# 两套依赖分开拷：根目录那份给 exceljs/yauzl，api/ 那份给 fastify/better-sqlite3。
# 合并成一份会很脆（两边的版本要求各自独立演进）。
COPY --from=deps /src/node_modules ./node_modules
COPY --from=api-deps /src/api/node_modules ./api/node_modules
COPY package.json ./
COPY api ./api
COPY --from=web /src/web/dist ./web/dist
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

# 数据目录（SQLite 库 / 学生提交 / 上传 / 回收站）挂卷；先建好并把属主给 node
RUN mkdir -p /data && chown -R node:node /data /app

USER node
VOLUME ["/data"]
EXPOSE 18730

# 容器自己要能判断「活着」：用 /api/health（接口可用即算健康）
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.TS_PORT||18730)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 入口先检查数据目录能不能写（不可写就给人话，而不是 EACCES 栈），再起服务
ENTRYPOINT ["/app/docker-entrypoint.sh"]
