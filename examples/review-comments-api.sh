#!/usr/bin/env bash
# 逐词区间复核意见完整调用示例
# （创建 → 列表/相交字幕 → 乐观锁拒绝 → 关闭 → 锁定不失效/改文本转待复核 →
#   重开 → 重排拆并自动转待复核并按词区间显示在新字幕旁 → 逐词改时联动 →
#   重新导入后旧意见仅历史、不可关闭 → 新代次新建）。
# 依赖：bash + curl + python3（仅用于解析 JSON）。
#
# 用法：
#   bash examples/review-comments-api.sh [BASE_URL]
# 例如：bash examples/review-comments-api.sh http://localhost:3000
set -euo pipefail

BASE="${1:-http://localhost:3000}"

req() {
  local method="$1"; local path="$2"; local body="${3:-}"
  if [ -n "$body" ]; then
    curl -s -w '\n%{http_code}' -X "$method" "$BASE$path" \
      -H 'Content-Type: application/json' -d "$body"
  else
    curl -s -w '\n%{http_code}' -X "$method" "$BASE$path"
  fi
}
body_of() { sed '$d'; }
code_of() { tail -1; }
jget() { python3 -c 'import json,sys; d=json.load(sys.stdin);
ks=sys.argv[1].split("."); v=d
for k in ks: v=v[int(k)] if k.isdigit() else v[k]
print(v)' "$1"; }

echo "=== 0. 新建项目并排版（4 词 / 切点 1500 → 两条字幕：词0-1、词2-3） ==="
WORDS='{"name":"复核意见 API 示例","words":[
  {"text":"你好","start_ms":0,"end_ms":900},
  {"text":"世界","start_ms":950,"end_ms":1400},
  {"text":"欢迎","start_ms":1600,"end_ms":2400},
  {"text":"光临","start_ms":2450,"end_ms":3300}
],"cuts":[1500],"rules":{"max_chars":30,"min_duration_ms":200,"max_cps":20}}'
out="$(req POST /api/projects "$WORDS")"
PID="$(echo "$out" | body_of | jget id)"
echo "项目 id=$PID，导入代次 import_version=1"
out="$(req POST "/api/projects/$PID/layout" '{"sub_version":0}')"
SID_A="$(echo "$out" | body_of | jget subtitles.0.id)"
SID_B="$(echo "$out" | body_of | jget subtitles.1.id)"
echo "排版完成：字幕 $SID_A（词0-1）/ $SID_B（词2-3），sub_version=1"

echo
echo "=== 1. 创建复核意见：携带 sub_version 与起止词序（区间 [1,2] 横跨两条字幕） ==="
out="$(req POST "/api/projects/$PID/review-comments" \
  '{"sub_version":1,"word_start":1,"word_end":2,"text":"切点两侧词段疑似错位","note":"校对者甲"}')"
echo "HTTP $(echo "$out" | code_of)：status=$(echo "$out" | body_of | jget status) \
version=$(echo "$out" | body_of | jget version) import_version=$(echo "$out" | body_of | jget import_version)"
CID="$(echo "$out" | body_of | jget id)"
echo "意见 id=$CID；词段：$(echo "$out" | body_of | python3 -c '
import json,sys
d=json.load(sys.stdin)
print(" / ".join("%s(%s-%sms)" % (w["text"], w["start_ms"], w["end_ms"]) for w in d["word_segment"]))')"
echo "相交字幕 ID：$(echo "$out" | body_of | python3 -c '
import json,sys
print(", ".join(str(s["id"]) for s in json.load(sys.stdin)["intersecting_subtitles"]))')"

echo
echo "=== 2. 形状非法 / sub_version 过期 / 词区间越界 均被拒绝且不修改 ==="
out="$(req POST "/api/projects/$PID/review-comments" \
  '{"sub_version":1,"word_start":2,"word_end":1,"text":"区间反了"}')"
echo "word_start>word_end → HTTP $(echo "$out" | code_of)"
out="$(req POST "/api/projects/$PID/review-comments" \
  '{"sub_version":0,"word_start":0,"word_end":0,"text":"基于旧版本"}')"
echo "sub_version 过期 → HTTP $(echo "$out" | code_of)（$(echo "$out" | body_of | jget error)）"
out="$(req POST "/api/projects/$PID/review-comments" \
  '{"sub_version":1,"word_start":0,"word_end":99,"text":"越界"}')"
echo "词区间越界 → HTTP $(echo "$out" | code_of)"

