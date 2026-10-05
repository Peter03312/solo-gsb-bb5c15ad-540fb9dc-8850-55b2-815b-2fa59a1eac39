'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { initDb } = require('../src/db');
const { createApp } = require('../src/routes');

let server;
let base;

before(async () => {
  const db = initDb(':memory:');
  const app = createApp(db);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

async function api(path, method = 'GET', body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

// 4 词、切点 1200；默认排版切成两条（词0-1 / 词2-3）
const WORDS = [
  { text: '你好', start_ms: 0, end_ms: 500 },
  { text: '世界', start_ms: 550, end_ms: 1000 },
  { text: '欢迎', start_ms: 1500, end_ms: 2000 },
  { text: '光临', start_ms: 2050, end_ms: 2500 },
];
const CUTS = [1200];

async function createProject(name = '复核意见测试', rules) {
  const created = await api('/api/projects', 'POST', {
    name, words: WORDS, cuts: CUTS,
    rules: rules || { max_chars: 30, min_duration_ms: 200, max_cps: 20 },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body;
}

async function layout(pid, subVersion) {
  const r = await api(`/api/projects/${pid}/layout`, 'POST', { sub_version: subVersion });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

async function listComments(pid) {
  return api(`/api/projects/${pid}/review-comments`);
}

// ---------- 创建与形状校验 ----------

test('创建：形状非法被拒绝（400，不创建）', async () => {
  const p = await createProject();
  const bad1 = await api(`/api/projects/${p.id}/review-comments`, 'POST', {
    sub_version: 0, word_start: 0, word_end: 1, text: '',
  });
  assert.equal(bad1.status, 400);
  assert.ok(bad1.body.errors.some((e) => e.includes('非空')));

  const bad2 = await api(`/api/projects/${p.id}/review-comments`, 'POST', {
    sub_version: 0, word_start: 3, word_end: 1, text: '区间反了',
  });
  assert.equal(bad2.status, 400);
  assert.ok(bad2.body.errors.some((e) => e.includes('word_start')));

  const bad3 = await api(`/api/projects/${p.id}/review-comments`, 'POST', {
    word_start: 0, word_end: 1, text: '缺 sub_version',
  });
  assert.equal(bad3.status, 400);

  const list = await listComments(p.id);
  assert.equal(list.body.comments.length, 0);
});

test('创建：sub_version 过期 → 409 返回当前值且不修改', async () => {
  const p = await createProject();
  await layout(p.id, 0); // sub_version: 0 → 1
  const stale = await api(`/api/projects/${p.id}/review-comments`, 'POST', {
    sub_version: 0, word_start: 0, word_end: 1, text: '基于旧版本',
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.stale, 'sub_version_stale');
  assert.equal(stale.body.current.sub_version, 1);
  const list = await listComments(p.id);
  assert.equal(list.body.comments.length, 0);
});

test('创建：词区间超出当前逐词转写 → 422', async () => {
  const p = await createProject();
  const out = await api(`/api/projects/${p.id}/review-comments`, 'POST', {
    sub_version: 0, word_start: 2, word_end: 9, text: '越界',
  });
  assert.equal(out.status, 422);
  assert.match(out.body.error, /超出当前逐词转写范围/);
});

test('创建：成功锚定导入代次与词序，列表返回状态/词段/相交字幕', async () => {
  const p = await createProject();
  const laid = await layout(p.id, 0);
  const cueA = laid.subtitles.find((c) => c.word_start === 0);
  const cueB = laid.subtitles.find((c) => c.word_start === 2);
  // 区间 [1,2] 横跨两条字幕（词1 在 A，词2 在 B）
  const r = await api(`/api/projects/${p.id}/review-comments`, 'POST', {
    sub_version: 1, word_start: 1, word_end: 2, text: '切点附近对不齐', note: '校对者甲',
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.status, 'open');
  assert.equal(r.body.version, 1);
  assert.equal(r.body.import_version, 1);
  assert.deepEqual(r.body.word_segment.map((w) => w.idx), [1, 2]);
  assert.equal(r.body.word_segment[0].text, '世界');
  const ids = r.body.intersecting_subtitles.map((c) => c.id).sort();
  assert.deepEqual(ids, [cueA.id, cueB.id].sort());

  const list = await listComments(p.id);
  assert.equal(list.body.import_version, 1);
  assert.deepEqual(list.body.counts, { open: 1, resolved: 0, review: 0, history: 0 });
  assert.equal(list.body.comments.length, 1);
  assert.equal(list.body.history.length, 0);

  // 单条查询
  const one = await api(`/api/projects/${p.id}/review-comments/${r.body.id}`);
  assert.equal(one.status, 200);
  assert.equal(one.body.text, '切点附近对不齐');

  const missing = await api(`/api/projects/${p.id}/review-comments/9999`);
  assert.equal(missing.status, 404);
});

test('创建：尚无字幕时也可创建（相交字幕为空），但不可关闭', async () => {
  const p = await createProject();
  const r = await api(`/api/projects/${p.id}/review-comments`, 'POST', {
    sub_version: 0, word_start: 0, word_end: 0, text: '先记下来',
  });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.intersecting_subtitles, []);
  const close = await api(`/api/projects/${p.id}/review-comments/${r.body.id}/close`, 'POST', { version: 1 });
  assert.equal(close.status, 422);
  assert.equal(close.body.rejected, 'no_intersecting_subtitle');
  // 未关闭，版本不变
  assert.equal(close.body.current.status, 'open');
  assert.equal(close.body.current.version, 1);
});

// ---------- 关闭 / 重开与乐观锁 ----------

test('关闭：保存相交字幕快照；无相交字幕/历史/重复关闭被拒绝', async () => {
  const p = await createProject();
  const laid = await layout(p.id, 0);
  const cue = laid.subtitles.find((c) => c.word_start === 0);
  const c = await api(`/api/projects/${p.id}/review-comments`, 'POST', {
    sub_version: 1, word_start: 0, word_end: 1, text: '这条要核对',
  });
  assert.equal(c.status, 201);

  // version 非法 → 400
  const badShape = await api(`/api/projects/${p.id}/review-comments/${c.body.id}/close`, 'POST', {});
  assert.equal(badShape.status, 400);

  // version 过期 → 409 返回当前值且不修改
  const stale = await api(`/api/projects/${p.id}/review-comments/${c.body.id}/close`, 'POST', { version: 7 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.stale, 'comment_version_stale');
  assert.equal(stale.body.current.version, 1);

  const ok = await api(`/api/projects/${p.id}/review-comments/${c.body.id}/close`, 'POST', { version: 1 });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.comment.status, 'resolved');
  assert.equal(ok.body.comment.version, 2);
  assert.equal(ok.body.comment.close_snapshot.length, 1);
  assert.deepEqual(ok.body.comment.close_snapshot[0], {
    subtitle_id: cue.id, text: cue.text,
    start_ms: cue.start_ms, end_ms: cue.end_ms,
    word_start: 0, word_end: 1,
  });

  // 重复关闭 → 422
  const again = await api(`/api/projects/${p.id}/review-comments/${c.body.id}/close`, 'POST', { version: 2 });
  assert.equal(again.status, 422);
  assert.equal(again.body.rejected, 'already_resolved');
  // 重复关闭不改版本
  assert.equal(again.body.current.version, 2);
});

test('重开：resolved/review 可重开，open/history 不可；版本过期 → 409', async () => {
  const p = await createProject();
  await layout(p.id, 0);
  const c = await api(`/api/projects/${p.id}/review-comments`, 'POST', {
    sub_version: 1, word_start: 0, word_end: 1, text: '问题',
  });
  // open 重开 → 422
  const reopenOpen = await api(`/api/projects/${p.id}/review-comments/${c.body.id}/reopen`, 'POST', { version: 1 });
  assert.equal(reopenOpen.status, 422);
  assert.equal(reopenOpen.body.rejected, 'already_open');

  await api(`/api/projects/${p.id}/review-comments/${c.body.id}/close`, 'POST', { version: 1 });
  const stale = await api(`/api/projects/${p.id}/review-comments/${c.body.id}/reopen`, 'POST', { version: 1 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.current.version, 2);

  const ok = await api(`/api/projects/${p.id}/review-comments/${c.body.id}/reopen`, 'POST', { version: 2 });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.comment.status, 'open');
  assert.equal(ok.body.comment.version, 3);
});

// ---------- 关闭后内容变化自动转待复核 ----------

test('关闭后：编辑相交字幕文本 → 自动转 review；仅锁定切换不触发', async () => {
  const p = await createProject();
  const laid = await layout(p.id, 0);
  const cue = laid.subtitles.find((c) => c.word_start === 0);
  const c = await api(`/api/projects/${p.id}/review-comments`, 'POST', {
    sub_version: 1, word_start: 0, word_end: 1, text: '核对文本',
  });
  await api(`/api/projects/${p.id}/review-comments/${c.body.id}/close`, 'POST', { version: 1 });

  // 锁定切换（内容不变）→ 仍 resolved
  const lock = await api(`/api/projects/${p.id}/subtitles/${cue.id}`, 'PATCH', {
    version: cue.version, locked: true,
  });
  assert.equal(lock.status, 200);
  let view = await listComments(p.id);
  assert.equal(view.body.counts.resolved, 1);
  assert.equal(view.body.comments[0].status, 'resolved');

  // 改文本 → review
  const cueV2 = view.body.comments[0].intersecting_subtitles[0];
  const edit = await api(`/api/projects/${p.id}/subtitles/${cue.id}`, 'PATCH', {
    version: cueV2.version, text: `${cue.text}呀`,
  });
  assert.equal(edit.status, 200);
  view = await listComments(p.id);
  assert.equal(view.body.comments[0].status, 'review');
  assert.equal(view.body.counts.review, 1);

  // 再次显式关闭：刷新快照、resolved、版本 +1
  const v3 = view.body.comments[0].version;
  const reclose = await api(`/api/projects/${p.id}/review-comments/${c.body.id}/close`, 'POST', { version: v3 });
  assert.equal(reclose.status, 200);
  assert.equal(reclose.body.comment.status, 'resolved');
  assert.equal(reclose.body.comment.close_snapshot[0].text, `${cue.text}呀`);
});

test('关闭后：重排拆并/字幕行更替（新 ID）→ 转 review，意见仍在相交字幕旁', async () => {
  // 细分排版（4 条单词行）→ 关闭一条意见 → 放宽规则重排（合并删除旧行、新 ID 行）
  const p = await createProject('拆并转待复核', { max_chars: 2, min_duration_ms: 200, max_cps: 5 });
  const fine = await layout(p.id, 0);
  assert.equal(fine.subtitles.length, 4);
  const c = await api(`/api/projects/${p.id}/review-comments`, 'POST', {
    sub_version: 1, word_start: 0, word_end: 1, text: '前两词区间',
  });
  assert.equal(c.status, 201);
  assert.equal(c.body.intersecting_subtitles.length, 2);
  await api(`/api/projects/${p.id}/review-comments/${c.body.id}/close`, 'POST', { version: 1 });

  // 放宽规则 → 重排合并（旧未锁定行被新 ID 行更替）
  const r1 = await api(`/api/projects/${p.id}/rules`, 'PUT', {
    version: 1, max_chars: 40, min_duration_ms: 200, max_cps: 40,
  });
  assert.equal(r1.status, 200);
  const wide = await layout(p.id, 1);
  assert.ok(wide.subtitles.length < 4);

  const view = await listComments(p.id);
  assert.equal(view.body.comments[0].status, 'review');
  // 意见不按字幕 ID 迁移：新的相交字幕（合并行）直接按词区间显示在旁
  const intersect = view.body.comments[0].intersecting_subtitles;
  assert.ok(intersect.length >= 1);
  assert.ok(intersect.some((s) => s.word_start <= 1 && s.word_end >= 0));
});

test('关闭后：仅展示顺序（idx）变化不转待复核', async () => {
  // 重排但内容完全一致时，保留 ID 的行仅更新 idx：关闭意见保持 resolved。
  const p = await createProject('顺序不变状态', { max_chars: 40, min_duration_ms: 200, max_cps: 40 });
  const first = await layout(p.id, 0);
  assert.equal(first.subtitles.length, 2);
  const c = await api(`/api/projects/${p.id}/review-comments`, 'POST', {
    sub_version: 1, word_start: 0, word_end: 3, text: '整句',
  });
  await api(`/api/projects/${p.id}/review-comments/${c.body.id}/close`, 'POST', { version: 1 });

  // 改规则后再改回，触发一次重排；放宽不改变排版结果（词区间/文本/时间一致，仅 idx 重写）
  await api(`/api/projects/${p.id}/rules`, 'PUT', {
    version: 1, max_chars: 40, min_duration_ms: 100, max_cps: 40,
  });
  await layout(p.id, 1);
  await api(`/api/projects/${p.id}/rules`, 'PUT', {
    version: 2, max_chars: 40, min_duration_ms: 200, max_cps: 40,
  });
  await layout(p.id, 2);

  const view = await listComments(p.id);
  assert.equal(view.body.comments[0].status, 'resolved');
});

test('关闭后：逐词时间修正确认（相交字幕时间变化）→ 转 review', async () => {
  const p = await createProject('词修正联动', { max_chars: 30, min_duration_ms: 200, max_cps: 20 });
  const laid = await layout(p.id, 0);
  assert.equal(laid.subtitles.length, 2);
  const c = await api(`/api/projects/${p.id}/review-comments`, 'POST', {
    sub_version: 1, word_start: 0, word_end: 1, text: '词时间存疑',
  });
  await api(`/api/projects/${p.id}/review-comments/${c.body.id}/close`, 'POST', { version: 1 });

  // 提交词修正：词0 [0,500] → [0,480]（保持 0<=start<end 且不与词1 重叠）
  const wr = await api(`/api/projects/${p.id}/word-revisions`, 'POST', {
    sub_version: 1,
    items: [{ word_idx: 0, start_ms: 0, end_ms: 480 }],
  });
  assert.equal(wr.status, 201, JSON.stringify(wr.body));
  const confirm = await api(`/api/projects/${p.id}/word-revisions/${wr.body.id}/confirm`, 'POST');
  assert.equal(confirm.status, 200, JSON.stringify(confirm.body));

  const view = await listComments(p.id);
  assert.equal(view.body.comments[0].status, 'review');
});

test('未关闭（open）意见不受字幕变动影响，始终显示在相交字幕旁', async () => {
  const p = await createProject('open 不动', { max_chars: 2, min_duration_ms: 200, max_cps: 5 });
  await layout(p.id, 0);
  const c = await api(`/api/projects/${p.id}/review-comments`, 'POST', {
    sub_version: 1, word_start: 0, word_end: 0, text: '待处理',
  });
  await api(`/api/projects/${p.id}/rules`, 'PUT', {
    version: 1, max_chars: 40, min_duration_ms: 200, max_cps: 40,
  });
  await layout(p.id, 1);
  const view = await listComments(p.id);
  assert.equal(view.body.comments[0].status, 'open');
  assert.equal(view.body.comments[0].version, 1);
  assert.ok(view.body.comments[0].intersecting_subtitles.length >= 1);
});

// ---------- 重新导入：旧意见转历史 ----------

test('重新导入：旧意见转 history，仅历史查看（词段取快照、无相交字幕），不可关闭/重开', async () => {
  const p = await createProject();
  await layout(p.id, 0);
  const c = await api(`/api/projects/${p.id}/review-comments`, 'POST', {
    sub_version: 1, word_start: 0, word_end: 1, text: '旧代次意见',
  });
  await api(`/api/projects/${p.id}/review-comments/${c.body.id}/close`, 'POST', { version: 1 });

  const reimport = await api(`/api/projects/${p.id}/import`, 'POST', {
    force: true, words: WORDS, cuts: CUTS,
  });
  assert.equal(reimport.status, 200);
  assert.equal(reimport.body.import_version, 2);

  const view = await listComments(p.id);
  assert.equal(view.body.import_version, 2);
  assert.equal(view.body.comments.length, 0);
  assert.equal(view.body.history.length, 1);
  const old = view.body.history[0];
  assert.equal(old.status, 'history');
  assert.equal(old.current_import, false);
  assert.deepEqual(old.intersecting_subtitles, []);
  assert.equal(old.word_segment[0].text, '你好'); // 创建时词段快照仍可查看

  // 历史意见不可关闭 / 重开
  const close = await api(`/api/projects/${p.id}/review-comments/${c.body.id}/close`, 'POST', { version: 2 });
  assert.equal(close.status, 422);
  assert.equal(close.body.rejected, 'history');
  const reopen = await api(`/api/projects/${p.id}/review-comments/${c.body.id}/reopen`, 'POST', { version: 2 });
  assert.equal(reopen.status, 422);
  assert.equal(reopen.body.rejected, 'history');

  // 新代次可以新建新意见，与历史并存
  const reLayout = await layout(p.id, reimport.body.sub_version);
  const c2 = await api(`/api/projects/${p.id}/review-comments`, 'POST', {
    sub_version: reLayout.sub_version, word_start: 0, word_end: 0, text: '新代次意见',
  });
  assert.equal(c2.status, 201);
  assert.equal(c2.body.import_version, 2);
  const after = await listComments(p.id);
  assert.equal(after.body.comments.length, 1);
  assert.equal(after.body.history.length, 1);
});

test('重新导入前未排版：无字幕情况下重新导入，旧 open 意见同样转历史', async () => {
  const p = await createProject();
  const c = await api(`/api/projects/${p.id}/review-comments`, 'POST', {
    sub_version: 0, word_start: 0, word_end: 0, text: '先记的',
  });
  assert.equal(c.status, 201);
  const r = await api(`/api/projects/${p.id}/import`, 'POST', { force: true, words: WORDS, cuts: CUTS });
  assert.equal(r.status, 200);
  const view = await listComments(p.id);
  assert.equal(view.body.history[0].status, 'history');
});
