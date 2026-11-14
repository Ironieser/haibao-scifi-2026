#!/usr/bin/env bash
# /api/* 冒烟测试。先启动本地服务：
#   npx -y wrangler@4 d1 execute haibao --local -c wrangler.worker.jsonc --file=schema.sql -y
#   npx -y wrangler@4 d1 execute haibao --local -c wrangler.worker.jsonc --file=scripts/migrate_views.sql -y
#   npx -y wrangler@4 dev -c wrangler.worker.jsonc --local --port 8795
# 然后：bash scripts/test_api.sh http://localhost:8795
# 依赖 curl、jq、npx（部分断言直接查本地 D1 核对内部状态，只能对 --local 使用）。会写入测试数据，测完请清理本地 D1：
#   rm -rf .wrangler/state   （或逐表 DELETE）
# 热门划线 / 浏览量汇总接口有 60 秒边缘缓存，脚本里每个作品只在写完之后才第一次 GET；
# 浏览量核对需要等汇总缓存过期。整个脚本约需 3 分钟。
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
TS0=$(date +%s)
ROOTDIR="$ROOT"
# db SQL：在本地 D1 上执行，输出最后一条语句的结果（JSON 数组）
db() {
  (cd "$ROOTDIR" && npx -y wrangler@4 d1 execute haibao --local -c wrangler.worker.jsonc -y --json --command "$1" 2>/dev/null) \
    | jq -c '.[-1].results'
}
ok_if() { # ok_if 描述 bash 条件结果(y/n)
  if [ "$2" = y ]; then PASS=$((PASS+1)); echo "  [PASS] $1"; else FAIL=$((FAIL+1)); echo "  [FAIL] $1 ${3:-}"; fi
}

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

echo "== 浏览量起点（直接读本地 D1）"
TODAY=$(TZ=Asia/Shanghai date +%F)
V0=$(db "SELECT (SELECT IFNULL(SUM(n),0) FROM view_totals) AS t, (SELECT IFNULL(MAX(n),0) FROM views WHERE page='*' AND day='$TODAY') AS s, (SELECT IFNULL(MAX(n),0) FROM uv WHERE day='$TODAY') AS u, (SELECT IFNULL(MAX(n),0) FROM view_totals WHERE page='notes') AS notes")
echo "  起点：$V0"
HITS=0          # 有效页面的 hit 次数（每次计 1 PV）
UVDEV=0         # 本次测试新用到的设备数（每台计 1 UV）
LAST_SUMMARY=0  # 最后一次可能写入浏览量汇总缓存的时间

echo "== POST /api/hit 合并响应"
HD1="test-hit-a-$TS0"; HD2="test-hit-b-$TS0"; HD3="test-hit-c-$TS0"
req POST /api/hit "{\"page\":\"home\",\"device\":\"$HD1\"}"; HITS=$((HITS+1)); UVDEV=$((UVDEV+1)); LAST_SUMMARY=$(date +%s)
check "首页 hit：views + stats + recent，无 hot / series" '(.views | has("total") and has("today") and has("pages")) and (.stats.works | length) == 18 and (.recent.comments | type) == "array" and (has("hot") | not) and (has("series") | not)'
HC=$(curl -s -D - -o /dev/null -X POST "$BASE/api/hit" -H 'Content-Type: application/json' -H "Origin: $BASE" --data-binary "{\"page\":\"notes\",\"device\":\"$HD1\"}" | tr -d '\r' | awk -F': ' 'tolower($1)=="cache-control"{print $2}'); HITS=$((HITS+1))
[ "$HC" = "no-store" ] && { PASS=$((PASS+1)); echo "  [PASS] hit 响应不缓存（Cache-Control: ${HC}）"; } || { FAIL=$((FAIL+1)); echo "  [FAIL] hit Cache-Control: '$HC'"; }
req POST /api/hit "{\"page\":\"suoluomen\",\"device\":\"$HD2\"}"; HITS=$((HITS+1)); UVDEV=$((UVDEV+1))
check "作品页 hit：含 hot（阈值、读者数、片段），不含 recent" '.hot.threshold == 3 and (.hot.readers | type) == "number" and (.hot.segs | type) == "array" and (has("recent") | not)'
req POST /api/hit "{\"page\":\"suoluomen\",\"work\":\"suoluomen\",\"hot\":false,\"device\":\"$HD2\"}"; HITS=$((HITS+1))
check "关闭热门划线（hot:false）时不返回 hot" '(has("hot") | not) and (.stats.works.suoluomen | has("likes"))'
req POST /api/hit "{\"page\":\"stats\",\"device\":\"$HD3\"}"; HITS=$((HITS+1)); UVDEV=$((UVDEV+1))
check "统计页 hit：含 30 天 series，最后一天为今天" "(.series | length) == 30 and .series[-1].day == \"$TODAY\" and (.series[-1] | has(\"pv\") and has(\"uv\"))"
req POST /api/hit "{\"page\":\"notes\",\"device\":\"$HD3\"}"; HITS=$((HITS+1))
req POST /api/hit "{\"page\":\"no-such-page\",\"device\":\"$HD3\"}"; HITS=$((HITS+1))
check "白名单外的页面（如 404）：返回数据，记为 other" '.views | has("total")'
req POST /api/view "{\"page\":\"404\",\"device\":\"$HD3\"}"; HITS=$((HITS+1))
check "旧接口 POST /api/view 的 404 页不再报 400（记为 other）" '.ok == true'
req POST /api/hit '{"page":"Bad Page!"}'
check "格式无效的页面：不计浏览，仍返回数据" '.views | has("total")'
req POST /api/hit '{"page":"notes"}'; HITS=$((HITS+1))
check "不带 device 也可以（只计 PV）" '.views | has("total")'
req POST /api/hit "{\"page\":\"home\",\"work\":\"no-such-work\",\"device\":\"$HD3\"}"
check "work 不在白名单 -> 404" '.error | type == "string"' 404
req GET /api/hit
check "GET /api/hit -> 405" '.error | type == "string"' 405
req POST /api/hit "{\"page\":\"home\",\"device\":\"$HD3\"}" -H 'Origin: https://evil.example'
check "hit 跨站 Origin -> 403" '.error | type == "string"' 403
req GET /api/views/series
check "GET /api/views/series：30 天" '(.series | length) == 30'
SC=$(curl -s -D - -o /dev/null "$BASE/api/views/series" | tr -d '\r' | awk -F': ' 'tolower($1)=="cache-control"{print $2}')
[ "$SC" = "public, max-age=300" ] && { PASS=$((PASS+1)); echo "  [PASS] series Cache-Control: $SC"; } || { FAIL=$((FAIL+1)); echo "  [FAIL] series Cache-Control: '$SC'"; }
req GET /api/views
check "旧接口 GET /api/views 仍可用（含 series）" 'has("total") and has("pages") and (.series | length) == 30'
LAST_SUMMARY=$(date +%s)
req POST /api/view "{\"page\":\"home\",\"device\":\"$HD1\"}"; HITS=$((HITS+1))
check "旧接口 POST /api/view 仍可用" '.ok == true'

