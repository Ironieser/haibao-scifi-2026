#!/usr/bin/env bash
# /api/* 冒烟测试。先启动本地服务：
#   npx -y wrangler@4 d1 execute haibao --local --file=schema.sql
#   npx -y wrangler@4 pages dev dist --port 8788
# 然后：bash scripts/test_api.sh [BASE]
# 依赖 curl、jq。会写入测试数据（点赞、评论），测完请清理本地 D1。
# 由于 IP 限流（15 秒 1 条），整个脚本约需 35 秒。
set -u

BASE="${1:-${BASE:-http://localhost:8788}}"
HOST="${BASE#*://}"; HOST="${HOST%%/*}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ADMIN_TOKEN="${ADMIN_TOKEN:-$(sed -n 's/^ADMIN_TOKEN *= *"\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' "$ROOT/.dev.vars" 2>/dev/null)}"
WORK="huidao-mingtian"
DEV_A="test-device-a-$(date +%s)"
DEV_B="test-device-b-$(date +%s)"

PASS=0; FAIL=0
STATUS=""; BODY=""

# req METHOD PATH [JSON] [额外 curl 参数...]
req() {
  local method="$1" path="$2" data="${3:-}"; shift 3 2>/dev/null || shift $#
  local out
  if [ -n "$data" ]; then
    out=$(curl -s -w '\n%{http_code}' -X "$method" "$BASE$path" \
      -H 'Content-Type: application/json' -H "Origin: $BASE" --data-binary "$data" "$@")
  else
    out=$(curl -s -w '\n%{http_code}' -X "$method" "$BASE$path" -H "Origin: $BASE" "$@")
  fi
  STATUS="${out##*$'\n'}"
  BODY="${out%$'\n'*}"
  printf '  %-6s %-48s -> %s %s\n' "$method" "$path" "$STATUS" "$(printf '%s' "$BODY" | head -c 220)"
}

check() { # check 描述 条件(jq 表达式，对 BODY 求值) [期望状态码]
  local desc="$1" expr="$2" want="${3:-200}" ok
  ok=$(printf '%s' "$BODY" | jq -e "$expr" >/dev/null 2>&1 && echo y || echo n)
  if [ "$STATUS" = "$want" ] && [ "$ok" = y ]; then
    PASS=$((PASS+1)); echo "  [PASS] $desc"
  else
    FAIL=$((FAIL+1)); echo "  [FAIL] $desc (status=$STATUS, want=$want, expr=$expr)"
  fi
}

echo "== stats"
req GET /api/stats
check "stats 含 18 部作品" '(.works | length) == 18 and .works["huidao-mingtian"].likes >= 0'
CC=$(curl -s -D - -o /dev/null "$BASE/api/stats" | tr -d '\r' | awk -F': ' 'tolower($1)=="cache-control"{print $2}')
[ "$CC" = "public, max-age=30" ] && { PASS=$((PASS+1)); echo "  [PASS] stats Cache-Control: $CC"; } \
  || { FAIL=$((FAIL+1)); echo "  [FAIL] stats Cache-Control: '$CC'"; }

echo "== 点赞 / 收藏"
req POST /api/works/$WORK/like "{\"device\":\"$DEV_A\",\"on\":true}"
check "点赞" '.on == true and .likes == 1'
req POST /api/works/$WORK/like "{\"device\":\"$DEV_A\",\"on\":true}"
check "重复点赞幂等（仍为 1）" '.on == true and .likes == 1'
req POST /api/works/$WORK/like "{\"device\":\"$DEV_B\",\"on\":true}"
check "另一设备点赞 -> 2" '.likes == 2'
req POST /api/works/$WORK/like "{\"device\":\"$DEV_A\",\"on\":false}"
check "取消点赞计数回落 -> 1" '.on == false and .likes == 1'
req POST /api/works/$WORK/like "{\"device\":\"$DEV_A\",\"on\":false}"
check "重复取消幂等（仍为 1）" '.likes == 1'
req POST /api/works/$WORK/fav "{\"device\":\"$DEV_A\",\"on\":true}"
check "收藏" '.on == true and .favs == 1'
req POST /api/works/$WORK/fav "{\"device\":\"$DEV_A\",\"on\":false}"
check "取消收藏" '.on == false and .favs == 0'

