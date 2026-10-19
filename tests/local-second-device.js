/**
 * 本地测试专用：模拟「第二台设备 / 另一个人」。
 *
 * 用法：
 *   node tests/local-second-device.js <邀请码>          # 加入账本、回记一笔、看双向同步结果
 *   node tests/local-second-device.js <邀请码> --also 100 餐饮 12.5   # 自定义一笔
 *   node tests/local-second-device.js --dump            # 只看服务端数据，不改动
 *
 * 前置：本地后端已启动（MOCK_WX=1，127.0.0.1:3123），且已在开发者工具里
 * 打开了小程序、账本页产生了邀请码。
 */
'use strict'

var BASE = process.env.JZ_LOCAL_BASE || 'http://127.0.0.1:3123'

function api(method, path, body, token) {
  return fetch(BASE + path, {
    method: method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
    body: body ? JSON.stringify(body) : undefined
  }).then(function (r) { return r.json() })
}

function assert(cond, msg) {
  if (!cond) { console.error('FAIL: ' + msg); process.exit(1) }
  console.log('  ok - ' + msg)
}

var args = process.argv.slice(2)
if (args.indexOf('--dump') >= 0) {
  api('POST', '/api/login', { code: 'dump-view', nickname: '查看者' }).then(function (j) {
    assert(j.token, '匿名登录成功（仅用于查看）')
    return api('GET', '/api/sync?since=', null, j.token)
  }).then(function (j) {
    var ledgers = j.ledgers || []
    console.log('服务端账本数：' + ledgers.length)
    ledgers.forEach(function (l) {
      console.log('  [' + l.id + '] ' + l.name + ' 邀请码=' + l.inviteCode + ' 成员=' + (l.members || []).map(function (m) { return m.name }).join(','))
    })
    console.log('可见记录数：' + (j.records || []).length)
    ;(j.records || []).forEach(function (r) {
      console.log('  ' + r.date + ' ' + (r.type === 'income' ? '收入' : '支出') + ' ' + (r.amount / 100).toFixed(2) + '元 [' + r.category + '] ' + (r.memberName || '') + (r.deleted ? '（已删）' : ''))
    })
  })
  process.exitCode = 0
} else {
  var code = args[0]
  assert(!!code, '用法: node tests/local-second-device.js <邀请码> [--also 分类 金额 备注]')
  var extra = args.indexOf('--also')
  var category = extra >= 0 ? args[extra + 1] : '餐饮'
  var amountYuan = extra >= 0 ? Number(args[extra + 2]) : 88.5
  var note = extra >= 0 && args[extra + 3] ? args[extra + 3] : '朋友用模拟设备记的'

  api('POST', '/api/login', { code: 'testfriend-001', nickname: '测试好友' }).then(function (j) {
    assert(j.token, '好友设备登录成功（MOCK）')
    return api('POST', '/api/ledgers/join', { inviteCode: code, nickname: '测试好友' }, j.token).then(function (jr) {
      assert(jr.ok, '凭邀请码加入账本成功')
      var ledger = (jr.ledgers || [])[0]
      assert(!!ledger, '返回里能看到账本 ' + (ledger && ledger.name))
      return api('POST', '/api/sync', {
        since: '',
        ledgers: [],
        records: [{
          id: 'R-local-friend-' + Date.now(),
          ledgerId: ledger.id,
          memberId: j.me.id,
          memberName: '测试好友',
          type: 'expense',
          amount: Math.round(amountYuan * 100),
          category: category,
          date: new Date().toISOString().slice(0, 10),
          note: note,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          deleted: 0
        }]
      }, j.token).then(function (js) {
        assert(js.ok, '好友推送了一笔记录')
        var visible = (js.records || []).filter(function (r) { return r.ledgerId === ledger.id })
        console.log('  好友视角当前共 ' + visible.length + ' 条记录，其中' + visible.filter(function (r) { return r.deleted }).length + '条已删')
        console.log('PASS: 好友已入账。现在去开发者工具首页下拉刷新，应能看到这笔「测试好友」的记录')
      })
    })
  }).catch(function (e) {
    console.error('FAIL: ' + e.message)
    process.exit(1)
  })
}