echo "== stats"
req GET /api/stats
check "stats 含 18 部作品" '(.works | length) == 18 and .works["huidao-mingtian"].likes >= 0'
CC=$(curl -s -D - -o /dev/null "$BASE/api/stats" | tr -d '\r' | awk -F': ' 'tolower($1)=="cache-control"{print $2}')
[ "$CC" = "public, max-age=30" ] && { PASS=$((PASS+1)); echo "  [PASS] stats Cache-Control: $CC"; } \
  || { FAIL=$((FAIL+1)); echo "  [FAIL] stats Cache-Control: '$CC'"; }
HDRS=$(curl -s -D - -o /dev/null "$BASE/api/stats" | tr -d '\r')
H_CC=$(printf '%s' "$HDRS" | awk -F': ' 'tolower($1)=="cache-control"{print $2}')
H_AGE=$(printf '%s' "$HDRS" | awk -F': ' 'tolower($1)=="age"||tolower($1)=="x-hb-ttl"{print $1}')
[ "$H_CC" = "public, max-age=30" ] && [ -z "$H_AGE" ] && { PASS=$((PASS+1)); echo "  [PASS] 边缘缓存命中时重建响应头（Cache-Control: ${H_CC}，无 Age / X-HB-TTL）"; } \
  || { FAIL=$((FAIL+1)); echo "  [FAIL] 命中缓存的响应头：cc='$H_CC' extra='$H_AGE'"; }
E_CC=$(curl -s -D - -o /dev/null "$BASE/api/nothing" | tr -d '\r' | awk -F': ' 'tolower($1)=="cache-control"{print $2}')
[ "$E_CC" = "no-store" ] && { PASS=$((PASS+1)); echo "  [PASS] 错误响应 Cache-Control: no-store"; } || { FAIL=$((FAIL+1)); echo "  [FAIL] 错误响应 Cache-Control: '$E_CC'"; }
for path in "/api/comments/recent" "/api/works/huidao-mingtian/comments" "/api/works/huidao-mingtian/marks" "/api/views"; do
  curl -s -o /dev/null "$BASE$path"
  P_CC=$(curl -s -D - -o /dev/null "$BASE$path" | tr -d '\r' | awk -F': ' 'tolower($1)=="cache-control"{print $2}')
  case "$P_CC" in "public, max-age=5"|"public, max-age=30"|"public, max-age=60") PASS=$((PASS+1)); echo "  [PASS] $path 命中缓存后仍是短 TTL：${P_CC}";;
    *) FAIL=$((FAIL+1)); echo "  [FAIL] $path Cache-Control: '$P_CC'";; esac
done

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

