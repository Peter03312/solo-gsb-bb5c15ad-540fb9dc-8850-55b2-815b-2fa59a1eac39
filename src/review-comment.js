'use strict';

/**
 * 逐词区间复核意见：请求解析、相交计算、视图组装、关闭/重开与失效对账。
 *
 * 意见模型（锚定导入代次 + 词序，不按字幕 ID/行号迁移）：
 *   - 校对者以当前导入代次 import_version、字幕集版本 sub_version、起止词序与非空意见创建；
 *     词区间须落在现有逐词转写内。
 *   - 列表返回意见状态、词段和与区间相交的当前字幕（区间相交：cue.word_start <= word_end
 *     且 cue.word_end >= word_start）。
 *   - open 待处理 / resolved 已关闭 / review 待复核 / history 历史。
 *   - 关闭须存在相交的当前字幕，并保存其文本、起止时间与词区间快照；关闭后这些内容变化
 *     （重排拆并、逐词改时、字幕行更替）→ 自动转 review，直到再次显式关闭；
 *     仅锁定或展示顺序变化不触发。
 *   - 重新导入（导入代次 +1）后，旧意见全部转 history：仅作为历史查看，不附到新词段、
 *     不可关闭/重开。
 *   - 意见写入携带意见版本 version（创建携带 sub_version）；创建或写入所带版本过期均
 *     返回当前值且不修改。
 */

class StaleCommentError extends Error {
  constructor(payload) {
    super(payload.error || '复核意见版本过期');
    this.payload = payload;
  }
}

function isInt(v) {
  return typeof v === 'number' && Number.isInteger(v);
}

/** 词区间与字幕词区间是否相交（闭区间；端点相接也算相交——共享一个词即相交） */
function intersects(wordStart, wordEnd, cue) {
  return cue.word_start <= wordEnd && cue.word_end >= wordStart;
}

/** 解析创建请求：{sub_version, word_start, word_end, text, note?} */
function parseCreateBody(body) {
  const errors = [];
  const b = body || {};
  if (!isInt(b.sub_version) || b.sub_version < 0) {
    errors.push('sub_version（读取时字幕集版本）必须是 ≥0 的整数');
  }
  if (!isInt(b.word_start) || b.word_start < 0) {
    errors.push('word_start（起始词序）必须是 ≥0 的整数');
  }
  if (!isInt(b.word_end) || b.word_end < 0) {
    errors.push('word_end（结束词序）必须是 ≥0 的整数');
  }
  if (isInt(b.word_start) && isInt(b.word_end) && b.word_start > b.word_end) {
    errors.push(`词区间非法：word_start ${b.word_start} 不得晚于 word_end ${b.word_end}`);
  }
  if (typeof b.text !== 'string' || b.text.trim() === '') {
    errors.push('text（复核意见）必须是非空字符串');
  }
  let note = '';
  if (b.note !== undefined && b.note !== null) {
    if (typeof b.note !== 'string') errors.push('note（说明）必须是字符串');
    else note = b.note;
  }
  return {
    ok: errors.length === 0,
    errors,
    request: errors.length === 0
      ? {
          sub_version: b.sub_version,
          word_start: b.word_start,
          word_end: b.word_end,
          text: b.text.trim(),
          note,
        }
      : null,
  };
}

/** 解析意见写入请求（关闭/重开）：{version} 必填正整数 */
function parseVersionBody(body) {
  const errors = [];
  const b = body || {};
  if (!isInt(b.version) || b.version < 1) {
    errors.push('version（当前意见版本）必须是 ≥1 的整数');
  }
  return { ok: errors.length === 0, errors, version: isInt(b.version) ? b.version : null };
}

/** 取单个意见行（不属于该项目返回 null） */
function getComment(db, projectId, commentId) {
  return db.prepare(
    'SELECT * FROM review_comments WHERE id = ? AND project_id = ?'
  ).get(commentId, projectId) || null;
}

/** 当前与词区间相交的字幕（按展示顺序） */
function intersectingCues(db, projectId, wordStart, wordEnd) {
  return db.prepare(
    `SELECT id, idx, word_start, word_end, text, start_ms, end_ms, locked, version
       FROM subtitles
      WHERE project_id = ? AND word_start <= ? AND word_end >= ?
      ORDER BY idx`
  ).all(projectId, wordEnd, wordStart);
}

/** 关闭快照条目（文本/时间/词区间；不含 idx/locked/version——仅顺序或锁定变化不触发失效） */
function snapshotOf(cue) {
  return {
    subtitle_id: cue.id,
    text: cue.text,
    start_ms: cue.start_ms,
    end_ms: cue.end_ms,
    word_start: cue.word_start,
    word_end: cue.word_end,
  };
}

