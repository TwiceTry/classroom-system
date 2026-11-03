#!/bin/sh
# 课堂系统 · 容器入口
#
# 只做一件事：数据目录不可写时，给一句人话，而不是让 node 抛 EACCES 栈。
# 容器里以非 root 的 node（uid 1000）运行，宿主机上挂进来的 data/ 得让它能写。
set -e

DATA="${TS_DATA_DIR:-/data}"

if ! mkdir -p "$DATA/uploads" 2>/dev/null || [ ! -w "$DATA" ]; then
  echo "" >&2
  echo "！！数据目录不可写：$DATA（容器内以 uid $(id -u) 运行）" >&2
  echo "" >&2
  echo "   宿主机上给它放开权限就行：" >&2
  echo "     sudo mkdir -p <你挂进来的 data 目录>" >&2
  echo "     sudo chown -R $(id -u):$(id -g) <你挂进来的 data 目录>" >&2
  echo "" >&2
  echo "   docker compose 的写法（数据在 ./data）：" >&2
  echo "     mkdir -p data && sudo chown -R 1000:1000 data" >&2
  echo "" >&2
  exit 1
fi

echo "课堂系统启动：数据目录 $DATA · 端口 ${TS_PORT:-18730}"
exec node server/index.js
