/**
 * 云端同步层（离线优先）。
 *
 * 设计：本机 db（utils/db.js）仍是界面唯一数据源，页面代码不变；
 *   - 本地写入 → persist → emitChange → kick() 防抖推送脏数据；
 *   - 定时 / 切前台 / 写入后 → 拉取增量合并（LWW，删除以墓碑传播）；
 *   - 登录用 wx.login 的 code 在服务端换 openid；AppSecret 只在服务端。
 *
 * cloud.enabled = false 时全部方法静默降级，退回纯本地模式。
 */

var cfg = require('../config.js')
var db = require('./db.js')

var state = {
  token: '',
  since: '',
  syncing: false,
  loginPending: null,
  lastOkAt: 0,
  lastError: '',
  debounceTimer: null,
  pollTimer: null,
  started: false,
  // 账号阶段：idle 未开始 / logging 注册或登录中 / ready 已登录 / failed 失败（需重试）
  phase: 'idle',
  loginError: '',
  registered: false
}

/** 状态订阅者（phase / 同步状态变化时通知页面刷新） */
var listeners = []

function emit() {
  for (var i = 0; i < listeners.length; i++) {
    try { listeners[i](accountState()) } catch (e) {}
  }
}

function onChange(fn) {
  listeners.push(fn)
  return function () {
    var idx = listeners.indexOf(fn)
    if (idx >= 0) listeners.splice(idx, 1)
  }
}

function setPhase(phase, err) {
  state.phase = phase
  if (err !== undefined) state.loginError = err || ''
  emit()
}

function enabled() {
  return !!(cfg.cloud && cfg.cloud.enabled === true)
}

function nowIso() {
  return new Date().toISOString()
}

/* ---------------- 网络 ---------------- */

function request(path, options) {
  options = options || {}
  return new Promise(function (resolve, reject) {
    var header = { 'Content-Type': 'application/json' }
    if (state.token) header.Authorization = 'Bearer ' + state.token
    wx.request({
      url: cfg.cloud.apiBase + path,
      method: options.method || 'GET',
      data: options.data || {},
      header: header,
      timeout: 10000,
      success: function (res) {
        if (res.statusCode >= 200 && res.statusCode < 300 && res.data && res.data.ok !== false) {
          resolve(res.data)
        } else {
          // 把响应体挂到错误上，调用方才能拿到 needManual / errcode 等结构化信息
          var err = new Error((res.data && res.data.error) || ('HTTP ' + res.statusCode))
          err.data = res.data || {}
          err.status = res.statusCode
          reject(err)
        }
      },
      fail: function (err) {
        reject(new Error((err && err.errMsg) || '网络开小差了'))
      }
    })
  })
}

function wxLogin() {
  return new Promise(function (resolve, reject) {
    wx.login({
      success: function (r) { resolve(r.code || '') },
      fail: function (e) { reject(new Error((e && e.errMsg) || 'wx.login 失败')) }
    })
  })
}

/* ---------------- 登录 ---------------- */

function login() {
  if (!state.loginPending) {
    setPhase('logging', '')
    state.loginPending = wxLogin().then(function (code) {
      return request('/api/login', {
        method: 'POST',
        data: { code: code, nickname: db.getMe().name || '' }
      })
    }).then(function (res) {
      state.token = res.token
      state.since = ''
      // 服务端首次见这个 openid 会自动开户，因此只要拿到 token 就等于完成注册/登录
      state.registered = true
      if (res.me) db.applyCloudMe(res.me)
      else if (res.me === undefined && db.getMe().id) db.replaceMyId(db.getMe().id)
      setPhase('ready', '')
      return res
    }).catch(function (e) {
      state.token = ''
      setPhase('failed', (e && e.message) || '网络开小差了')
      throw e
    })
    state.loginPending = state.loginPending.then(function (r) {
      state.loginPending = null
      return r
    }, function (e) {
      state.loginPending = null
      throw e
    })
  }
  return state.loginPending
}

/* ---------------- 同步 ---------------- */