echo "== 评论限流：IP 宽松（15 秒 5 条），设备严格"
echo "  （等待 16 秒）"; sleep 16
IPW="dengdai-geduo"; IPOK=y
for i in 1 2 3 4 5; do
  out=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/works/$IPW/comments" -H 'Content-Type: application/json' -H "Origin: $BASE" \
    --data-binary "{\"device\":\"test-ipc-$i-$TS0\",\"name\":\"同网读者\",\"body\":\"同一出口 IP 的第 $i 条\"}")
  [ "$out" = "201" ] || IPOK=n
done
ok_if "同一 IP、不同设备 15 秒内 5 条都能发（不误伤共用出口 IP）" "$IPOK"
req POST /api/works/$IPW/comments "{\"device\":\"test-ipc-6-$TS0\",\"name\":\"同网读者\",\"body\":\"第 6 条\"}"
check "同一 IP 15 秒内第 6 条 -> 429" '.error | test("网络")' 429

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


echo "== 热门划线"
MW="yiqie-ruchang"
TS=$(date +%s)
M1="test-mark-a-$TS"; M2="test-mark-b-$TS"; M3="test-mark-c-$TS"
req POST /api/works/$MW/marks "{\"device\":\"$M1\",\"p\":5,\"on\":true}"
check "划线计数 +1" '.on == true and .p == 5 and .n == 1'
req POST /api/works/$MW/marks "{\"device\":\"$M1\",\"p\":5,\"on\":true}"
check "同一设备同一段重复划线幂等（仍为 1）" '.n == 1'
req POST /api/works/$MW/marks "{\"device\":\"$M2\",\"p\":5,\"on\":true}"
check "另一设备 -> 2" '.n == 2'
req POST /api/works/$MW/marks "{\"device\":\"$M3\",\"p\":[5,7,9],\"on\":true}"
check "跨段划线（数组）" '.on == true and (.items | map(.p)) == [5,7,9] and (.items | map(.n)) == [3,1,1]'
req POST /api/works/$MW/marks "{\"device\":\"$M1\",\"p\":[7,9,9],\"on\":true}"
check "数组去重，第 7、9 段 -> 2" '(.items | map([.p,.n])) == [[7,2],[9,2]]'
req POST /api/works/$MW/marks "{\"device\":\"$M2\",\"p\":12,\"on\":true}"
check "第 12 段只有 1 人" '.n == 1'
par /api/works/$MW/marks "{\"device\":\"$M2\",\"p\":20,\"on\":true}"
check "并行 10 次同一段划线，计数为 1" 'length == 10 and all(.[]; .n == 1)'
req GET /api/works/$MW/marks
check "热门段落：n>=2，按 n 降序" '.top[0] == {"p":5,"n":3} and (.top | map(.p) | sort) == [5,7,9] and all(.top[]; .n >= 2)'
MC=$(curl -s -D - -o /dev/null "$BASE/api/works/$MW/marks" | tr -d '\r' | awk -F': ' 'tolower($1)=="cache-control"{print $2}')
[ "$MC" = "public, max-age=60" ] && { PASS=$((PASS+1)); echo "  [PASS] marks Cache-Control: $MC"; } \
  || { FAIL=$((FAIL+1)); echo "  [FAIL] marks Cache-Control: '$MC'"; }
req POST /api/works/$MW/marks "{\"device\":\"$M3\",\"p\":5,\"on\":false}"
check "删光该段划线 -> 计数 -1" '.on == false and .n == 2'
req POST /api/works/$MW/marks "{\"device\":\"$M3\",\"p\":5,\"on\":false}"
check "重复取消幂等（仍为 2）" '.n == 2'
req POST /api/works/$MW/marks "{\"device\":\"$M2\",\"p\":12,\"on\":false}"
check "计数归零（行被删除，返回 0）" '.n == 0'
req POST /api/works/$MW/marks "{\"device\":\"$M2\",\"p\":12,\"on\":false}"
check "未划过的段取消 -> 仍为 0" '.n == 0'
req GET /api/works/$MW/marks
check "GET 命中 60 秒缓存（仍是上一次结果）" '.top[0] == {"p":5,"n":3}'
req POST /api/works/$MW/marks "{\"device\":\"$M1\",\"p\":0,\"on\":true}"
check "p=0 -> 400" '.error | type == "string"' 400
req POST /api/works/$MW/marks "{\"device\":\"$M1\",\"p\":1.5,\"on\":true}"
check "p 非整数 -> 400" '.error | type == "string"' 400
req POST /api/works/$MW/marks "{\"device\":\"$M1\",\"p\":\"3\",\"on\":true}"
check "p 为字符串 -> 400" '.error | type == "string"' 400
req POST /api/works/$MW/marks "{\"device\":\"$M1\",\"p\":99999,\"on\":true}"
check "p 超出范围 -> 400" '.error | type == "string"' 400
req POST /api/works/$MW/marks "{\"device\":\"$M1\",\"p\":[],\"on\":true}"
check "空数组 -> 400" '.error | type == "string"' 400
P31=$(seq 1 31 | paste -sd, -)
req POST /api/works/$MW/marks "{\"device\":\"$M1\",\"p\":[$P31],\"on\":true}"
check "一次超过 30 段 -> 400" '.error | type == "string"' 400
req POST /api/works/$MW/marks "{\"device\":\"$M1\",\"p\":5}"
check "缺少 on -> 400" '.error | type == "string"' 400
req POST /api/works/no-such-work/marks "{\"device\":\"$M1\",\"p\":5,\"on\":true}"
check "非法作品 id -> 404" '.error | type == "string"' 404
req GET /api/works/no-such-work/marks
check "非法作品 id GET -> 404" '.error | type == "string"' 404
req DELETE /api/works/$MW/marks
check "错误方法 -> 405" '.error | type == "string"' 405
req POST /api/works/$MW/marks "{\"device\":\"$M1\",\"p\":5,\"on\":true}" -H 'Origin: https://evil.example'
check "跨站 Origin -> 403" '.error | type == "string"' 403

