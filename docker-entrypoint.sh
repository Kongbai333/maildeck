#!/bin/sh
set -e

# 数据目录（SQLite / 缓存）。挂载卷可能是 root 所有，先修正属主再降权运行。
DATA_DIR="${MAILDECK_DATA_DIR:-/data}"
mkdir -p "$DATA_DIR"
chown -R maildeck:maildeck "$DATA_DIR" 2>/dev/null || true

exec gosu maildeck "$@"
