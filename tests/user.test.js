/**
 * 微信登录态扩展能力测试：
 *  A. cloud 层（mock wx.request/wx.login）：updateProfile / bindPhone 的本地优先与云端回写
 *  B. server 层（真实进程 + MOCK_WX）：/api/user/profile、/api/user/phone 端点行为
 * 运行：node tests/user.test.js
 */
'use strict'

var assert = require('assert')
var fs = require('fs')
var os = require('os')
var path = require('path')
var spawn = require('child_process').spawn

var ROOT = path.join(__dirname, '..')
var NODE = process.execPath
var PORT = 31338
var BASE = 'http://127.0.0.1:' + PORT
var SERVER = path.join(ROOT, 'server', 'server.js')

var passed = 0
var failed = 0

async function test(name, fn) {
  try {
    await fn()
    passed++
    console.log('  ok -', name)
  } catch (e) {
    failed++
    console.error('  FAIL -', name, '\n   ', e && e.message)
    process.exitCode = 1
  }
}

function iso(offsetMs) { return new Date(Date.now() + (offsetMs || 0)).toISOString() }

function api(method, urlPath, body, token) {
  var headers = {}
  if (body) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = 'Bearer ' + token
  return fetch(BASE + urlPath, {
    method: method,
    headers: headers,
    body: body ? JSON.stringify(body) : undefined
  }).then(function (resp) {
    return resp.json().then(function (data) { return { status: resp.status, data: data } })
  })
}

/* ================= 运行区 ================= */