echo "== 划线限流（同一设备每天 300 次，按段计）"
MR="test-mark-r-$TS"; MW2="gongzuo"
P30=$(seq 1 30 | paste -sd, -)
RL_OK=y
for i in $(seq 1 10); do
  ON=$([ $((i % 2)) -eq 1 ] && echo true || echo false)
  out=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/works/$MW2/marks" -H 'Content-Type: application/json' \
    -H "Origin: $BASE" --data-binary "{\"device\":\"$MR\",\"p\":[$P30],\"on\":$ON}")
  [ "$out" = "200" ] || RL_OK=n
done
[ "$RL_OK" = y ] && { PASS=$((PASS+1)); echo "  [PASS] 前 300 次（10 × 30 段）全部成功"; } \
  || { FAIL=$((FAIL+1)); echo "  [FAIL] 前 300 次中有失败"; }
req POST /api/works/$MW2/marks "{\"device\":\"$MR\",\"p\":3,\"on\":true}"
check "第 301 次 -> 429" '.error | test("上限")' 429
req POST /api/works/$MW2/marks "{\"device\":\"$M1\",\"p\":3,\"on\":true}"
check "其他设备不受影响" '.n == 1'
req GET /api/works/$MW2/marks
check "超限请求没有写入（第 3 段只有 1 人，不在热门里）" '.top == []'

echo "== 片段级热门划线 POST/GET /api/works/:id/hot"
HW="shuzi-shibolie"
hp() { # hp WORK DEVICE ITEMS_JSON
  req POST /api/works/$1/hot "{\"device\":\"$2\",\"items\":$3}"
}
covof() { db "SELECT cov, maxn FROM hot_cov WHERE work='$1' AND p=$2" | jq -c '.[0] // {} | {cov: (.cov // "[]" | fromjson), maxn: (.maxn // 0)}'; }
H1="test-hot-1-$TS0"; H2="test-hot-2-$TS0"; H3="test-hot-3-$TS0"; H4="test-hot-4-$TS0"
hp $HW $H1 '[{"p":3,"segs":[[0,10]]}]'
check "上传区间并集" '.ok == true and .done == [3] and .failed == []'
hp $HW $H2 '[{"p":3,"segs":[[0,10]]}]'
hp $HW $H3 '[{"p":3,"segs":[[5,15]]}]'
hp $HW $H4 '[{"p":3,"segs":[[5,8]]},{"p":4,"segs":[[0,4]]}]'
check "一次多段" '.ok == true and .done == [3,4]'
BODY=$(covof $HW 3); STATUS=200
check "覆盖计数游程编码正确" '.cov == [[0,5,2],[5,8,4],[8,10,3],[10,15,1]] and .maxn == 4'
echo "  -- 并集差分：H1 改为 [[0,3],[2,6]]（规范化为 [[0,6]]）"
hp $HW $H1 '[{"p":3,"segs":[[2,6],[0,3]]}]'
check "改动区间" '.done == [3]'
BODY=$(db "SELECT segs FROM mark_ranges WHERE work='$HW' AND p=3 AND actor=(SELECT actor FROM mark_ranges WHERE work='$HW' AND p=3 AND segs='[[0,6]]' LIMIT 1)"); STATUS=200
check "服务器存的是规范化后的并集 [[0,6]]" '.[0].segs == "[[0,6]]"'
BODY=$(covof $HW 3); STATUS=200
check "差分后覆盖计数：旧区间 −1，新区间 +1" '.cov == [[0,5,2],[5,6,4],[6,8,3],[8,10,2],[10,15,1]] and .maxn == 4'
hp $HW $H1 '[{"p":3,"segs":[[0,6]]}]'
check "重复上传相同并集：无变化，仍算成功" '.ok == true and .done == [3]'
echo "  -- 撤销：H4 删光第 4 段、改第 3 段为空"
hp $HW $H4 '[{"p":3,"segs":[]},{"p":4,"segs":[]}]'
check "撤销（空数组）" '.ok == true and .done == [3,4]'
BODY=$(db "SELECT COUNT(*) AS c FROM mark_ranges WHERE work='$HW' AND p IN (3,4)"); STATUS=200
check "撤销后 mark_ranges 行被删除（剩 H1-H3 的第 3 段）" '.[0].c == 3'
BODY=$(covof $HW 3); STATUS=200
check "撤销后覆盖计数（相邻同值游程合并）" '.cov == [[0,5,2],[5,6,3],[6,10,2],[10,15,1]] and .maxn == 3'
BODY=$(covof $HW 4); STATUS=200
check "整段撤销后计数为空" '.cov == [] and .maxn == 0'
BODY=$(db "SELECT n FROM work_highlighters WHERE work='$HW'"); STATUS=200
check "有划线读者数 = 4（首次划线 +1，撤销不减）" '.[0].n == 4'
req GET /api/works/$HW/hot
check "GET hot：阈值 3，只有 [5,6) 达到 3 人（短于 2 字不显示）" '.threshold == 3 and .readers == 4 and .segs == []'
HCC=$(curl -s -D - -o /dev/null "$BASE/api/works/$HW/hot" | tr -d '\r' | awk -F': ' 'tolower($1)=="cache-control"{print $2}')
[ "$HCC" = "public, max-age=60" ] && { PASS=$((PASS+1)); echo "  [PASS] hot Cache-Control: $HCC"; } || { FAIL=$((FAIL+1)); echo "  [FAIL] hot Cache-Control: '$HCC'"; }