echo "== 并发：同一设备并行 10 次"
W2="zhuan-rengong"
DEV_C="test-device-c-$(date +%s)"
TMPD=$(mktemp -d)
par() { # par PATH JSON：并行 10 次，输出每次的 JSON 到 $TMPD/r.N
  rm -f "$TMPD"/r.*
  for i in $(seq 1 10); do
    curl -s -X POST "$BASE$1" -H 'Content-Type: application/json' -H "Origin: $BASE" --data-binary "$2" > "$TMPD/r.$i" &
  done
  wait
  BODY=$(cat "$TMPD"/r.* | jq -s -c '.'); STATUS=200
  printf '  并行 10 次 POST %s -> %s\n' "$1" "$BODY"
}
par /api/works/$W2/like "{\"device\":\"$DEV_C\",\"on\":true}"
check "并行 10 次 like on=true，每次返回计数都为 1" 'length == 10 and all(.[]; .on == true and .likes == 1)'
req POST /api/works/$W2/like "{\"device\":\"$DEV_C\",\"on\":true}"
check "并行后计数仍为 1" '.likes == 1'
par /api/works/$W2/like "{\"device\":\"$DEV_C\",\"on\":false}"
check "并行 10 次 like on=false，计数为 0" 'length == 10 and all(.[]; .on == false and .likes == 0)'
par /api/works/$W2/fav "{\"device\":\"$DEV_C\",\"on\":true}"
check "并行 10 次 fav on=true，计数为 1" 'all(.[]; .favs == 1)'
req POST /api/works/$W2/fav "{\"device\":\"$DEV_C\",\"on\":false}"
check "取消收藏 -> 0" '.favs == 0'

echo "== 校验 / 错误"
req POST /api/works/no-such-work/like "{\"device\":\"$DEV_A\",\"on\":true}"
check "非法作品 id -> 404" '.error | type == "string"' 404
req GET /api/works/no-such-work/comments
check "非法作品 id 评论 -> 404" '.error | type == "string"' 404
req POST /api/works/$WORK/like '{"device":"short","on":true}'
check "device 太短 -> 400" '.error | type == "string"' 400
req POST /api/works/$WORK/like "{\"device\":\"$DEV_A\",\"on\":\"yes\"}"
check "on 非布尔 -> 400" '.error | type == "string"' 400
req POST /api/works/$WORK/like 'not json'
check "非 JSON -> 400" '.error | type == "string"' 400
req POST /api/works/$WORK/like "{\"device\":\"$DEV_A\",\"on\":true}" -H 'Origin: https://evil.example'
check "跨站 Origin -> 403" '.error | type == "string"' 403
BIG=$(python3 -I -c 'import json;print(json.dumps({"device":"aaaaaaaa","body":"x"*9000}))')
req POST /api/works/$WORK/comments "$BIG"
check "超过 8KB 请求体 -> 413" '.error | type == "string"' 413
req GET /api/nothing
check "未知接口 -> 404" '.error | type == "string"' 404
req GET /api/works/$WORK/like
check "错误方法 -> 405" '.error | type == "string"' 405
req POST /api/works/$WORK/comments "{\"device\":\"$DEV_A\",\"name\":\"测试\",\"body\":\"短\"}"
check "评论过短 -> 400" '.error | type == "string"' 400
req POST /api/works/$WORK/comments "{\"device\":\"$DEV_A\",\"name\":\"一二三四五六七八九十一二三四五六七八九十一\",\"body\":\"昵称太长\"}"
check "昵称超过 20 字 -> 400" '.error | type == "string"' 400

echo "== 评论 + 限流"
req POST /api/works/$WORK/comments "{\"device\":\"$DEV_A\",\"name\":\"  \",\"body\":\"  第一条\\u0007评论，测试。 \"}"
check "发表顶层评论（默认昵称、去控制字符）" '.comment.id > 0 and .comment.parent == null and .comment.name == "匿名读者" and .comment.body == "第一条评论，测试。" and .comment.replies == []' 201
C1=$(printf '%s' "$BODY" | jq -r '.comment.id')
req POST /api/works/$WORK/comments "{\"device\":\"$DEV_A\",\"name\":\"读者乙\",\"body\":\"马上再发一条\"}"
check "15 秒内第二条 -> 429" '.error | test("太快")' 429