function mergeSnapshot(res) {
  var changed = false
  var ledgers = res.ledgers || []
  var members = res.members || []
  var i
  // 服务端返回的 members 是带 ledgerId 的扁平数组，先按账本分组再交给 db.applyRemoteLedger
  var membersByLedger = {}
  for (i = 0; i < members.length; i++) {
    var m = members[i]
    if (!m || !m.ledgerId || !m.id) continue
    if (!membersByLedger[m.ledgerId]) membersByLedger[m.ledgerId] = []
    membersByLedger[m.ledgerId].push(m)
  }
  for (i = 0; i < ledgers.length; i++) {
    if (!ledgers[i] || !ledgers[i].id) continue
    if (membersByLedger[ledgers[i].id]) ledgers[i].members = membersByLedger[ledgers[i].id]
    if (db.applyRemoteLedger(ledgers[i])) changed = true
  }
  var records = res.records || []
  for (i = 0; i < records.length; i++) {
    if (db.applyRemoteRecord(records[i])) changed = true
  }
  // 云端下发的身份（头像/手机号/昵称）
  if (res.me) {
    db.applyCloudMe(res.me)
    changed = true
  }
  if (changed) db.flush()
}

function sync() {
  if (!enabled()) return Promise.resolve()
  var chain = state.token ? Promise.resolve() : login()
  return chain.then(function () {
    state.syncing = true
    var sent = db.drainDirty()
    return request('/api/sync', {
      method: 'POST',
      data: { since: state.since, ledgers: db.exportLedgersForSync(), records: sent }
    }).then(function (res) {
      mergeSnapshot(res)
      state.since = res.serverTime || nowIso()
      db.clearDirty(sent.map(function (r) { return r.id }))
      state.lastOkAt = Date.now()
      state.lastError = ''
    })
  }).catch(function (e) {
    state.lastError = (e && e.message) || '同步失败'
    if (/未登录|过期|登录/.test(state.lastError)) {
      state.token = ''
      state.since = ''
      setPhase('failed', state.lastError)
    }
  }).then(function () {
    state.syncing = false
    emit()
    return null
  })
}

/** 重新注册/登录并立刻同步一次（网络恢复、域名配好后点「重试」用） */
function retry() {
  if (!enabled()) return Promise.resolve({ ok: false, error: '云同步未开启' })
  state.token = ''
  state.since = ''
  state.loginPending = null
  state.lastError = ''
  setPhase('logging', '')
  return login().then(function () {
    return sync()
  }).then(function () {
    return { ok: true, error: state.lastError || '' }
  }).catch(function (e) {
    return { ok: false, error: (e && e.message) || state.lastError || '登录失败' }
  })
}

/** 本地写入后的防抖推送 */
function kick() {
  if (!enabled()) return
  if (state.debounceTimer) clearTimeout(state.debounceTimer)
  state.debounceTimer = setTimeout(function () {
    state.debounceTimer = null
    sync()
  }, 1500)
}

function startPolling() {
  if (state.pollTimer) return
  state.pollTimer = setInterval(function () {
    if (state.syncing) return
    sync()
  }, 20000)
}

function init() {
  if (!enabled() || state.started) return
  state.started = true
  login().then(function () {
    return sync()
  }).then(startPolling).catch(function () {})
}

/** App.onShow：切前台时拉一次增量 */
function onAppShow() {
  if (!enabled()) return
  if (state.started) {
    sync()
    startPolling()
  } else {
    init()
  }
}

/* ---------------- 尝试 ---------------- */