echo "  -- 阈值与显示（新作品，写完再 GET）"
TW="taiyang-de-zangli"
for d in a b c; do hp $TW "test-thr-$d-$TS0" '[{"p":2,"segs":[[10,30]]},{"p":9,"segs":[[0,5]]}]' >/dev/null; done
hp $TW "test-thr-d-$TS0" '[{"p":2,"segs":[[12,20]]},{"p":9,"segs":[[0,5]]}]'
hp $TW "test-thr-e-$TS0" '[{"p":7,"segs":[[0,9]]}]'
hp $TW "test-thr-f-$TS0" '[{"p":7,"segs":[[0,9]]}]'
req GET /api/works/$TW/hot
check "n ≥ 3 的片段显示，相接的游程合并、n 取最大；2 人的不显示" '.threshold == 3 and .readers == 6 and .segs == [{"p":2,"s":10,"e":30,"n":4},{"p":9,"s":0,"e":5,"n":4}]'
req POST /api/hit "{\"page\":\"$TW\",\"device\":\"$HD1\"}"; HITS=$((HITS+1)); LAST_SUMMARY=$(date +%s)
check "hit 返回的 hot 与 GET 一致（共用缓存）" '.hot.segs == [{"p":2,"s":10,"e":30,"n":4},{"p":9,"s":0,"e":5,"n":4}] and .hot.readers == 6'

echo "  -- 按比例的阈值：160 位读者 → ceil(0.02 × 160) = 4"
RW="qidian"
for i in $(seq 1 153); do
  curl -s -o /dev/null -X POST "$BASE/api/works/$RW/hot" -H 'Content-Type: application/json' -H "Origin: $BASE" \
    --data-binary "{\"device\":\"test-ratio-$i-$TS0\",\"items\":[{\"p\":1,\"segs\":[[0,2]]}]}" &
  [ $((i % 25)) -eq 0 ] && wait
done; wait
sleep 2   # 并发冲突兜底的重算在 waitUntil 里异步完成
for i in 1 2 3; do hp $RW "test-ratio-x$i-$TS0" '[{"p":2,"segs":[[0,10]]}]' >/dev/null; done
for i in 1 2 3 4; do hp $RW "test-ratio-y$i-$TS0" '[{"p":3,"segs":[[0,10]]}]' >/dev/null; done
req GET /api/works/$RW/hot
check "readers=160，阈值 4：3 人的第 2 段不显示，4 人的第 3 段显示" '.readers == 160 and .threshold == 4 and .segs == [{"p":1,"s":0,"e":2,"n":153},{"p":3,"s":0,"e":10,"n":4}]'

echo "  -- 每部作品最多 50 个片段（取 n 最高的）"
LW="mr-man"
I30=$(seq 1 30 | awk '{printf "%s{\"p\":%d,\"segs\":[[0,6]]}", (NR>1?",":""), $1}')
I51=$(seq 31 51 | awk '{printf "%s{\"p\":%d,\"segs\":[[0,6]]}", (NR>1?",":""), $1}')
I50=$(seq 31 50 | awk '{printf "%s{\"p\":%d,\"segs\":[[0,6]]}", (NR>1?",":""), $1}')
for d in 1 2 3; do hp $LW "test-top-$d-$TS0" "[$I30]" >/dev/null; hp $LW "test-top-$d-$TS0" "[$I51]" >/dev/null; done
hp $LW "test-top-4-$TS0" "[$I30]" >/dev/null; hp $LW "test-top-4-$TS0" "[$I50]" >/dev/null
req GET /api/works/$LW/hot
check "51 段达到阈值，只返回 n 最高的 50 段（n=3 的第 51 段被截掉），按段落排序" '(.segs | length) == 50 and all(.segs[]; .n == 4) and ([.segs[].p] == [range(1;51)])'

