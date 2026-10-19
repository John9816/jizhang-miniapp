/**
 * 查看本地测试后端的数据库内容（只读）。
 * 用法：node tests/dump-db.js [数据库路径，默认 ./jizhang-data/jizhang.db]
 */
'use strict'
var path = require('path')
var fs = require('fs')
var sqlite = require('node:sqlite')

var file = process.argv[2] || path.join(__dirname, '..', 'jizhang-data', 'jizhang.db')
if (!fs.existsSync(file)) {
  console.error('数据库不存在：' + file + '（后端没启动过？）')
  process.exit(1)
}
var db = new sqlite.DatabaseSync(file)
function show(sql) {
  var rows = db.prepare(sql).all()
  console.log(sql.replace(/SELECT \* FROM /, '').toUpperCase() + ' (' + rows.length + '):')
  rows.forEach(function (r) { console.log('  ' + JSON.stringify(r)) })
  if (!rows.length) console.log('  (空)')
}
show('SELECT * FROM users')
show('SELECT id, name, invite_code, owner_openid FROM ledgers')
show('SELECT ledger_id, openid, nickname FROM members')
db.prepare('SELECT id, member_name, type, amount, category, date, note, deleted FROM records').all().forEach(function (r) {
  console.log('RECORD: ' + JSON.stringify(r))
})
