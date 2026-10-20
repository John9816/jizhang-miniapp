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
  started: false
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
    state.loginPending = wxLogin().then(function (code) {
      return request('/api/login', {
        method: 'POST',
        data: { code: code, nickname: db.getMe().name || '' }
      })
    }).then(function (res) {
      state.token = res.token
      state.since = ''
      if (res.me) db.applyCloudMe(res.me)
      else if (res.me === undefined && db.getMe().id) db.replaceMyId(db.getMe().id)
      return res
    }).catch(function (e) {
      state.token = ''
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
    }
  }).then(function () {
    state.syncing = false
    return null
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
  var nextAvatar = patch.avatar !== undefined ? String(patch.avatar || '').slice(0, 512) : null
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

module.exports = {
  enabled: enabled,
  init: init,
  onAppShow: onAppShow,
  kick: kick,
  sync: sync,
  joinLedger: joinLedger,
  updateProfile: updateProfile,
  bindPhone: bindPhone,
  currentInviteCode: currentInviteCode,
  statusText: statusText
}