echo "  -- 并发"
CW="xinming-de-zangli"
CD="test-conc-same-$TS0"
par /api/works/$CW/hot "{\"device\":\"$CD\",\"items\":[{\"p\":5,\"segs\":[[0,20]]}]}"
check "同一设备并行 10 次相同内容：全部成功" 'length == 10 and all(.[]; .ok == true and .done == [5])'
BODY=$(covof $CW 5); STATUS=200
check "并行后计数仍为 1（没有重复累加）" '.cov == [[0,20,1]] and .maxn == 1'
BODY=$(db "SELECT n FROM work_highlighters WHERE work='$CW'"); STATUS=200
check "并行首次划线，读者数只 +1" '.[0].n == 1'
rm -f "$TMPD"/r.*
for i in $(seq 1 10); do
  curl -s -X POST "$BASE/api/works/$CW/hot" -H 'Content-Type: application/json' -H "Origin: $BASE" \
    --data-binary "{\"device\":\"test-conc-$i-$TS0\",\"items\":[{\"p\":6,\"segs\":[[$i,$((i+10))]]},{\"p\":5,\"segs\":[[0,$((i*2))]]}]}" > "$TMPD/r.$i" &
done; wait
sleep 2
BODY=$(cat "$TMPD"/r.* | jq -s -c '.'); STATUS=200
echo "  并行 10 台设备 -> $(printf '%s' "$BODY" | head -c 200)"
check "10 台设备并行写同两段：全部提交（冲突自动重试）" 'length == 10 and all(.[]; .ok == true and .done == [5,6])'
EXP6=$(db "SELECT segs FROM mark_ranges WHERE work='$CW' AND p=6" | jq -c '[.[].segs | fromjson | .[]] | [.[] | [.[0], 1], [.[1], -1]] | group_by(.[0]) | map([.[0][0], (map(.[1]) | add)]) | sort_by(.[0]) | reduce .[] as $e ({c:0, out:[], prev:null}; (if .prev != null and .c > 0 then .out += [[.prev, $e[0], .c]] else . end) | .c += $e[1] | .prev = $e[0]) | .out')
BODY=$(jq -n -c --argjson a "$(covof $CW 6)" --argjson b "$EXP6" '{got: $a.cov, want: $b}'); STATUS=200
check "第 6 段覆盖计数 = 从 mark_ranges 全量重算的结果" '.got == .want and (.got | length) > 0'
BODY=$(covof $CW 6); STATUS=200
check "第 6 段最大覆盖 10（[10,11) 被 10 人覆盖）" '.maxn == 10 and (.cov | map(select(.[2] == 10)) == [[10,11,10]])'
BODY=$(covof $CW 5); STATUS=200
check "第 5 段：11 人，覆盖计数正确" '.cov[0] == [0,2,11] and .maxn == 11'
BODY=$(db "SELECT n FROM work_highlighters WHERE work='$CW'"); STATUS=200
check "读者数 = 11" '.[0].n == 11'

echo "  -- 自愈：maxn 跨越 10 的倍数时从 mark_ranges 重算该段"
for i in $(seq 1 9); do hp $CW "test-heal-$i-$TS0" '[{"p":8,"segs":[[0,10]]}]' >/dev/null; done
db "UPDATE hot_cov SET cov='[[0,10,9],[10,20,5]]' WHERE work='$CW' AND p=8" >/dev/null
hp $CW "test-heal-10-$TS0" '[{"p":8,"segs":[[0,10]]}]'
sleep 1
BODY=$(covof $CW 8); STATUS=200
check "人为写坏的计数在 maxn 9→10 时被重算修复" '.cov == [[0,10,10]] and .maxn == 10'

