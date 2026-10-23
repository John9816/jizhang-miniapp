/**
 * 测试：首次进入自动注册链路与头像持久化
 * 运行：node tests/onboarding.test.js
 *
 * 覆盖：
 *  - cloud 的账号阶段机（idle → logging → ready / failed）、订阅广播、retry
 *  - db 的注册标记（markRegistered 幂等）、引导状态位、长头像不再被截断
 *  - avatar 工具：按 base64 魔数认格式、临时路径转 dataURL
 */
var assert = require('assert')
var path = require('path')

var ROOT = path.join(__dirname, '..')
var store = {}
var requests = []
var responses = []

global.wx = {
  getStorageSync: function (key) {
    return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : ''
  },
  setStorageSync: function (key, value) { store[key] = value },
  login: function (o) { o.success({ code: 'mock-code' }) },
  request: function (o) {
    requests.push({ url: o.url, data: o.data })
    var r = responses.shift() || { statusCode: 200, data: { ok: true } }
    setTimeout(function () { o.success({ statusCode: r.statusCode, data: r.data }) }, 0)
  }
}

function fresh(modulePath) {
  var p = path.join(ROOT, modulePath)
  delete require.cache[require.resolve(p)]
  return require(p)
}

function freshPair() {
  requests = []
  responses = []
  fresh('utils/db.js')
  var cloud = fresh('utils/cloud.js')
  return { cloud: cloud, db: require(path.join(ROOT, 'utils/db.js')) }
}

var passed = 0
var failed = 0
function test(name, fn) {
  var done = arguments[1] && arguments[1].length ? arguments[1] : null
  return new Promise(function (resolve) {
    function run() {
      try {
        for (var k in store) delete store[k]
        var r = fn()
        if (r && typeof r.then === 'function') return r.then(finishOk, finishFail)
        finishOk()
      } catch (e) { finishFail(e) }
    }
    function finishOk() { passed++; console.log('PASS  ' + name); resolve() }
    function finishFail(e) { failed++; console.log('FAIL  ' + name + '\n      ' + e.message); resolve() }
    run()
  })
}