/**
 * 关闭快照与当前相交字幕的内容是否发生变化。
 * 口径：逐条按字幕 ID 对齐比较（text/起止/词区间），并要求相交集合仍恰好是快照中的
 * 那些字幕——重排拆并会以新 ID 更替相交行，此时快照字幕消失而新行出现，记为变化。
 * 仅展示顺序（idx）或锁定（locked）变化不在比较字段内，不触发。
 */
function snapshotDrifted(snapshot, currentCues) {
  if (!Array.isArray(snapshot) || snapshot.length === 0) {
    return currentCues.length > 0;
  }
  const currentById = new Map(currentCues.map((c) => [c.id, c]));
  if (snapshot.length !== currentCues.length) return true;
  for (const snap of snapshot) {
    const cue = currentById.get(snap.subtitle_id);
    if (!cue) return true;
    if (cue.text !== snap.text ||
        cue.start_ms !== snap.start_ms ||
        cue.end_ms !== snap.end_ms ||
        cue.word_start !== snap.word_start ||
        cue.word_end !== snap.word_end) {
      return true;
    }
  }
  return false;
}

function mapComment(row) {
  return {
    id: row.id,
    import_version: row.import_version,
    word_start: row.word_start,
    word_end: row.word_end,
    text: row.text,
    note: row.note,
    status: row.status,
    version: row.version,
    sub_version_snapshot: row.sub_version_snapshot,
    close_snapshot: row.close_snapshot_json ? JSON.parse(row.close_snapshot_json) : null,
    closed_at: row.closed_at,
    reopened_at: row.reopened_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** 组装单个意见的视图：状态 + 词段 + 相交当前字幕 */
function buildCommentView(db, projectId, row, currentImportVersion) {
  const importVersion = currentImportVersion
    ?? db.prepare('SELECT import_version FROM projects WHERE id = ?').get(projectId).import_version;
  const currentImport = row.import_version === importVersion;
  const words = db.prepare(
    'SELECT idx, text, start_ms, end_ms FROM words WHERE project_id = ? AND idx >= ? AND idx <= ? ORDER BY idx'
  ).all(projectId, row.word_start, row.word_end);
  // 旧代次（history）：词段取创建时快照，不附到新词段，也不计算相交字幕
  let wordSegment;
  let cues = [];
  if (currentImport) {
    wordSegment = words.length > 0
      ? words
      : JSON.parse(row.words_json); // 同代次但词已缺失（防御性）：退回快照
    cues = intersectingCues(db, projectId, row.word_start, row.word_end);
  } else {
    wordSegment = JSON.parse(row.words_json);
  }
  return {
    ...mapComment(row),
    current_import: currentImport,
    word_segment: wordSegment,
    intersecting_subtitles: cues,
  };
}

/** 意见列表视图：当前代次意见（附词段与相交字幕）+ 历史代次意见（仅快照） */
function buildListView(db, projectId) {
  const project = db.prepare(
    'SELECT sub_version, import_version FROM projects WHERE id = ?'
  ).get(projectId);
  const rows = db.prepare(
    'SELECT * FROM review_comments WHERE project_id = ? ORDER BY id DESC'
  ).all(projectId);
  const comments = [];
  const history = [];
  const counts = { open: 0, resolved: 0, review: 0, history: 0 };
  for (const row of rows) {
    counts[row.status] = (counts[row.status] || 0) + 1;
    const view = buildCommentView(db, projectId, row, project.import_version);
    if (row.import_version === project.import_version) comments.push(view);
    else history.push(view);
  }
  return {
    project_id: projectId,
    sub_version: project.sub_version,
    import_version: project.import_version,
    counts,
    comments,
    history,
  };
}

/**
 * 创建意见（调用方已完成形状/词区间/sub_version 核对）。
 * 锚定当前导入代次与词序，保存创建时词段快照；版本从 1 开始。
 */
function createComment(db, projectId, request) {
  const project = db.prepare(
    'SELECT import_version, sub_version FROM projects WHERE id = ?'
  ).get(projectId);
  const words = db.prepare(
    'SELECT idx, text, start_ms, end_ms FROM words WHERE project_id = ? AND idx >= ? AND idx <= ? ORDER BY idx'
  ).all(projectId, request.word_start, request.word_end);
  const id = db.prepare(
    `INSERT INTO review_comments
       (project_id, import_version, word_start, word_end, text, note, status, version,
        sub_version_snapshot, words_json)
     VALUES (?, ?, ?, ?, ?, ?, 'open', 1, ?, ?)`
  ).run(
    projectId, project.import_version, request.word_start, request.word_end,
    request.text, request.note, project.sub_version, JSON.stringify(words)
  ).lastInsertRowid;
  return getComment(db, projectId, id);
}

/**
 * 关闭意见。
 *   - history 不可关闭；open/review 可关闭（resolved 重复关闭 → 422）；
 *   - 必须存在相交的当前字幕（否则 422）；
 *   - version 过期抛 StaleCommentError（路由转 409，返回当前值且不修改）。
 * 成功后状态 resolved、版本 +1，保存相交字幕文本/时间/词区间快照。
 */
function closeComment(db, projectId, commentId, version) {
  const row = getComment(db, projectId, commentId);
  if (!row) return null;
  if (row.status === 'history') {
    return { rejected: 'history', current: buildCommentView(db, projectId, row) };
  }
  if (row.status === 'resolved') {
    return { rejected: 'already_resolved', current: buildCommentView(db, projectId, row) };
  }
  if (version !== row.version) {
    throw new StaleCommentError({
      error: `复核意见版本过期：你基于 v${version} 关闭，当前已是 v${row.version}，请刷新后重试`,
      stale: 'comment_version_stale',
      current: buildCommentView(db, projectId, row),
    });
  }
  const cues = intersectingCues(db, projectId, row.word_start, row.word_end);
  if (cues.length === 0) {
    return { rejected: 'no_intersecting_subtitle', current: buildCommentView(db, projectId, row) };
  }
  db.prepare(
    `UPDATE review_comments
       SET status = 'resolved', version = version + 1, close_snapshot_json = ?,
           closed_at = datetime('now'), updated_at = datetime('now')
     WHERE id = ?`
  ).run(JSON.stringify(cues.map(snapshotOf)), row.id);
  return { rejected: null, current: buildCommentView(db, projectId, getComment(db, projectId, row.id)) };
}

/**
 * 重新打开意见（回到待处理 open）。
 *   - history 不可重开；open 重复重开 → 422；resolved/review 可重开；
 *   - version 过期抛 StaleCommentError（路由转 409，返回当前值且不修改）。
 * 成功后状态 open、版本 +1（关闭快照保留，供查看；再次关闭时整体刷新）。
 */
function reopenComment(db, projectId, commentId, version) {
  const row = getComment(db, projectId, commentId);
  if (!row) return null;
  if (row.status === 'history') {
    return { rejected: 'history', current: buildCommentView(db, projectId, row) };
  }
  if (row.status === 'open') {
    return { rejected: 'already_open', current: buildCommentView(db, projectId, row) };
  }
  if (version !== row.version) {
    throw new StaleCommentError({
      error: `复核意见版本过期：你基于 v${version} 重新打开，当前已是 v${row.version}，请刷新后重试`,
      stale: 'comment_version_stale',
      current: buildCommentView(db, projectId, row),
    });
  }
  db.prepare(
    `UPDATE review_comments
       SET status = 'open', version = version + 1, reopened_at = datetime('now'),
           updated_at = datetime('now')
     WHERE id = ?`
  ).run(row.id);
  return { rejected: null, current: buildCommentView(db, projectId, getComment(db, projectId, row.id)) };
}

/**
 * 字幕内容变化后的统一对账（在源字幕变更事务内/提交后调用均可）：
 * 已关闭（resolved）意见：关闭快照中的相交字幕文本/时间/词区间相对当前相交字幕变化 → 转
 * review（待复核），直到校对者再次显式关闭；仅 idx/locked 变化不在比较字段内，不触发。
 * open 意见始终保持 open（本来就在等待处理）；review/history 不被自动改回。
 * 返回转待复核的条数。
 */
function syncReviewComments(db, projectId) {
  const resolved = db.prepare(
    `SELECT * FROM review_comments WHERE project_id = ? AND status = 'resolved'`
  ).all(projectId);
  let reviewed = 0;
  for (const row of resolved) {
    const snapshot = row.close_snapshot_json ? JSON.parse(row.close_snapshot_json) : null;
    const cues = intersectingCues(db, projectId, row.word_start, row.word_end);
    if (snapshotDrifted(snapshot, cues)) {
      db.prepare(
        `UPDATE review_comments SET status = 'review', updated_at = datetime('now') WHERE id = ?`
      ).run(row.id);
      reviewed++;
    }
  }
  return reviewed;
}

/**
 * 重新导入（导入代次 +1）后的对账：当前代次的全部意见（open/resolved/review）转 history，
 * 仅作为历史查看，不附到新词段、不可关闭/重开。返回转历史的条数。
 * 必须在 bumpImportVersion 之后、同事务内调用。
 */
function archiveReviewComments(db, projectId) {
  const importVersion = db.prepare(
    'SELECT import_version FROM projects WHERE id = ?'
  ).get(projectId).import_version;
  return db.prepare(
    `UPDATE review_comments SET status = 'history', updated_at = datetime('now')
      WHERE project_id = ? AND import_version != ? AND status != 'history'`
  ).run(projectId, importVersion).changes;
}

module.exports = {
  StaleCommentError,
  parseCreateBody,
  parseVersionBody,
  intersects,
  getComment,
  intersectingCues,
  buildCommentView,
  buildListView,
  createComment,
  closeComment,
  reopenComment,
  syncReviewComments,
  archiveReviewComments,
};