/** 更新我的资料（昵称 / 头像），同时写本机与云端 */
function updateProfile(patch) {
  patch = patch || {}
  // 先固定本次要写入的值：login 会把服务端旧 me 合进来，不能让它覆盖掉待发送的内容
  var nextName = patch.nickname ? String(patch.nickname).trim().slice(0, 12) : ''
  var nextAvatar = patch.avatar !== undefined ? String(patch.avatar || '').slice(0, 200000) : null
  var prevAvatar = db.getProfile().avatar || ''
  if (nextName) db.setMyName(nextName)
  if (nextAvatar !== null) db.setProfile({ avatar: nextAvatar })
  if (!enabled()) return Promise.resolve({ ok: false, error: '云同步未开启' })
  var chain = state.token ? Promise.resolve() : login()
  return chain.then(function () {
    return request('/api/user/profile', {
      method: 'POST',
      data: {
        nickname: nextName || db.getMe().name || '',
        avatar: nextAvatar !== null ? nextAvatar : (db.getProfile().avatar || '')
      }
    })
  }).then(function (res) {
    if (res.me) db.applyCloudMe(res.me)
    state.lastOkAt = Date.now()
    return { ok: true }
  }).catch(function (e) {
    // 失败时回写本地值：login 合并可能已用服务端旧值覆盖了本次修改（以及未修改的头像）
    if (nextName) db.setMyName(nextName)
    if (nextAvatar !== null) db.setProfile({ avatar: nextAvatar })
    else db.setProfile({ avatar: prevAvatar })
    return { ok: false, error: (e && e.message) || '保存失败' }
  })
}

/**
 * 绑定手机号。优先用微信 getPhoneNumber 的 code；
 * 个人主体通常没有该权限（后端返回 needManual），此时自动降级为手动填写。
 */
function bindPhone(code, manualPhone) {
  if (!enabled()) return Promise.resolve({ ok: false, error: '云同步未开启' })
  var chain = state.token ? Promise.resolve() : login()
  return chain.then(function () {
    return request('/api/user/phone', {
      method: 'POST',
      data: code ? { code: String(code) } : { phone: String(manualPhone || '') }
    })
  }).then(function (res) {
    db.setProfile({ phone: res.phone || '' })
    state.lastOkAt = Date.now()
    return { ok: true, phone: res.phone || '' }
  }).catch(function (e) {
    // 个人主体无手机号权限：服务端 400 + needManual，让前端切手动填写
    if (e && e.data && e.data.needManual) {
      return { ok: false, needManual: true, error: e.data.error || '请手动填写手机号' }
    }
    return { ok: false, error: (e && e.message) || '绑定失败' }
  })
}

/* ---------------- 会员（个人虚拟支付：道具直购） ---------------- */

/** iOS 支付前置校验：微信客户端需 ≥ 8.0.68 */
function iosWechatPayOk() {
  try {
    var sys = wx.getSystemInfoSync()
    if (sys.platform !== 'ios') return true
    var cur = (sys.version || '').split('.').map(Number)
    var base = [8, 0, 68]
    for (var i = 0; i < 3; i++) {
      if ((cur[i] || 0) > base[i]) return true
      if ((cur[i] || 0) < base[i]) return false
    }
    return true
  } catch (e) {
    return true
  }
}

/** 下单 → 拉起支付 → 轮询确认发货。返回 { ok } 或 { ok:false, error/needUpdate } */
function purchaseVip(productId) {
  if (!enabled()) return Promise.resolve({ ok: false, error: '云同步未开启' })
  if (!iosWechatPayOk()) return Promise.resolve({ ok: false, needUpdate: true, error: '请将微信更新至最新版后再支付' })
  var chain = state.token ? Promise.resolve() : login()
  return chain.then(function () {
    return request('/api/pay/order', { method: 'POST', data: { productId: productId } })
  }).then(function (order) {
    return new Promise(function (resolve) {
      var payData = {
        signData: order.signData,
        mode: order.mode || 'short_series_goods',
        paySig: order.paySig,
        signature: order.signature
      }
      wx.requestVirtualPayment({
        signData: payData.signData,
        mode: payData.mode,
        paySig: payData.paySig,
        signature: payData.signature,
        success: function () { confirmVip(order.signData).then(resolve) },
        fail: function (err) { resolve({ ok: false, error: (err && err.errMsg) || '支付失败' }) }
      })
    })
  }).then(function (res) {
    if (res && res.ok) state.lastOkAt = Date.now()
    return res
  }).catch(function (e) {
    return { ok: false, error: (e && e.message) || '下单失败' }
  })
}