echo "  （等待 16 秒绕过 IP 限流）"; sleep 16
req POST /api/works/$WORK/comments "{\"device\":\"$DEV_B\",\"name\":\"读者乙\",\"body\":\"这是一条回复\",\"parent\":$C1}"
check "回复顶层评论" ".comment.parent == $C1 and .comment.name == \"读者乙\"" 201
R1=$(printf '%s' "$BODY" | jq -r '.comment.id')

echo "  （等待 16 秒）"; sleep 16
req POST /api/works/$WORK/comments "{\"device\":\"$DEV_B\",\"name\":\"读者乙\",\"body\":\"回复的回复\",\"parent\":$R1}"
check "回复一条回复（非顶层 parent）-> 400" '.error | type == "string"' 400
req POST /api/works/$WORK/comments "{\"device\":\"$DEV_B\",\"name\":\"读者乙\",\"body\":\"第二条顶层评论\"}"
check "第二条顶层评论" '.comment.parent == null' 201
C2=$(printf '%s' "$BODY" | jq -r '.comment.id')

echo "== 评论列表"
req GET "/api/works/$WORK/comments"
check "列表按 id 倒序，只含顶层" "[.comments[].id] == [$C2, $C1] and .more == false"
check "replies 嵌套正确" "(.comments[] | select(.id == $C1) | .replies | map(.id)) == [$R1] and (.comments[] | select(.id == $C2) | .replies) == []"
req GET "/api/works/$WORK/comments?limit=1"
check "limit=1 分页 more=true" "[.comments[].id] == [$C2] and .more == true"
req GET "/api/works/$WORK/comments?before=$C2&limit=1"
check "before 翻页" "[.comments[].id] == [$C1] and .more == false"

echo "== 评论点赞"
req POST /api/comments/$C1/like "{\"device\":\"$DEV_A\",\"on\":true}"
check "评论点赞" '.on == true and .likes == 1'
req POST /api/comments/$C1/like "{\"device\":\"$DEV_A\",\"on\":true}"
check "评论点赞幂等" '.likes == 1'
req POST /api/comments/$C1/like "{\"device\":\"$DEV_A\",\"on\":false}"
check "取消评论点赞" '.on == false and .likes == 0'
par /api/comments/$C1/like "{\"device\":\"$DEV_C\",\"on\":true}"
check "并行 10 次评论点赞，计数为 1" 'all(.[]; .likes == 1)'
par /api/comments/$C1/like "{\"device\":\"$DEV_C\",\"on\":false}"
check "并行 10 次取消评论点赞，计数为 0" 'all(.[]; .likes == 0)'
req POST /api/comments/999999/like "{\"device\":\"$DEV_A\",\"on\":true}"
check "不存在的评论 -> 404" '.error | type == "string"' 404

echo "== 删除"
req DELETE /api/comments/$C2 "{\"device\":\"$DEV_A\"}"
check "他人 device 删除 -> 403" '.error | type == "string"' 403
req DELETE /api/comments/$C2
check "无凭据删除 -> 401" '.error | type == "string"' 401
req DELETE /api/comments/$C2 "{\"device\":\"$DEV_B\"}"
check "发表者 device 删除" '.ok == true'
req GET "/api/works/$WORK/comments"
check "删除生效（只剩 C1，回复仍在）" "[.comments[].id] == [$C1] and (.comments[0].replies | map(.id)) == [$R1]"
req DELETE /api/comments/$C1 "" -H "Authorization: Bearer $ADMIN_TOKEN"
check "ADMIN_TOKEN 删除带回复的顶层评论" '.ok == true'
req DELETE /api/comments/$C1 "" -H "Authorization: Bearer $ADMIN_TOKEN"
check "重复删除 -> 404" '.error | type == "string"' 404
req DELETE /api/comments/$R1 "" -H "Authorization: Bearer $ADMIN_TOKEN"
check "删除已不可见的回复（不应重复扣减计数）" '.ok == true'
req GET "/api/works/$WORK/comments"
check "删除生效（列表为空）" '.comments == [] and .more == false'

echo "== stats"
req GET /api/stats
check "stats 结构" '.works["huidao-mingtian"] | has("likes") and has("favs") and has("comments")'
check "增量计数与实际一致（首次请求已超过 30 秒缓存）" '.works["huidao-mingtian"] == {"likes":1,"favs":0,"comments":0} and .works["zhuan-rengong"] == {"likes":0,"favs":0,"comments":0}'
rm -rf "$TMPD"

echo
echo "结果：$PASS 通过，$FAIL 失败"
[ "$FAIL" -eq 0 ]