echo "  -- 非法请求"
VD="test-hot-v-$TS0"
hp $HW $VD '[{"p":1,"segs":[[5,5]]}]';    check "s = e -> 400" '.error | type == "string"' 400
hp $HW $VD '[{"p":1,"segs":[[6,5]]}]';    check "s > e -> 400" '.error | type == "string"' 400
hp $HW $VD '[{"p":1,"segs":[[-1,5]]}]';   check "s < 0 -> 400" '.error | type == "string"' 400
hp $HW $VD '[{"p":1,"segs":[[0,5001]]}]'; check "e > 5000 -> 400" '.error | type == "string"' 400
hp $HW $VD '[{"p":1,"segs":[[0,5000]]}]'; check "e = 5000 合法" '.ok == true'
hp $HW $VD '[{"p":1,"segs":[[0.5,3]]}]';  check "非整数 -> 400" '.error | type == "string"' 400
hp $HW $VD '[{"p":1,"segs":[["0",3]]}]';  check "字符串偏移 -> 400" '.error | type == "string"' 400
hp $HW $VD '[{"p":1,"segs":[[0,3,4]]}]';  check "区间不是二元组 -> 400" '.error | type == "string"' 400
S21=$(seq 0 20 | awk '{printf "%s[%d,%d]", (NR>1?",":""), $1*10, $1*10+5}')
hp $HW $VD "[{\"p\":1,\"segs\":[$S21]}]"; check "一段超过 20 个区间 -> 400" '.error | type == "string"' 400
S20=$(seq 0 19 | awk '{printf "%s[%d,%d]", (NR>1?",":""), $1*10, $1*10+5}')
hp $HW $VD "[{\"p\":1,\"segs\":[$S20]}]"; check "20 个区间合法" '.ok == true'
hp $HW $VD '[{"p":1,"segs":"0-5"}]';      check "segs 不是数组 -> 400" '.error | type == "string"' 400
hp $HW $VD '[{"p":0,"segs":[[0,5]]}]';    check "p = 0 -> 400" '.error | type == "string"' 400
hp $HW $VD '[{"p":5001,"segs":[[0,5]]}]'; check "p 超出范围 -> 400" '.error | type == "string"' 400
hp $HW $VD '[{"p":2,"segs":[[0,5]]},{"p":2,"segs":[]}]'; check "同一段重复 -> 400" '.error | type == "string"' 400
hp $HW $VD '[]';                          check "items 为空 -> 400" '.error | type == "string"' 400
hp $HW $VD "[$I30,{\"p\":99,\"segs\":[]}]"; check "超过 30 段 -> 400" '.error | type == "string"' 400
req POST /api/works/$HW/hot "{\"device\":\"$VD\"}"; check "缺少 items -> 400" '.error | type == "string"' 400
req POST /api/works/$HW/hot '{"device":"bad","items":[{"p":1,"segs":[]}]}'; check "device 无效 -> 400" '.error | type == "string"' 400
req POST /api/works/no-such-work/hot "{\"device\":\"$VD\",\"items\":[{\"p\":1,\"segs\":[]}]}"; check "作品不存在 -> 404" '.error | type == "string"' 404
req GET /api/works/no-such-work/hot; check "GET 作品不存在 -> 404" '.error | type == "string"' 404
req DELETE /api/works/$HW/hot; check "错误方法 -> 405" '.error | type == "string"' 405
req POST /api/works/$HW/hot "{\"device\":\"$VD\",\"items\":[{\"p\":1,\"segs\":[]}]}" -H 'Origin: https://evil.example'; check "跨站 Origin -> 403" '.error | type == "string"' 403
req POST /api/works/$HW/hot "{\"device\":\"$VD\",\"items\":[{\"p\":1,\"segs\":[[0,5]],\"note\":\"秘密\"}]}"
BODY=$(db "SELECT COUNT(*) AS c FROM mark_ranges WHERE segs LIKE '%秘密%'"); STATUS=200
check "多余字段（如笔记）被忽略，不入库" '.[0].c == 0'

echo "  -- 限流（与旧接口共用：同一设备每天 300 段次）"
RD="test-hot-r-$TS0"; RW2="jingyinqu"
RL_OK=y
for i in $(seq 1 10); do
  SEG=$([ $((i % 2)) -eq 1 ] && echo '[[0,5]]' || echo '[]')
  ITEMS=$(seq 1 30 | awk -v s="$SEG" '{printf "%s{\"p\":%d,\"segs\":%s}", (NR>1?",":""), $1, s}')
  out=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/works/$RW2/hot" -H 'Content-Type: application/json' \
    -H "Origin: $BASE" --data-binary "{\"device\":\"$RD\",\"items\":[$ITEMS]}")
  [ "$out" = "200" ] || RL_OK=n
done
ok_if "前 300 段次（10 × 30 段）全部成功" "$RL_OK"
hp $RW2 $RD '[{"p":40,"segs":[[0,5]]}]'
check "第 301 段次 -> 429" '.error | test("上限")' 429
BODY=$(db "SELECT COUNT(*) AS c FROM mark_ranges WHERE work='$RW2' AND p=40"); STATUS=200
check "超限请求没有写入" '.[0].c == 0'
hp $RW2 "test-hot-r2-$TS0" '[{"p":40,"segs":[[0,5]]}]'
check "其他设备不受影响" '.ok == true'