/** 支付成功后轮询后端，确认发货（推送可能丢失，后端主动 query_order 兜底） */
function confirmVip(signDataStr) {
  function outTradeNoOf(s) {
    try { var o = JSON.parse(s || '{}'); return o.outTradeNo || '' } catch (e) { return '' }
  }
  var trade = outTradeNoOf(signDataStr)
  function poll(times) {
    var call = request('/api/vip/status', { method: 'GET' }).then(function (r) {
      if (r.vip) {
        db.setProfile({ vip: true })
        return { ok: true, vip: true }
      }
      if (times <= 1) return { ok: false, pending: true, error: '支付已受理，会员权益稍后自动生效' }
      return new Promise(function (res) { setTimeout(function () { poll(times - 1).then(res) }, 2000) })
    }).catch(function () {
      if (times <= 1) return { ok: false, pending: true, error: '支付已受理，会员权益稍后自动生效' }
      return new Promise(function (res) { setTimeout(function () { poll(times - 1).then(res) }, 2000) })
    })
    return call
  }
  return poll(10)
}

/* ---------------- 邀请 / 加入 ---------------- */

function currentInviteCode() {
  var l = db.currentLedger()
  return l && l.inviteCode ? l.inviteCode : ''
}

/** 凭邀请码加入账本，返回 { ok, ledgerId, added } 或 { ok:false, error } */
function joinLedger(code) {
  if (!enabled()) return Promise.resolve({ ok: false, error: '云同步未开启' })
  var chain = state.token ? Promise.resolve() : login()
  return chain.then(function () {
    return request('/api/ledgers/join', {
      method: 'POST',
      data: { inviteCode: String(code || '').trim(), nickname: db.getMe().name || '成员' }
    })
  }).then(function (res) {
    mergeSnapshot(res)
    if (res.ledgerId) db.setCurrentLedger(res.ledgerId)
    state.lastOkAt = Date.now()
    state.lastError = ''
    return { ok: true, ledgerId: res.ledgerId, added: (res.records || []).length }
  }).catch(function (e) {
    return { ok: false, error: (e && e.message) || '加入失败' }
  })
}

/* ---------------- 状态 ---------------- */

function statusText() {
  if (!enabled()) return '本地模式'
  if (state.syncing) return '云端同步中…'
  if (state.lastError) return '云同步失败：' + state.lastError
  if (state.lastOkAt) {
    var d = new Date(state.lastOkAt)
    var hh = ('0' + d.getHours()).slice(-2)
    var mm = ('0' + d.getMinutes()).slice(-2)
    return '已同步 ' + hh + ':' + mm
  }
  return '云同步待连接'
}

/** 给页面用的账号/同步状态快照 */
function accountState() {
  var phase = enabled() ? state.phase : 'off'
  var tone = 'idle'
  if (phase === 'logging') tone = 'busy'
  else if (phase === 'ready') tone = 'ok'
  else if (phase === 'failed') tone = 'bad'
  return {
    enabled: enabled(),
    phase: phase,
    tone: tone,
    logged: !!state.token,
    registered: state.registered,
    error: state.loginError || state.lastError || '',
    text: statusText(),
    tip: accountTip(phase)
  }
}

function accountTip(phase) {
  if (phase === 'off') return '本地模式'
  if (phase === 'logging') return '正在创建/登录你的账号…'
  if (phase === 'ready') return '账号已就绪'
  if (phase === 'failed') return '连接服务器失败'
  return '等待连接服务器'
}

module.exports = {
  enabled: enabled,
  init: init,
  onAppShow: onAppShow,
  onChange: onChange,
  kick: kick,
  sync: sync,
  retry: retry,
  accountState: accountState,
  joinLedger: joinLedger,
  updateProfile: updateProfile,
  bindPhone: bindPhone,
  purchaseVip: purchaseVip,
  currentInviteCode: currentInviteCode,
  statusText: statusText
}
