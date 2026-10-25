var u = require('./util.js')

function calculate(limit, records, today) {
  today = today || new Date()
  var month = u.dateStr(today).slice(0, 7)
  var day = today.getDate()
  var totalDays = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate()
  var todayKey = u.dateStr(today)
  var elapsedExpense = 0, futureExpense = 0
  ;(records || []).forEach(function (r) {
    if (r.deleted || r.type !== 'expense' || String(r.date).slice(0, 7) !== month) return
    if (r.date <= todayKey) elapsedExpense += r.amount
    else futureExpense += r.amount
  })
  var remaining = limit - elapsedExpense - futureExpense
  var daysLeft = totalDays - day + 1
  return {
    enabled: limit > 0, remaining: remaining, daysLeft: daysLeft,
    dailyAvailable: limit > 0 ? Math.floor(Math.max(0, remaining) / daysLeft) : 0,
    projected: Math.round(elapsedExpense * totalDays / day) + futureExpense,
    futureExpense: futureExpense
  }
}

module.exports = { calculate: calculate }