echo
echo "=== 3. 列表：返回状态计数、每条意见的词段与相交字幕；单条查询 ==="
out="$(req GET "/api/projects/$PID/review-comments")"
echo "open=$(echo "$out" | body_of | jget counts.open) \
resolved=$(echo "$out" | body_of | jget counts.resolved) \
review=$(echo "$out" | body_of | jget counts.review) \
history=$(echo "$out" | body_of | jget counts.history)"
req GET "/api/projects/$PID/review-comments/$CID" >/dev/null && echo "单条 GET 200"

echo
echo "=== 4. 关闭：须携带当前意见版本；过期返回当前值且不修改；关闭保存相交字幕快照 ==="
out="$(req POST "/api/projects/$PID/review-comments/$CID/close" '{"version":99}')"
echo "过期 version=99 → HTTP $(echo "$out" | code_of)（当前仍 v$(echo "$out" | body_of | jget current.version)）"
out="$(req POST "/api/projects/$PID/review-comments/$CID/close" '{"version":1}')"
echo "正确关闭 → HTTP $(echo "$out" | code_of) \
status=$(echo "$out" | body_of | jget comment.status) \
version=$(echo "$out" | body_of | jget comment.version)"
echo "关闭快照：$(echo "$out" | body_of | python3 -c '
import json,sys
for s in json.load(sys.stdin)["comment"]["close_snapshot"]:
    print("字幕#%s「%s」[%s,%s] 词%s-%s" % (
        s["subtitle_id"], s["text"], s["start_ms"], s["end_ms"], s["word_start"], s["word_end"]))')"
out="$(req POST "/api/projects/$PID/review-comments/$CID/close" '{"version":2}')"
echo "重复关闭 → HTTP $(echo "$out" | code_of)（$(echo "$out" | body_of | jget rejected)）"

echo
echo "=== 5. 仅锁定切换不触发待复核；随后改文本 → 自动转 review ==="
out="$(req PATCH "/api/projects/$PID/subtitles/$SID_A" '{"version":1,"locked":true}')"
echo "锁定字幕 $SID_A → HTTP $(echo "$out" | code_of)"
out="$(req GET "/api/projects/$PID/review-comments")"
echo "仅锁定后意见状态：$(echo "$out" | body_of | python3 -c '
import json,sys
print(json.load(sys.stdin)["comments"][0]["status"])')（仍 resolved）"
# 行版本锁定切换后为 2；改文本（时间不变，用原值）
out="$(req PATCH "/api/projects/$PID/subtitles/$SID_A" \
  '{"version":2,"text":"你好世界呀","start_ms":0,"end_ms":1400}')"
echo "改相交字幕文本 → HTTP $(echo "$out" | code_of)"
out="$(req GET "/api/projects/$PID/review-comments")"
echo "意见状态变为：$(echo "$out" | body_of | python3 -c '
import json,sys
print(json.load(sys.stdin)["comments"][0]["status"])')（待复核，直到再次显式关闭）"
CV="$(echo "$out" | body_of | python3 -c 'import json,sys
print(json.load(sys.stdin)["comments"][0]["version"])')"
out="$(req POST "/api/projects/$PID/review-comments/$CID/close" "{\"version\":$CV}")"
echo "再次显式关闭 → HTTP $(echo "$out" | code_of)，快照文本刷新为「$(echo "$out" | body_of | jget comment.close_snapshot.0.text)」"

echo
echo "=== 6. 重新打开（resolved/review → open），版本 +1 ==="
CV="$(echo "$out" | body_of | jget comment.version)"
out="$(req POST "/api/projects/$PID/review-comments/$CID/reopen" "{\"version\":$CV}")"
echo "重开 → HTTP $(echo "$out" | code_of)，status=$(echo "$out" | body_of | jget comment.status) \
version=$(echo "$out" | body_of | jget comment.version)"

echo
echo "=== 7. 收紧后放宽重排（拆并/字幕行更替）：意见按词区间显示在新字幕旁，关闭后自动转待复核 ==="
# 先收紧为逐词排版（锁定行保留，未锁定区间细分），意见重开着可直接关闭
req PUT "/api/projects/$PID/rules" \
  '{"version":1,"max_chars":2,"min_duration_ms":200,"max_cps":5}' >/dev/null
req POST "/api/projects/$PID/layout" '{"sub_version":3}' >/dev/null
# 此刻意见为 open（第 6 步重开）：先关闭，再放宽重排观察自动转待复核
req POST "/api/projects/$PID/review-comments/$CID/close" '{"version":4}' >/dev/null
req PUT "/api/projects/$PID/rules" \
  '{"version":2,"max_chars":40,"min_duration_ms":200,"max_cps":40}' >/dev/null