async function main() {
  await test('cloud：未开启云同步时账号状态为 off', function () {
    freshPair()
    var cloud = fresh('utils/cloud.js')
    // config.js 线上默认开启，这里临时改成关闭
    var cfgPath = path.join(ROOT, 'config.js')
    var cfg = require(cfgPath)
    var old = cfg.cloud.enabled
    cfg.cloud.enabled = false
    var st = cloud.accountState()
    cfg.cloud.enabled = old
    assert.strictEqual(st.phase, 'off')
    assert.strictEqual(st.enabled, false)
  })

  await test('cloud：登录中 → 成功 ready，并广播给订阅者', function () {
    var pair = freshPair()
    responses = [
      { statusCode: 200, data: { ok: true, token: 't1', me: { id: 'oid_new', name: '', avatar: '', phone: '' } } }
    ]
    var seen = []
    pair.cloud.onChange(function (st) { seen.push(st.phase) })
    return pair.cloud.retry().then(function (res) {
      assert.strictEqual(res.ok, true)
      assert.ok(seen.indexOf('logging') >= 0, '应广播 logging 阶段，实得: ' + seen.join(','))
      assert.ok(seen.indexOf('ready') >= 0, '应广播 ready 阶段，实得: ' + seen.join(','))
      var st = pair.cloud.accountState()
      assert.strictEqual(st.logged, true)
      assert.strictEqual(st.registered, true)
      assert.strictEqual(st.tip, '账号已就绪')
    })
  })

  await test('cloud：登录失败 → failed 且带错误文案，retry 可恢复', function () {
    var pair = freshPair()
    responses = [
      { statusCode: 500, data: { error: 'boom' } },
      { statusCode: 200, data: { ok: true, token: 't2', me: { id: 'oid_x', name: 'x', avatar: '', phone: '' } } }
    ]
    return pair.cloud.retry().then(function (r1) {
      assert.strictEqual(r1.ok, false)
      var st = pair.cloud.accountState()
      assert.strictEqual(st.phase, 'failed')
      assert.ok(st.error.length > 0, '失败应带错误文案')
      return pair.cloud.retry()
    }).then(function (r2) {
      assert.strictEqual(r2.ok, true)
      assert.strictEqual(pair.cloud.accountState().phase, 'ready')
    })
  })

  await test('db：markRegistered 幂等，只在首次落时间戳', function () {
    var pair = freshPair()
    var p1 = pair.db.getProfile()
    assert.strictEqual(p1.registeredAt, '')
    var f1 = pair.db.markRegistered().registeredAt
    assert.ok(f1.length > 0)
    var f2 = pair.db.markRegistered().registeredAt
    assert.strictEqual(f1, f2, '重复标记不应改写时间')
  })

  await test('db：引导状态位可读写，且随持久化存活', function () {
    var pair = freshPair()
    pair.db.setProfile({ guideDone: true })
    var again = fresh('utils/db.js')
    assert.strictEqual(again.getProfile().guideDone, true)
    assert.strictEqual(again.getProfile().registeredAt, '')
  })

  await test('db：shouldShowProfileGuide 随资料补全而消失', function () {
    var pair = freshPair()
    // 新账号：无头像无昵称 → 应展示
    assert.strictEqual(pair.db.shouldShowProfileGuide(), true)
    // 只补头像还不够（昵称仍缺）
    pair.db.setProfile({ avatar: 'data:image/png;base64,AA' })
    assert.strictEqual(pair.db.shouldShowProfileGuide(), true)
    // 头像昵称齐全 → 消失
    pair.db.setMyName('小明')
    assert.strictEqual(pair.db.shouldShowProfileGuide(), false)
    // 标记已读后即使资料缺失也不再展示
    pair.db.setProfile({ guideDone: true })
    pair.db.setProfile({ avatar: '' })
    assert.strictEqual(pair.db.shouldShowProfileGuide(), false)
  })

  await test('db：applyCloudMe 同步到达触发 onChange（截图 bug 回归）', function () {
    var pair = freshPair()
    // 模拟首页 onShow 早于云同步完成：本地无资料，先按页面逻辑挂上监听
    var seen = 0
    var off = pair.db.onChange(function () { seen++ })
    pair.db.applyCloudMe({ name: '远端昵称', avatar: 'data:image/png;base64,BB' })
    off()
    assert.ok(seen > 0, '同步写入资料必须广播 onChange，否则页面重估不了引导卡')
    var p = pair.db.getProfile()
    assert.strictEqual(p.name, '远端昵称')
    assert.strictEqual(p.avatar, 'data:image/png;base64,BB')
    // 同步到达后引导卡应消失（这正是截图里「我的页已就绪、首页仍展示引导卡」的修复点）
    assert.strictEqual(pair.db.shouldShowProfileGuide(), false)
  })

  await test('db：头像支持长 dataURL（不再被 512 截断）', function () {
    var pair = freshPair()
    var long = 'data:image/png;base64,' + new Array(3000).join('A')
    pair.db.setProfile({ avatar: long })
    assert.strictEqual(pair.db.getProfile().avatar.length, long.length)
    pair.db.applyCloudMe({ avatar: long })
    assert.strictEqual(pair.db.getProfile().avatar, long)
  })

  await test('avatar：按 base64 魔数识别 png / jpeg', function () {
    var av = fresh('utils/avatar.js')
    assert.strictEqual(av.mimeOf('iVBORw0KGgoAAAANS drawing'), 'png')
    assert.strictEqual(av.mimeOf('/9j/4AAQSkZJRg'), 'jpeg')
    assert.strictEqual(av.mimeOf('R0lGODlhAQ'), 'gif')
  })

  await test('avatar：persist 把临时路径压成 base64 dataURL', function (finish) {
    var av = fresh('utils/avatar.js')
    global.wx.compressImage = function (o) { o.success({ tempFilePath: o.src + '.cmp' }) }
    global.wx.getFileSystemManager = function () {
      return {
        readFile: function (o) {
          // 返回一个极简 png 的魔数片段
          assert.strictEqual(o.filePath, 'wxfile://tmp/a.png.cmp')
          assert.strictEqual(o.encoding, 'base64')
          o.success({ data: 'iVBORw0KGgoAAAABBBB' })
        }
      }
    }
    return new Promise(function (resolve, reject) {
      av.persist('wxfile://tmp/a.png', function (err, url) {
        try {
          assert.ok(!err, '不应报错: ' + (err && err.message))
          assert.strictEqual(url, 'data:image/png;base64,iVBORw0KGgoAAAABBBB')
          resolve()
        } catch (e) { reject(e) }
      })
    })
  })

  await test('avatar：已经是 dataURL / http 地址时原样返回', function () {
    var av = fresh('utils/avatar.js')
    var got1 = null
    av.persist('data:image/jpeg;base64,AAA', function (e, v) { got1 = v })
    assert.strictEqual(got1, 'data:image/jpeg;base64,AAA')
    var got2 = null
    av.persist('https://cdn.example.com/a.png', function (e, v) { got2 = v })
    assert.strictEqual(got2, 'https://cdn.example.com/a.png')
  })

  await test('avatar：空路径返回错误，不静默成功', function () {
    var av = fresh('utils/avatar.js')
    var err = null
    av.persist('', function (e) { err = e })
    assert.ok(err instanceof Error)
  })

  console.log('\n通过 ' + passed + ' 项' + (failed ? '，失败 ' + failed + ' 项' : ''))
  if (failed) process.exitCode = 1
}

main()
