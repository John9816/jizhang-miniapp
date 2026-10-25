function pad(n) { return n < 10 ? '0' + n : String(n) }
function format(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) }
function valid(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return false
  var d = new Date(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)), 12)
  return format(d) === s
}
function shiftMonth(key, delta) {
  var d = new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1 + delta, 1, 12)
  return format(d).slice(0, 7)
}
function allowed(date, start, end) { return valid(date) && (!start || date >= start) && (!end || date <= end) }
function grid(month, selected, start, end) {
  var first = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1, 12)
  first.setDate(1 - (first.getDay() + 6) % 7)
  var cells = [], today = format(new Date())
  for (var i = 0; i < 42; i++) {
    var d = new Date(first); d.setDate(first.getDate() + i)
    var key = format(d)
    cells.push({ date: key, day: d.getDate(), inMonth: key.slice(0, 7) === month, selected: key === selected, today: key === today, disabled: !allowed(key, start, end) })
  }
  return cells
}
module.exports = { valid: valid, format: format, shiftMonth: shiftMonth, allowed: allowed, grid: grid }
