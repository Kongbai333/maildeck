#!/bin/sh
set -e

# 数据目录（SQLite / 缓存）：确保存在且可写，再启动服务。
DATA_DIR="${MAILDECK_DATA_DIR:-/data}"
mkdir -p "$DATA_DIR"
# 挂载卷可能是 root/其它属主，直接放开写权限，避免 SQLite "unable to open database file"。
chmod 777 "$DATA_DIR" 2>/dev/null || true
chown -R 10001:10001 "$DATA_DIR" 2>/dev/null || true

exec "$@"
