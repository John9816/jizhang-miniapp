// 模板只存预填字段，不携带账单 ID、日期、导入来源或记账人。
function normalize(fields) {
  if (!fields || typeof fields !== 'object') return null
  var name = String(fields.name || '').trim().slice(0, 20)
  var amount = Number(fields.amount)
  var type = fields.type
  if (!name || !Number.isSafeInteger(amount) || amount <= 0 || amount > 1e12) return null
  if (['expense', 'income', 'transfer'].indexOf(type) < 0) return null
  return {
    id: String(fields.id || '').slice(0, 64), name: name, type: type, amount: amount,
    category: type === 'transfer' ? 'transfer' : String(fields.category || '').slice(0, 32),
    accountId: String(fields.accountId || '').slice(0, 64),
    transferTo: type === 'transfer' ? String(fields.transferTo || '').slice(0, 64) : '',
    note: String(fields.note || '').trim().slice(0, 50)
  }
}
function list(items) {
  var seen = new Set()
  return (Array.isArray(items) ? items : []).slice(0, 50).map(normalize).filter(function (t) {
    if (!t || !t.id || seen.has(t.id)) return false
    seen.add(t.id); return true
  })
}
module.exports = { normalize: normalize, list: list }