out="$(req POST "/api/projects/$PID/layout" '{"sub_version":4}')"
echo "放宽重排后行数：$(echo "$out" | body_of | python3 -c 'import json,sys
print(len(json.load(sys.stdin)["subtitles"]))')（锁定行保留，其余细分行被合并为新 ID 行）"
out="$(req GET "/api/projects/$PID/review-comments")"
echo "意见状态：$(echo "$out" | body_of | python3 -c '
import json,sys
c=json.load(sys.stdin)["comments"][0]
print(c["status"])
print("仍相交的当前字幕：" + ", ".join("#%s「%s」词%s-%s" % (
    s["id"], s["text"], s["word_start"], s["word_end"]) for s in c["intersecting_subtitles"]))')"

echo
echo "=== 8. 逐词时间修正确认：相交字幕时间变化 → 已关闭意见自动转待复核 ==="
# 当前意见为 review；重新关闭后提交词修正（词2 开始 1600 → 1620，未锁定合并行将重定时）
CV="$(echo "$out" | body_of | python3 -c 'import json,sys
print(json.load(sys.stdin)["comments"][0]["version"])')"
req POST "/api/projects/$PID/review-comments/$CID/close" "{\"version\":$CV}" >/dev/null
SV="$(req GET "/api/projects/$PID" | body_of | jget sub_version)"
out="$(req POST "/api/projects/$PID/word-revisions" \
  "{\"sub_version\":$SV,\"items\":[{\"word_idx\":2,\"start_ms\":1620,\"end_ms\":2400}]}")"
WRID="$(echo "$out" | body_of | jget id)"
req POST "/api/projects/$PID/word-revisions/$WRID/confirm" >/dev/null
out="$(req GET "/api/projects/$PID/review-comments")"
echo "词修正确认后意见状态：$(echo "$out" | body_of | python3 -c '
import json,sys
print(json.load(sys.stdin)["comments"][0]["status"])')"

echo
echo "=== 9. 重新导入：导入代次 +1，旧意见仅历史查看（不附新词段、不可关闭/重开） ==="
out="$(req POST "/api/projects/$PID/import" '{"force":true,"words":[
  {"text":"你好","start_ms":0,"end_ms":900},
  {"text":"世界","start_ms":950,"end_ms":1400},
  {"text":"欢迎","start_ms":1600,"end_ms":2400},
  {"text":"光临","start_ms":2450,"end_ms":3300}],"cuts":[1500]}')"
echo "重新导入 → import_version=$(echo "$out" | body_of | jget import_version)"
out="$(req GET "/api/projects/$PID/review-comments")"
echo "当前代次意见数=$(echo "$out" | body_of | python3 -c 'import json,sys
print(len(json.load(sys.stdin)["comments"]))')，历史意见数=$(echo "$out" | body_of | python3 -c '
import json,sys
h=json.load(sys.stdin)["history"]
print(len(h))
if h:
    c=h[0]
    print("历史 #%s status=%s current_import=%s 词段=%s 相交字幕数=%d" % (
        c["id"], c["status"], c["current_import"],
        "/".join(w["text"] for w in c["word_segment"]),
        len(c["intersecting_subtitles"])))')"
out="$(req POST "/api/projects/$PID/review-comments/$CID/close" '{"version":6}')"
echo "关闭历史意见 → HTTP $(echo "$out" | code_of)（$(echo "$out" | body_of | jget rejected)）"
out="$(req POST "/api/projects/$PID/review-comments/$CID/reopen" '{"version":6}')"
echo "重开历史意见 → HTTP $(echo "$out" | code_of)（$(echo "$out" | body_of | jget rejected)）"

echo
out="$(req GET "/api/projects/$PID")"
SV="$(echo "$out" | body_of | jget sub_version)"
out="$(req POST "/api/projects/$PID/layout" "{\"sub_version\":$SV}")"
SV="$(echo "$out" | body_of | jget sub_version)"
out="$(req POST "/api/projects/$PID/review-comments" \
  "{\"sub_version\":$SV,\"word_start\":0,\"word_end\":0,\"text\":\"新代次的新意见\"}")"
echo "新代次新建意见 → HTTP $(echo "$out" | code_of)，import_version=$(echo "$out" | body_of | jget import_version)"

echo
echo "完成。复核意见不影响排版/导出；既有导出快照与启动方式保持不变。"
