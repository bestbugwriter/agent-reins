#!/bin/sh
# 启动 hook：优先用安装时记录的 node；它失效时（例如 nvm 切换或卸载了版本）回退到 PATH 和常见位置
dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
script="$dir/$1.mjs"
shift
recorded=$(cat "$dir/../node-path" 2>/dev/null)
nvm_latest=$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | tail -n 1)
for n in "$recorded" "$(command -v node 2>/dev/null)" "$nvm_latest" /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    if [ -n "$n" ] && [ -x "$n" ]; then
        exec "$n" "$script" "$@"
    fi
done
echo "[agent-tidy] 找不到 node，hook 已跳过；请重新运行 agent-tidy install" >&2
cat >/dev/null
exit 0