async function main() {
  /* ---------- A. cloud 层 ---------- */

  console.log('A. cloud 层：资料更新 / 手机号绑定（mock wx）')

  var store = {}
  var requests = []

  global.wx = {
    getStorageSync: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : '' },
    setStorageSync: function (k, v) { store[k] = String(v) },
    removeStorageSync: function (k) { delete store[k] },
    login: function (o) { o.success && o.success({ code: 'mock-code' }) },
    request: function (o) {
      requests.push({ url: o.url, method: o.method, data: o.data })
      var resp = global.__nextResponses.shift() || { statusCode: 200, data: { ok: true, me: { id: 'oid_1', name: '小明', avatar: 'https://cdn/av.png', phone: '' } } }
      setTimeout(function () {
        if (resp.networkFail) o.fail && o.fail({ errMsg: 'request:fail' })
        else o.success && o.success({ statusCode: resp.statusCode, data: resp.data })
      }, 0)
    }
  }
  global.__nextResponses = []

  function freshCloudModule() {
    var p = path.join(ROOT, 'utils/cloud.js')
    delete require.cache[path.join(ROOT, 'utils/db.js')]
    delete require.cache[p]
    return require(p)
  }

  function drainRequests(pred) {
    var hit = requests.filter(pred)
    requests = []
    return hit
  }

  await test('updateProfile：本地先写，成功后再 POST 云端', async function () {
    var cloud = freshCloudModule()
    var db = require(path.join(ROOT, 'utils/db.js'))
    global.__nextResponses = [
      { statusCode: 200, data: { ok: true, token: 't-mock', me: { id: 'oid_1', name: '小明', avatar: '', phone: '' } } },
      { statusCode: 200, data: { ok: true, me: { id: 'oid_1', name: '小明', avatar: 'https://cdn/av.png', phone: '' } } }
    ]
    var res = await cloud.updateProfile({ nickname: '小明', avatar: 'https://cdn/av.png' })
    assert.strictEqual(res.ok, true)
    assert.strictEqual(db.getProfile().name, '小明')
    assert.strictEqual(db.getProfile().avatar, 'https://cdn/av.png')
    var hit = drainRequests(function (r) { return r.url.indexOf('/api/user/profile') >= 0 })
    assert.strictEqual(hit.length, 1)
    assert.strictEqual(hit[0].method, 'POST')
    assert.strictEqual(hit[0].data.nickname, '小明')
    assert.strictEqual(hit[0].data.avatar, 'https://cdn/av.png')
  })

  await test('bindPhone：成功时回写本机 phone（code 模式）', async function () {
    var cloud = freshCloudModule()
    var db = require(path.join(ROOT, 'utils/db.js'))
    // 第一个响应预留给 login，第二个才是 phone 请求的
    global.__nextResponses = [
      { statusCode: 200, data: { ok: true, token: 't-mock', me: { id: 'oid_1', name: '小明', avatar: '', phone: '' } } },
      { statusCode: 200, data: { ok: true, phone: '13800138000' } }
    ]
    var res = await cloud.bindPhone('mock-code')
    assert.strictEqual(res.ok, true)
    assert.strictEqual(res.phone, '13800138000')
    assert.strictEqual(db.getProfile().phone, '13800138000')
    var hit = drainRequests(function (r) { return r.url.indexOf('/api/user/phone') >= 0 })
    assert.strictEqual(hit.length, 1)
    assert.strictEqual(hit[0].data.code, 'mock-code')
  })

  await test('bindPhone：个人主体无权限（needManual）时透出错误且不改本机', async function () {
    var cloud = freshCloudModule()
    var db = require(path.join(ROOT, 'utils/db.js'))
    db.setProfile({ phone: '' })
    global.__nextResponses = [
      { statusCode: 200, data: { ok: true, token: 't-mock', me: { id: 'oid_1', name: '小明', avatar: '', phone: '' } } },
      { statusCode: 400, data: { error: '获取手机号失败(86004)', errcode: 86004, needManual: true } }
    ]
    var res = await cloud.bindPhone('bad-code')
    assert.strictEqual(res.ok, false)
    assert.strictEqual(res.needManual, true)
    assert.strictEqual(db.getProfile().phone, '')
  })

  await test('bindPhone：手动填写走 phone 字段', async function () {
    var cloud = freshCloudModule()
    global.__nextResponses = [
      { statusCode: 200, data: { ok: true, token: 't-mock', me: { id: 'oid_1', name: '小明', avatar: '', phone: '' } } },
      { statusCode: 200, data: { ok: true, phone: '13912345678' } }
    ]
    var res = await cloud.bindPhone('', '13912345678')
    assert.strictEqual(res.ok, true)
    var hit = drainRequests(function (r) { return r.url.indexOf('/api/user/phone') >= 0 && r.data && r.data.phone === '13912345678' })
    assert.strictEqual(hit.length, 1, '未找到带 phone 的绑定请求')
    assert.strictEqual(hit[0].data.code, undefined)
  })

  await test('updateProfile：云端 400 时返回错误但本机已本地优先', async function () {
    var cloud = freshCloudModule()
    var db = require(path.join(ROOT, 'utils/db.js'))
    db.setProfile({ avatar: 'https://cdn/keep.png' })
    global.__nextResponses = [
      { statusCode: 200, data: { ok: true, token: 't-mock', me: { id: 'oid_1', name: '小明', avatar: '', phone: '' } } },
      { statusCode: 400, data: { error: '昵称不合规' } }
    ]
    var res = await cloud.updateProfile({ nickname: '新名字' })
    assert.strictEqual(res.ok, false)
    assert.strictEqual(res.error, '昵称不合规')
    assert.strictEqual(db.getProfile().name, '新名字')
    assert.strictEqual(db.getProfile().avatar, 'https://cdn/keep.png')
  })

  /* ---------- B. server 层 ---------- */

  console.log('B. server 层：资料 / 手机号端点（真实进程 · MOCK_WX）')

  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jizhang-user-test-'))
  var child = spawn(NODE, [SERVER], {
    env: Object.assign({}, process.env, {
      MOCK_WX: '1',
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DATA_FILE: path.join(tmpDir, 'test.db')
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  var stderrBuf = ''
  child.stderr.on('data', function (d) { stderrBuf += d })

  var deadline = Date.now() + 10000
  var up = false
  while (Date.now() < deadline) {
    try {
      var hr = await fetch(BASE + '/healthz')
      if (hr.ok) { up = true; break }
    } catch (e) { /* 还没起来 */ }
    await new Promise(function (r) { setTimeout(r, 150) })
  }
  if (!up) {
    console.error('服务未能在 10s 内启动：\n' + stderrBuf)
    child.kill()
    process.exit(1)
  }

  var tokenA = ''
  var openidA = ''
  var ledgerId = 'L_user_test'

  await test('登录返回 me 档案（含空 avatar/phone）', async function () {
    var a = await api('POST', '/api/login', { code: 'code-a', nickname: '小明' })
    assert(a.data.ok, '登录失败')
    tokenA = a.data.token
    openidA = a.data.me.id
    assert(openidA === 'mock_code-a', 'openid 映射错误: ' + openidA)
    assert(a.data.me.name === '小明')
    assert(a.data.me.avatar === '' && a.data.me.phone === '', '新用户头像/手机号应为空')
  })

  await test('POST /api/user/profile 更新昵称与头像', async function () {
    var r = await api('POST', '/api/user/profile', {
      nickname: '大明',
      avatar: 'https://tmp.cdn/wx/avatar_01.png'
    }, tokenA)
    assert(r.data.ok, 'profile 更新失败')
    assert(r.data.me.name === '大明', '昵称未更新')
    assert(r.data.me.avatar === 'https://tmp.cdn/wx/avatar_01.png', '头像未更新')
    var s = await api('GET', '/api/sync', null, tokenA)
    assert(s.data.me.name === '大明', 'sync 快照昵称不对')
    assert(s.data.me.avatar === 'https://tmp.cdn/wx/avatar_01.png', 'sync 快照头像不对')
  })

  await test('profile 更新时同步刷新账本成员展示名', async function () {
    await api('POST', '/api/sync', {
      since: '',
      ledgers: [{
        id: ledgerId,
        name: '家庭账本',
        createdAt: iso(-86400000),
        ownerId: openidA,
        ownerName: '大明',
        members: [{ id: openidA, name: '大明', joinedAt: iso(-86400000) }]
      }],
      records: []
    }, tokenA)
    var r = await api('POST', '/api/user/profile', { nickname: '明总' }, tokenA)
    assert(r.data.ok && r.data.me.name === '明总', '改名失败')
    var s = await api('GET', '/api/sync', null, tokenA)
    var m = (s.data.members || []).filter(function (x) { return x.ledgerId === ledgerId })[0]
    assert(m && m.name === '明总', '成员名未跟随昵称刷新: ' + JSON.stringify(m))
  })

  await test('POST /api/user/phone 手动绑定 + 非法手机号拒绝', async function () {
    var bad = await api('POST', '/api/user/phone', { phone: '123' }, tokenA)
    assert(bad.status === 400, '非法手机号应 400，实际 ' + bad.status)
    var ok = await api('POST', '/api/user/phone', { phone: '13800138000' }, tokenA)
    assert(ok.data.ok, '绑定失败: ' + JSON.stringify(ok.data))
    assert(ok.data.phone === '13800138000')
    var s = await api('GET', '/api/sync', null, tokenA)
    assert(s.data.me.phone === '13800138000', 'sync 快照手机号不对')
  })

  await test('POST /api/user/phone 走 MOCK code 派生号码', async function () {
    var r = await api('POST', '/api/user/phone', { code: 'mock-code-12345678' }, tokenA)
    assert(r.data.ok, 'mock code 绑定失败: ' + JSON.stringify(r.data))
    assert(/^138\d{0,8}$/.test(r.data.phone), 'mock 号码格式: ' + r.data.phone)
    var s = await api('GET', '/api/sync', null, tokenA)
    assert(s.data.me.phone === r.data.phone, 'sync 快照手机号未刷新')
  })

  await test('profile / phone 端点都需要登录态', async function () {
    var p1 = await api('POST', '/api/user/profile', { nickname: '无凭证' })
    assert(p1.status === 401, 'profile 无 token 应 401，实际 ' + p1.status)
    var p2 = await api('POST', '/api/user/phone', { phone: '13800138000' })
    assert(p2.status === 401, 'phone 无 token 应 401，实际 ' + p2.status)
  })

  child.kill()

  console.log('\n通过 ' + passed + ' 项' + (failed ? '，失败 ' + failed + ' 项' : ''))
  process.exit(failed ? 1 : 0)
}

main().catch(function (e) {
  console.error('运行异常:', e)
  process.exit(1)
})
