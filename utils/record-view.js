var db = require('./db.js')
var u = require('./util.js')

function categoryInfo(ledgerId, type, key) {
  var found = db.categoriesOf(ledgerId, type).filter(function (c) { return c.key === key })[0]
  return found || { key: key, name: u.categoryName(type, key), icon: u.categoryIcon(type, key) }
}

function describe(record) {
  var ledger = record && db.getLedger(record.ledgerId)
  if (!record || record.deleted || !ledger) return null
  var accounts = db.accountsOf(record.ledgerId)
  function accountName(id) {
    if (!id) return '未指定账户'
    var found = accounts.filter(function (a) { return a.id === id })[0]
    return found ? found.name : '已删除账户'
  }
  var transfer = record.type === 'transfer'
  var category = transfer ? { name: '账户转账', icon: '↔' } : categoryInfo(record.ledgerId, record.type, record.category)
  return {
    id: record.id, type: record.type,
    typeLabel: transfer ? '转账' : (record.type === 'income' ? '收入' : '支出'),
    sign: transfer ? '' : (record.type === 'income' ? '+' : '−'),
    amountText: u.formatCents(record.amount), categoryName: category.name, icon: category.icon,
    ledgerName: ledger.name, date: record.date, note: record.note || '未填写备注',
    accountName: accountName(record.accountId), transferToName: accountName(record.transferTo),
    memberName: record.memberName || '我',
    createdText: timeText(record.createdAt), updatedText: timeText(record.updatedAt),
    syncText: record.dirty ? '已保存本机 · 待同步' : '已同步',
    sourceText: record.external ? (record.external.src === 'wechat' ? '微信账单导入' : (record.external.src === 'alipay' ? '支付宝账单导入' : '账单导入')) : '手动或周期记账'
  }
}

function timeText(value) {
  var date = new Date(value)
  if (!isFinite(date.getTime())) return '—'
  return u.dateStr(date) + ' ' + u.hmText(value)
}

module.exports = { categoryInfo: categoryInfo, describe: describe }
