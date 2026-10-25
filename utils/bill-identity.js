/** 外部流水身份：解析、入账和云端使用相同规则，避免显示字段编辑后改变去重结果。 */
function clean(value, max) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max)
}
function transaction(value) {
  var txn = clean(value, 128)
  return /^(?:\/|-+|—+|N\/?A|无|null|undefined)$/i.test(txn) ? '' : txn
}
function time(value) {
  var m = clean(value, 40).match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/)
  if (!m) return ''
  function pad(n) { return ('0' + n).slice(-2) }
  return m[1] + '-' + pad(m[2]) + '-' + pad(m[3]) + ' ' + pad(m[4]) + ':' + m[5] + ':' + (m[6] || '00')
}
function normalize(row) {
  if (!row || typeof row !== 'object') return null
  var src = clean(row.src, 16)
  if (!src) return null
  var out = {
    src: src, txn: transaction(row.txn), party: clean(row.party, 200),
    date: clean(row.date, 10), time: time(row.time), type: clean(row.type, 16),
    amount: Math.round(Number(row.amount) || 0), note: clean(row.note, 500), channel: clean(row.channel, 100)
  }
  if (out.date && out.type && out.amount > 0) out.version = 2
  return out
}
function key(row) {
  var r = normalize(row) || {}
  if (r.txn) return r.src + '#' + r.txn
  return 'v2#' + JSON.stringify([r.src, r.date, r.time, r.type, r.amount, r.party, r.note, r.channel])
}
/** 旧版未保存完整快照，仅在旧记录索引中使用，避免同金额手记账单被自动跳过。 */
function legacyKey(row) {
  return 'legacy#' + JSON.stringify([clean(row.src, 16), clean(row.date, 10), clean(row.type, 16),
    Math.round(Number(row.amount) || 0), clean(row.party, 40), clean(row.note || row.party, 50)])
}
module.exports = { normalize: normalize, key: key, legacyKey: legacyKey, time: time }