echo "== 浏览量计数核对（等汇总缓存过期）"
WAIT=$(( 62 - ($(date +%s) - LAST_SUMMARY) )); [ $WAIT -gt 0 ] && { echo "  （等待 $WAIT 秒）"; sleep $WAIT; }
# 用旧接口 POST /api/view 记一次浏览（它不读、不写汇总缓存），等内存计数按时写入（最多 FLUSH_MS = 20 秒）
req POST /api/view "{\"page\":\"favorites\",\"device\":\"$HD1\"}"; HITS=$((HITS+1))
sleep 22
[ "$(TZ=Asia/Shanghai date +%F)" = "$TODAY" ] || echo "  （注意：测试期间跨过了北京时间零点，「今日」相关断言会失败，请重跑）"
V1=$(db "SELECT (SELECT IFNULL(SUM(n),0) FROM view_totals) AS t, (SELECT IFNULL(MAX(n),0) FROM views WHERE page='*' AND day='$TODAY') AS s, (SELECT IFNULL(MAX(n),0) FROM uv WHERE day='$TODAY') AS u, (SELECT IFNULL(MAX(n),0) FROM view_totals WHERE page='notes') AS notes")
echo "  终点：${V1}（期间有效浏览 $HITS 次，新设备 $UVDEV 台）"
# 紧接着读一次（这次的计数要 20 秒后才写入，不影响本次读取）：汇总缓存已过期，应与数据库完全一致
req POST /api/hit "{\"page\":\"home\",\"device\":\"$HD1\"}"
HITB="$BODY"
BODY=$(jq -n -c --argjson a "$V0" --argjson b "$V1" '{dt: ($b[0].t - $a[0].t), ds: ($b[0].s - $a[0].s), du: ($b[0].u - $a[0].u), dn: ($b[0].notes - $a[0].notes)}'); STATUS=200
check "累计 +${HITS}、今日 PV +${HITS}、今日 UV +${UVDEV}、notes 页 +3" ".dt == $HITS and .ds == $HITS and .du == $UVDEV and .dn == 3"
BODY=$(db "SELECT (SELECT COUNT(*) FROM (SELECT v.page FROM view_totals v LEFT JOIN (SELECT page, SUM(n) AS s FROM views WHERE page <> '*' GROUP BY page) x ON x.page = v.page WHERE x.s IS NOT v.n)) AS bad_pages, (SELECT COUNT(*) FROM (SELECT a.day FROM views a LEFT JOIN (SELECT day, SUM(n) AS s FROM views WHERE page <> '*' GROUP BY day) x ON x.day = a.day WHERE a.page = '*' AND x.s IS NOT a.n)) AS bad_days"); STATUS=200
check "汇总与明细一致：view_totals = 各页 SUM，'*' 行 = 各天 SUM" '.[0].bad_pages == 0 and .[0].bad_days == 0'
BODY=$(jq -n -c --argjson h "$HITB" --argjson d "$V1" '{ok: ($h.views.total == $d[0].t and $h.views.today.pv == $d[0].s and $h.views.today.uv == $d[0].u and $h.views.pages.notes == $d[0].notes)}'); STATUS=200
check "hit 返回的浏览量与数据库一致" '.ok == true'

echo "== stats"
req GET /api/stats
check "stats 结构" '.works["huidao-mingtian"] | has("likes") and has("favs") and has("comments")'
check "增量计数与实际一致（首次请求已超过 30 秒缓存）" '.works["huidao-mingtian"] == {"likes":1,"favs":0,"comments":0} and .works["zhuan-rengong"] == {"likes":0,"favs":0,"comments":0}'
rm -rf "$TMPD"

echo "== 写接口 IP 日上限（点赞 + 收藏 + 评论点赞 + 划线合计 2000 次）"
db "UPDATE ratelimit SET n = 2000 WHERE key LIKE 'ipw:%'" >/dev/null
req POST /api/works/qidian/like "{\"device\":\"test-ipw-$TS0\",\"on\":true}"
check "超过 IP 日上限的点赞 -> 429" '.error | test("网络")' 429
req POST /api/works/qidian/hot "{\"device\":\"test-ipw-$TS0\",\"items\":[{\"p\":1,\"segs\":[[0,3]]}]}"
check "超过 IP 日上限的划线同步 -> 429" '.error | test("网络")' 429
BODY=$(db "SELECT COUNT(*) AS c FROM reactions WHERE work='qidian'"); STATUS=200
check "超限的点赞没有写入" '.[0].c == 0'
db "UPDATE ratelimit SET n = 0 WHERE key LIKE 'ipw:%'" >/dev/null
req POST /api/works/qidian/like "{\"device\":\"test-ipw-$TS0\",\"on\":false}"
check "恢复后正常" '.on == false'

echo "== /api/hit 每 IP 每分钟 120 次（内存计数，不写 D1）"
CODES=$(for i in $(seq 1 130); do curl -s -o /dev/null -w '%{http_code}\n' -X POST "$BASE/api/hit" -H 'Content-Type: application/json' -H "Origin: $BASE" --data-binary '{"page":"Bad Page!"}'; done | sort | uniq -c | tr '\n' ' ')
echo "  130 次：$CODES"
case "$CODES" in *429*) ok_if "超过每分钟上限后返回 429" y;; *) ok_if "超过每分钟上限后返回 429" n "$CODES";; esac

echo
echo "结果：$PASS 通过，$FAIL 失败"
[ "$FAIL" -eq 0 ]
