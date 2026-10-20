/**
 * 本地数据层：身份 / 账本 / 记录，持久化在 wx storage。
 * 所有页面只通过本模块读写数据；后续如需切换云端同步，只需替换本文件实现。
 */

var u = require('./util.js')

var STORAGE_KEY = 'jizhang.db.v1'
var HIDDEN_KEY = 'jizhang.hidden.v1'
var db = null
var listeners = []
var hiddenIds = {}

function isoNow() { return new Date().toISOString() }

/** 兼容旧数据的数字时间戳 → ISO 字符串 */
function toIso(v) {
  if (typeof v === 'number' && isFinite(v)) return new Date(v).toISOString()
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return v
  return isoNow()
}

function emitChange() {
  for (var i = 0; i < listeners.length; i++) {
    try { listeners[i]() } catch (e) {}
  }
  notifyCloud()
}

/** 本地有写入时通知云端同步层（懒加载避免循环依赖） */
function notifyCloud() {
  try {
    var cloud = require('./cloud.js')
    if (cloud.kick) cloud.kick()
  } catch (e) {}
}

function saveHidden() {
  try { wx.setStorageSync(HIDDEN_KEY, JSON.stringify(Object.keys(hiddenIds))) } catch (e) {}
}

function defaultDb() {
  return {
    me: { id: u.genId('u'), name: '', profile: { avatar: '', phone: '' } },
    ledgers: [],
    records: [],
    currentLedgerId: '',
    imported: {}
  }
}

/** 账本级新模型缺省值（老数据迁移用） */
function defaultLedgerExtras() {
  return {
    accounts: u.defaultAccounts(),
    budget: { monthlyTotal: 0, categoryBudgets: {} },
    recurring: [],
    categories: [],
    challenges: []
  }
}

function ensureExtras(l) {
  var d = defaultLedgerExtras()
  if (!Array.isArray(l.accounts) || !l.accounts.length) l.accounts = d.accounts
  if (!l.budget || typeof l.budget !== 'object') l.budget = d.budget
  if (!l.budget.categoryBudgets) l.budget.categoryBudgets = {}
  if (!Array.isArray(l.recurring)) l.recurring = []
  if (!Array.isArray(l.categories)) l.categories = []
  if (!Array.isArray(l.challenges)) l.challenges = []
  if (!l.cfgAt) l.cfgAt = isoNow()
}

function loadRaw() {
  try {
    var raw = wx.getStorageSync(STORAGE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch (e) {
    return null
  }
}

function persist() {
  try {
    wx.setStorageSync(STORAGE_KEY, JSON.stringify(db))
  } catch (e) {
    console.error('[jizhang] persist failed', e && e.message)
  }
  emitChange()
}

function ensure() {
  if (!db) init()
  return db
}

function init() {
  db = loadRaw() || defaultDb()
  try {
    var hid = wx.getStorageSync(HIDDEN_KEY)
    if (hid) {
      var arr = JSON.parse(hid)
      for (var i = 0; i < arr.length; i++) hiddenIds[String(arr[i])] = true
    }
  } catch (e) {}
  if (!db.me || !db.me.id) db.me = { id: u.genId('u'), name: '', profile: { avatar: '', phone: '' } }
  if (!db.me.profile || typeof db.me.profile !== 'object') db.me.profile = { avatar: (db.me.avatar || ''), phone: '' }
  if (!db.imported || typeof db.imported !== 'object') db.imported = {}
  if (!Array.isArray(db.ledgers)) db.ledgers = []
  if (!Array.isArray(db.records)) db.records = []
  var li
  for (li = 0; li < db.ledgers.length; li++) ensureExtras(db.ledgers[li])
  if (db.ledgers.length === 0) createLedger('我的账本')
  if (!getLedger(db.currentLedgerId)) db.currentLedgerId = db.ledgers[0].id
  persist()
}

/* ---------------- 身份 ---------------- */

function getMe() {
  ensure()
  return db.me
}

/** 本机资料（头像 / 手机号），随账本同步只在云端侧保留，本地为展示兜底 */
function getProfile() {
  ensure()
  var p = db.me.profile || {}
  return {
    id: db.me.id,
    name: db.me.name || '',
    avatar: p.avatar || '',
    phone: p.phone || ''
  }
}

/**
 * 合并云端下发的身份（login / sync 快照里的 me）。
 * 昵称走 setMyName 的那套联动（成员名 + 记录人名快照），头像/手机号只更新本机。
 */
function applyCloudMe(me) {
  ensure()
  if (!me || typeof me !== 'object') return getProfile()
  if (me.id && me.id !== db.me.id) replaceMyId(me.id)
  if (me.name != null && String(me.name).trim()) setMyName(String(me.name))
  db.me.profile = db.me.profile || { avatar: '', phone: '' }
  if (me.avatar != null) {
    var av = String(me.avatar || '')
    db.me.profile.avatar = av.slice(0, 512)
  }
  if (me.phone != null) {
    var ph = String(me.phone || '')
    db.me.profile.phone = ph.slice(0, 20)
  }
  persist()
  return getProfile()
}

/** 本地更新资料（授权头像昵称成功后立即写，云端推送由 cloud 层负责） */
function setProfile(patch) {
  ensure()
  patch = patch || {}
  if (patch.avatar !== undefined) db.me.profile.avatar = String(patch.avatar || '').slice(0, 512)
  if (patch.phone !== undefined) db.me.profile.phone = String(patch.phone || '').slice(0, 20)
  persist()
  return getProfile()
}

/** 设置我的昵称：同步更新各账本成员表和我名下的记录快照 */
function setMyName(name) {
  ensure()
  var n = String(name == null ? '' : name).trim().slice(0, 12) || '我'
  db.me.name = n
  var i
  for (i = 0; i < db.ledgers.length; i++) {
    var l = db.ledgers[i]
    if (l.members[db.me.id]) l.members[db.me.id].name = n
    if (l.ownerId === db.me.id) l.ownerName = n
  }
  for (i = 0; i < db.records.length; i++) {
    if (db.records[i].memberId === db.me.id) db.records[i].memberName = n
  }
  persist()
  return db.me
}

/* ---------------- 账本 ---------------- */

function createLedger(name) {
  ensure()
  var me = db.me
  var ledger = {
    id: u.genId('L'),
    name: String(name == null ? '' : name).trim().slice(0, 20) || '新账本',
    ownerId: me.id,
    ownerName: me.name || '我',
    createdAt: Date.now(),
    members: {}
  }
  var extras = defaultLedgerExtras()
  ledger.accounts = extras.accounts
  ledger.budget = extras.budget
  ledger.recurring = extras.recurring
  ledger.categories = extras.categories
  ledger.cfgAt = isoNow()
  ledger.members[me.id] = { id: me.id, name: me.name || '我', joinedAt: Date.now() }
  db.ledgers.push(ledger)
  db.currentLedgerId = ledger.id
  persist()
  return ledger
}

function getLedger(id) {
  ensure()
  for (var i = 0; i < db.ledgers.length; i++) {
    if (db.ledgers[i].id === id) return db.ledgers[i]
  }
  return null
}

function currentLedger() {
  ensure()
  return getLedger(db.currentLedgerId)
}

function setCurrentLedger(id) {
  ensure()
  if (getLedger(id)) {
    db.currentLedgerId = id
    persist()
  }
  return currentLedger()
}

function renameLedger(id, name) {
  ensure()
  var l = getLedger(id)
  if (!l) return null
  l.name = String(name == null ? '' : name).trim().slice(0, 20) || l.name
  persist()
  return l
}

function deleteLedger(id) {
  ensure()
  db.ledgers = db.ledgers.filter(function (l) { return l.id !== id })
  db.records = db.records.filter(function (r) { return r.ledgerId !== id })
  hiddenIds[id] = true
  saveHidden()
  if (db.ledgers.length === 0) createLedger('我的账本')
  else if (db.currentLedgerId === id) db.currentLedgerId = db.ledgers[0].id
  persist()
  return currentLedger()
}

function listLedgers() {
  ensure()
  return db.ledgers.map(function (l) {
    return {
      id: l.id,
      name: l.name,
      createdAt: l.createdAt,
      isCurrent: l.id === db.currentLedgerId,
      memberCount: Object.keys(l.members).length
    }
  })
}

/* ---------------- 记录 ---------------- */

function recordsOf(ledgerId) {
  ensure()
  return db.records.filter(function (r) { return r.ledgerId === ledgerId && !r.deleted })
}

function getRecord(id) {
  ensure()
  for (var i = 0; i < db.records.length; i++) {
    if (db.records[i].id === id) return db.records[i]
  }
  return null
}

function addRecord(fields) {
  ensure()
  var amount = Math.round(Number(fields.amount))
  if (!isFinite(amount) || amount <= 0) return null
  var me = db.me
  var now = isoNow()
  var type = fields.type === 'income' ? 'income' : (fields.type === 'transfer' ? 'transfer' : 'expense')
  var rec = {
    id: fields.id || u.genId('R'),
    ledgerId: fields.ledgerId,
    memberId: me.id,
    memberName: me.name || '我',
    type: type,
    amount: amount,
    category: type === 'transfer' ? 'transfer' : fields.category,
    date: fields.date,
    note: String(fields.note == null ? '' : fields.note).trim().slice(0, 50),
    createdAt: now,
    updatedAt: now,
    dirty: true
  }
  // 外部账单导入来源（微信/支付宝流水），仅存本机，用于对账与去重
  if (fields.external && fields.external.src) {
    rec.external = {
      src: String(fields.external.src).slice(0, 16),
      txn: String(fields.external.txn || '').slice(0, 64),
      party: String(fields.external.party || '').slice(0, 40)
    }
  }
  if (type === 'transfer') {
    rec.accountId = String(fields.accountId || '')
    rec.transferTo = String(fields.transferTo || '')
    rec.transferToName = String(fields.transferToName || '')
    if (!rec.accountId || !rec.transferTo || rec.accountId === rec.transferTo) return null
  } else if (fields.accountId) {
    rec.accountId = String(fields.accountId)
  }
  db.records.push(rec)
  persist()
  return rec
}

function updateRecord(id, fields) {
  ensure()
  var rec = getRecord(id)
  if (!rec) return null
  var amount = Math.round(Number(fields.amount))
  if (!isFinite(amount) || amount <= 0) return null
  rec.amount = amount
  rec.type = fields.type === 'income' ? 'income' : (fields.type === 'transfer' ? 'transfer' : 'expense')
  if (rec.type === 'transfer') {
    rec.accountId = String(fields.accountId || '')
    rec.transferTo = String(fields.transferTo || '')
    rec.transferToName = String(fields.transferToName || '')
    rec.category = 'transfer'
    if (!rec.accountId || !rec.transferTo || rec.accountId === rec.transferTo) return null
  } else {
    rec.category = fields.category
    if (fields.accountId) rec.accountId = String(fields.accountId)
    delete rec.transferTo
    delete rec.transferToName
  }
  rec.date = fields.date
  rec.note = String(fields.note == null ? '' : fields.note).trim().slice(0, 50)
  rec.updatedAt = isoNow()
  rec.dirty = true
  persist()
  return rec
}

/** 账户间转账：生成一条 transfer 记录 */
function addTransfer(fields) {
  return addRecord({
    ledgerId: fields.ledgerId,
    type: 'transfer',
    amount: fields.amount,
    date: fields.date,
    note: fields.note,
    accountId: fields.fromId,
    transferTo: fields.toId,
    transferToName: fields.toName
  })
}

/** 软删除：置墓碑并标记脏数据，等待云端同步删除 */
function deleteRecord(id) {
  ensure()
  var rec = getRecord(id)
  if (!rec || rec.deleted) return false
  rec.deleted = true
  rec.updatedAt = isoNow()
  rec.dirty = true
  persist()
  return true
}

/** 账本累计统计 */
function statsOf(ledgerId) {
  var recs = recordsOf(ledgerId)
  var s = u.calcSummary(recs)
  return { count: recs.length, income: s.income, expense: s.expense, balance: s.balance }
}

/* ---------------- 账本配置：账户 / 预算 / 周期 / 分类 ---------------- */

function withLedger(ledgerId, fn) {
  ensure()
  var l = getLedger(ledgerId)
  if (!l) return null
  ensureExtras(l)
  var out = fn(l)
  l.cfgAt = isoNow()
  persist()
  return out === undefined ? null : out
}

/* ---- 账户 ---- */

function accountsOf(ledgerId) {
  ensure()
  var l = getLedger(ledgerId)
  if (!l) return []
  ensureExtras(l)
  return l.accounts.slice().sort(function (a, b) { return (a.sortIndex || 0) - (b.sortIndex || 0) })
}

function saveAccounts(ledgerId, accounts) {
  return withLedger(ledgerId, function (l) {
    var out = []
    for (var i = 0; i < (accounts || []).length && i < 30; i++) {
      var a = accounts[i]
      if (!a || !a.name) continue
      out.push({
        id: String(a.id || u.genId('acc')),
        name: String(a.name).slice(0, 12),
        type: String(a.type || 'other'),
        initialBalance: Math.round(Number(a.initialBalance) || 0),
        sortIndex: i
      })
    }
    l.accounts = out
    return out
  })
}

/** 资产汇总：各账户余额、净资产、转账流水 */
function assetSummary(ledgerId) {
  ensure()
  var l = getLedger(ledgerId)
  if (!l) return { accounts: [], netWorth: 0 }
  ensureExtras(l)
  var records = db.records.filter(function (r) { return r.ledgerId === ledgerId && !r.deleted })
  var accounts = l.accounts.map(function (a) {
    var bal = u.accountBalance(a, records)
    return {
      id: a.id, name: a.name, type: a.type,
      icon: u.accountTypeInfo(a.type).icon,
      balance: bal,
      balanceText: u.formatCents(bal)
    }
  })
  var net = 0
  for (var i = 0; i < accounts.length; i++) net += accounts[i].balance
  return { accounts: accounts, netWorth: net, netWorthText: u.formatCents(net) }
}

/* ---- 预算 ---- */

function budgetOf(ledgerId) {
  ensure()
  var l = getLedger(ledgerId)
  if (!l) return { monthlyTotal: 0, categoryBudgets: {} }
  ensureExtras(l)
  return l.budget
}

function saveBudget(ledgerId, budget) {
  return withLedger(ledgerId, function (l) {
    var cats = {}
    var src = (budget && budget.categoryBudgets) || {}
    var keys = Object.keys(src)
    for (var i = 0; i < keys.length; i++) {
      var v = Math.round(Number(src[keys[i]]) || 0)
      if (v > 0) cats[keys[i]] = v
    }
    l.budget = {
      monthlyTotal: Math.max(0, Math.round(Number(budget && budget.monthlyTotal) || 0)),
      categoryBudgets: cats
    }
    return l.budget
  })
}

/* ---- 周期记账 ---- */

function recurringList(ledgerId) {
  ensure()
  var l = getLedger(ledgerId)
  if (!l) return []
  ensureExtras(l)
  return l.recurring.map(function (r) {
    return {
      id: r.id, name: r.name, amount: r.amount, type: r.type, category: r.category,
      accountId: r.accountId, note: r.note, cycle: r.cycle, nextDate: r.nextDate,
      lastRunAt: r.lastRunAt, paused: !!r.paused, createdAt: r.createdAt
    }
  })
}

function addRecurring(ledgerId, fields) {
  return withLedger(ledgerId, function (l) {
    var amount = Math.round(Number(fields.amount))
    if (!isFinite(amount) || amount <= 0) return null
    var rule = {
      id: u.genId('rr'),
      name: String(fields.name || '').slice(0, 20) || '周期记账',
      amount: amount,
      type: fields.type === 'income' ? 'income' : 'expense',
      category: String(fields.category || 'other_out'),
      accountId: fields.accountId ? String(fields.accountId) : '',
      note: String(fields.note || '').slice(0, 50),
      cycle: ['weekly', 'monthly', 'quarterly', 'yearly'].indexOf(fields.cycle) >= 0 ? fields.cycle : 'monthly',
      nextDate: /^\d{4}-\d{2}-\d{2}$/.test(fields.nextDate || '') ? fields.nextDate : u.dateStr(new Date()),
      createdAt: isoNow(),
      paused: false
    }
    l.recurring.push(rule)
    return rule
  })
}

function removeRecurring(ledgerId, id) {
  return withLedger(ledgerId, function (l) {
    var before = l.recurring.length
    l.recurring = l.recurring.filter(function (r) { return r.id !== id })
    return before !== l.recurring.length
  })
}

function toggleRecurring(ledgerId, id) {
  return withLedger(ledgerId, function (l) {
    for (var i = 0; i < l.recurring.length; i++) {
      if (l.recurring[i].id === id) {
        l.recurring[i].paused = !l.recurring[i].paused
        return l.recurring[i].paused
      }
    }
    return null
  })
}

/**
 * 执行到期周期规则：为每条到期规则生成记录（id = ruleId@date 幂等，
 * 两端设备各自执行也会去重），推进 nextDate。返回新生成的记录数组。
 */
function runDueRecurring(ledgerId, today) {
  ensure()
  today = today || u.dateStr(new Date())
  var l = getLedger(ledgerId)
  if (!l) return []
  ensureExtras(l)
  var me = db.me
  var generated = []
  var now = isoNow()
  for (var i = 0; i < l.recurring.length; i++) {
    var r = l.recurring[i]
    if (r.paused || !r.nextDate) continue
    var guard = 0
    while (r.nextDate <= today && guard < 60) {
      guard++
      var rid = r.id + '@' + r.nextDate
      var exists = false
      for (var j = 0; j < db.records.length; j++) {
        if (db.records[j].id === rid) { exists = true; break }
      }
      if (!exists) {
        db.records.push({
          id: rid,
          ledgerId: ledgerId,
          memberId: me.id,
          memberName: me.name || '我',
          type: r.type,
          amount: r.amount,
          category: r.type === 'income' ? r.category : r.category,
          accountId: r.accountId || '',
          date: r.nextDate,
          note: (r.name + (r.note ? ' · ' + r.note : '')).slice(0, 50),
          createdAt: now,
          updatedAt: now,
          dirty: true,
          byRecurring: r.id
        })
        generated.push(rid)
      }
      r.lastRunAt = r.nextDate
      r.nextDate = u.nextRunDate(r)
    }
  }
  if (generated.length) {
    l.cfgAt = now
    persist()
  }
  return generated
}

/* ---- 自定义分类 ---- */

/** 可用分类列表：自定义优先，为空回退内置；按 sortIndex */
function categoriesOf(ledgerId, type) {
  ensure()
  var l = getLedger(ledgerId)
  if (l) ensureExtras(l)
  var custom = l ? l.categories.filter(function (c) { return c.type === type && !c.removed }) : []
  if (custom.length) {
    return custom
      .slice()
      .sort(function (a, b) { return (a.sortIndex || 0) - (b.sortIndex || 0) })
      .map(function (c) { return { key: c.key, name: c.name, icon: c.icon, custom: true } })
  }
  return u.categoriesFor(type)
}

function saveCategories(ledgerId, type, list) {
  return withLedger(ledgerId, function (l) {
    var others = l.categories.filter(function (c) { return c.type !== type })
    var out = []
    for (var i = 0; i < (list || []).length && i < 40; i++) {
      var c = list[i]
      if (!c || !c.name) continue
      out.push({
        key: String(c.key || ('c_' + i + '_' + Math.random().toString(36).slice(2, 6))),
        name: String(c.name).slice(0, 8) || '分类',
        icon: String(c.icon || '✨').slice(0, 4),
        type: type,
        sortIndex: i,
        removed: false
      })
    }
    l.categories = others.concat(out)
    return out
  })
}

/* ---- 搜索 ---- */

/** 组合筛选搜索：q 关键词(备注/分类名)、分类、成员、类型、起止日期、金额区间(分) */
function searchRecords(ledgerId, query) {
  ensure()
  query = query || {}
  var q = String(query.q || '').trim().toLowerCase()
  var out = db.records.filter(function (r) {
    if (r.ledgerId !== ledgerId || r.deleted) return false
    if (query.type && r.type !== query.type) return false
    if (query.category && r.category !== query.category) return false
    if (query.memberId && r.memberId !== query.memberId) return false
    if (query.start && r.date < query.start) return false
    if (query.end && r.date > query.end) return false
    if (query.minAmount && r.amount < query.minAmount) return false
    if (query.maxAmount && r.amount > query.maxAmount) return false
    if (q) {
      var catName = r.type === 'transfer' ? '转账' : u.categoryName(r.type, r.category)
      var hay = (r.note + ' ' + catName + ' ' + (r.accountName || '') + ' ' + r.memberName).toLowerCase()
      if (hay.indexOf(q) < 0) return false
    }
    return true
  })
  out.sort(function (a, b) { return a.date < b.date ? 1 : -1 })
  return out
}

/* ---------------- 外部账单导入 / 对账 ---------------- */

/** 生成一条外部流水的稳定键：有交易单号用单号，否则退化为 日期+金额+序号 */
function txnKey(row) {
  var src = String(row.src || '').slice(0, 16)
  var txn = String(row.txn || '').trim()
  if (txn) return src + '#' + txn
  return src + '#' + String(row.date || '') + '#' + (Number(row.amount) || 0) + '#' + String(row.party || '').slice(0, 20)
}

/** 本机已入账的外部键集合（从记录快照反推，兼容换设备后首次对账） */
function importedKeySet() {
  ensure()
  var keys = {}
  var i
  for (i = 0; i < db.records.length; i++) {
    var r = db.records[i]
    if (!r.deleted && r.external && r.external.src) keys[txnKey(r.external)] = true
  }
  // db.imported 是旧版冗余表，保留兼容
  var saved = db.imported || {}
  for (i = 0; i < Object.keys(saved).length; i++) {
    var k = Object.keys(saved)[i]
    keys[k] = true
  }
  return keys
}

/**
 * 批量入账外部流水（按 txn 键去重）。
 * opts: { category, accountId, note } —— 默认分类/账户/备注
 * 返回 { added: [recordIds], skipped: Number, dupes: Number }
 */
function importRows(ledgerId, rows, opts) {
  ensure()
  if (!getLedger(ledgerId)) return { added: [], skipped: 0, dupes: 0 }
  opts = opts || {}
  var seen = importedKeySet()
  var added = []
  var dupes = 0
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i]
    if (row.type !== 'expense' && row.type !== 'income') continue
    var amount = Math.round(Number(row.amount))
    if (!isFinite(amount) || amount <= 0) continue
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date || '')) continue
    var key = txnKey(row)
    if (seen[key]) { dupes++; continue }
    var rec = addRecord({
      ledgerId: ledgerId,
      type: row.type,
      amount: amount,
      date: row.date,
      category: opts.category || row.category || (row.type === 'income' ? 'salary' : 'food'),
      accountId: opts.accountId || '',
      note: row.note || (row.party || ''),
      external: { src: row.src, txn: row.txn, party: row.party }
    })
    if (!rec) continue
    seen[key] = true
    added.push(rec.id)
  }
  return { added: added, skipped: rows.length - added.length, dupes: dupes }
}

/**
 * 对账：把一段外部流水和本机记录比对。
 * 返回 { rows: [...], matched, missing, extra } —— missing=流水里有但本机没有，extra=本机多出的。
 */
function reconcile(ledgerId, rows) {
  ensure()
  var recs = recordsOf(ledgerId).filter(function (r) {
    return r.type === 'expense' || r.type === 'income'
  })
  // 本机按「日期+金额+方向」建索引，用于外部流水回查
  var localIndex = {}
  recs.forEach(function (r) {
    var k = r.date + '|' + r.amount + '|' + r.type
    if (!localIndex[k]) localIndex[k] = []
    localIndex[k].push(r)
  })
  var usedIds = {}
  var out = []
  var matched = 0
  var missing = 0
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i]
    var amount = Math.round(Number(row.amount))
    var key = (row.date || '') + '|' + amount + '|' + row.type
    var cand = localIndex[key] || []
    var hit = null
    for (var j = 0; j < cand.length; j++) {
      if (!usedIds[cand[j].id]) { hit = cand[j]; break }
    }
    var status = 'missing'
    if (hit) { usedIds[hit.id] = true; status = 'matched'; matched++ }
    else { missing++ }
    out.push({
      idx: i,
      row: row,
      amountText: (row.type === 'income' ? '+' : '-') + u.formatCents(amount),
      status: status,
      recordId: hit ? hit.id : '',
      localNote: hit ? (hit.note || '') : '',
      key: txnKey(row)
    })
  }
  var extra = recs.filter(function (r) { return !usedIds[r.id] })
  return { rows: out, matched: matched, missing: missing, extra: extra }
}

/* ---- 导出 ---- */

/**
 * 导出为「通用对账格式」：日期,摘要,收/支,金额,来源
 * 与微信/支付宝导出的字段风格对齐，可直接在两边的账单管理里导入核对，
 * 也能被本小程序的导入页反向解析。
 */
function exportReconcileCSV(ledgerId) {
  ensure()
  var l = getLedger(ledgerId)
  if (!l) return ''
  var recs = db.records
    .filter(function (r) { return r.ledgerId === ledgerId && !r.deleted })
    .filter(function (r) { return r.type === 'expense' || r.type === 'income' })
  recs.sort(function (a, b) { return a.date < b.date ? 1 : -1 })
  var lines = ['\ufeff交易时间,摘要,收/支,金额(元),来源']
  for (var i = 0; i < recs.length; i++) {
    var r = recs[i]
    var src = r.external && r.external.src === 'alipay' ? '支付宝'
      : (r.external && r.external.src === 'wechat' ? '微信账单' : '记账本')
    lines.push([
      r.date,
      r.note || '',
      r.type === 'income' ? '收入' : '支出',
      (Math.abs(r.amount) / 100).toFixed(2),
      src
    ].map(u.csvCell).join(','))
  }
  return lines.join('\n')
}

function exportCSV(ledgerId) {
  ensure()
  var l = getLedger(ledgerId)
  if (!l) return ''
  ensureExtras(l)
  var accName = {}
  for (var i = 0; i < l.accounts.length; i++) accName[l.accounts[i].id] = l.accounts[i].name
  var records = db.records
    .filter(function (r) { return r.ledgerId === ledgerId && !r.deleted })
    .map(function (r) {
      var c = Object.assign({}, r)
      c.accountName = r.accountId ? (accName[r.accountId] || '') : ''
      c.transferToName = r.transferTo ? (accName[r.transferTo] || '') : (r.transferToName || '')
      return c
    })
  records.sort(function (a, b) { return a.date < b.date ? 1 : -1 })
  return u.recordsToCSV(records, l.name)
}

/* ---------------- 分享（本地版：分享包快照） ---------------- */

/** 导出账本 + 全部记录为分享包字符串 */
function sharePackage(ledgerId) {
  ensure()
  var ledger = getLedger(ledgerId)
  if (!ledger) return ''
  var payload = {
    v: 1,
    app: 'jizhang',
    exportedAt: Date.now(),
    ledger: ledger,
    records: recordsOf(ledgerId)
  }
  return u.encodeSharePayload(payload)
}

/**
 * 导入分享包：合并账本、成员与记录（按 id 去重），并切换为该账本。
 * 返回 { ok, ledgerId, added } 或 { ok:false, error }
 */
function importSharePackage(text) {
  ensure()
  var payload = u.decodeSharePayload(text)
  if (!payload || !payload.ledger || !payload.ledger.id || !Array.isArray(payload.records)) {
    return { ok: false, error: '分享包格式不正确，请检查后重试' }
  }
  var l = payload.ledger
  var me = db.me
  var ledger = getLedger(l.id)
  if (!ledger) {
    var fx = defaultLedgerExtras()
    ledger = {
      id: String(l.id),
      name: String(l.name || '共享账本').slice(0, 20),
      ownerId: String(l.ownerId || ''),
      ownerName: String(l.ownerName || ''),
      createdAt: Number(l.createdAt) || Date.now(),
      inviteCode: String(l.inviteCode || ''),
      members: {},
      accounts: Array.isArray(l.accounts) && l.accounts.length ? l.accounts : fx.accounts,
      budget: l.budget && typeof l.budget === 'object' ? l.budget : fx.budget,
      recurring: Array.isArray(l.recurring) ? l.recurring : [],
      categories: Array.isArray(l.categories) ? l.categories : [],
      cfgAt: isoNow()
    }
    db.ledgers.push(ledger)
  }
  var i
  var lm = l.members || {}
  var ids = Object.keys(lm)
  for (i = 0; i < ids.length; i++) {
    var mid = String(ids[i])
    var src = lm[ids[i]] || {}
    var cur = ledger.members[mid]
    ledger.members[mid] = {
      id: mid,
      name: (cur && cur.name) || String(src.name || '成员').slice(0, 12),
      joinedAt: (cur && cur.joinedAt) || Number(src.joinedAt) || Date.now()
    }
  }
  if (!ledger.members[me.id]) {
    ledger.members[me.id] = { id: me.id, name: me.name || '我', joinedAt: Date.now() }
  }
  var existing = {}
  var recs = recordsOf(ledger.id)
  for (i = 0; i < recs.length; i++) existing[recs[i].id] = true
  var added = 0
  for (i = 0; i < payload.records.length; i++) {
    var r = payload.records[i]
    if (!r || !r.id || existing[r.id]) continue
    if (r.type !== 'income' && r.type !== 'expense') continue
    var amount = Math.round(Number(r.amount))
    if (!isFinite(amount) || amount <= 0) continue
    var date = String(r.date || '')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    db.records.push({
      id: String(r.id),
      ledgerId: ledger.id,
      memberId: String(r.memberId || ''),
      memberName: String(r.memberName || '成员').slice(0, 12),
      type: r.type,
      amount: amount,
      category: String(r.category || 'other_out'),
      date: date,
      note: String(r.note == null ? '' : r.note).slice(0, 50),
      createdAt: toIso(r.createdAt),
      updatedAt: toIso(r.updatedAt),
      deleted: false,
      dirty: true
    })
    existing[String(r.id)] = true
    added++
  }
  db.currentLedgerId = ledger.id
  persist()
  return { ok: true, ledgerId: ledger.id, added: added }
}

/* ---------------- 云端同步支撑（供 utils/cloud.js 调用） ---------------- */

/** 订阅本地数据变更；返回取消订阅函数 */
function onChange(fn) {
  listeners.push(fn)
  return function () {
    var i = listeners.indexOf(fn)
    if (i >= 0) listeners.splice(i, 1)
  }
}

/** 云端登录后：把本机旧身份 id 换成服务端 openid（成员、记录归属一起迁移） */
function replaceMyId(newId) {
  ensure()
  var oldId = db.me.id
  if (!newId || newId === oldId) return db.me
  var i
  db.me.id = newId
  for (i = 0; i < db.ledgers.length; i++) {
    var l = db.ledgers[i]
    if (l.ownerId === oldId) l.ownerId = newId
    var m = l.members[oldId]
    if (m) {
      delete l.members[oldId]
      m.id = newId
      l.members[newId] = m
    }
  }
  for (i = 0; i < db.records.length; i++) {
    if (db.records[i].memberId === oldId) db.records[i].memberId = newId
  }
  persist()
  return db.me
}

/** 推送用的账本列表（含成员明细与账本级配置，排除已退出的账本） */
function exportLedgersForSync() {
  ensure()
  return db.ledgers.filter(function (l) { return !hiddenIds[l.id] }).map(function (l) {
    ensureExtras(l)
    var members = Object.keys(l.members).map(function (mid) {
      return { id: mid, name: l.members[mid].name || '', joinedAt: toIso(l.members[mid].joinedAt) }
    })
    return {
      id: l.id,
      name: l.name,
      createdAt: toIso(l.createdAt),
      ownerId: l.ownerId,
      ownerName: l.ownerName || '',
      members: members,
      accounts: l.accounts,
      budget: l.budget,
      recurring: l.recurring,
      categories: l.categories,
      challenges: l.challenges,
      cfgAt: toIso(l.cfgAt)
    }
  })
}

/** 取出待推送的脏记录（不清理标记，推送成功后由 clearDirty 清理） */
function drainDirty() {
  ensure()
  var out = []
  for (var i = 0; i < db.records.length; i++) {
    if (db.records[i].dirty) out.push({
      id: db.records[i].id,
      ledgerId: db.records[i].ledgerId,
      memberId: db.records[i].memberId,
      memberName: db.records[i].memberName,
      type: db.records[i].type,
      amount: db.records[i].amount,
      category: db.records[i].category,
      accountId: db.records[i].accountId || '',
      transferTo: db.records[i].transferTo || '',
      transferToName: db.records[i].transferToName || '',
      date: db.records[i].date,
      note: db.records[i].note,
      deleted: !!db.records[i].deleted,
      createdAt: toIso(db.records[i].createdAt),
      updatedAt: toIso(db.records[i].updatedAt)
    })
  }
  return out
}

function clearDirty(ids) {
  ensure()
  var set = {}
  for (var i = 0; i < ids.length; i++) set[ids[i]] = true
  for (var j = 0; j < db.records.length; j++) {
    if (set[db.records[j].id]) db.records[j].dirty = false
  }
}

/** 合并云端账本；返回是否有变化 */
function applyRemoteLedger(o) {
  ensure()
  if (!o || !o.id) return false
  if (hiddenIds[o.id]) return false
  var members = {}
  var ms = Array.isArray(o.members) ? o.members : []
  for (var i = 0; i < ms.length; i++) {
    if (!ms[i] || !ms[i].id) continue
    var mid = String(ms[i].id)
    members[mid] = { id: mid, name: String(ms[i].name || '成员').slice(0, 12), joinedAt: toIso(ms[i].joinedAt) }
  }
  var existing = getLedger(o.id)
  if (!existing) {
    var fresh = {
      id: String(o.id),
      name: String(o.name || '共享账本').slice(0, 20),
      ownerId: String(o.ownerId || ''),
      ownerName: String(o.ownerName || ''),
      createdAt: toIso(o.createdAt),
      inviteCode: String(o.inviteCode || ''),
      members: members
    }
    var fx = defaultLedgerExtras()
    fresh.accounts = Array.isArray(o.accounts) && o.accounts.length ? o.accounts : fx.accounts
    fresh.budget = o.budget && typeof o.budget === 'object' ? o.budget : fx.budget
    fresh.recurring = Array.isArray(o.recurring) ? o.recurring : []
    fresh.categories = Array.isArray(o.categories) ? o.categories : []
    fresh.challenges = Array.isArray(o.challenges) ? o.challenges : []
    fresh.cfgAt = toIso(o.cfgAt)
    db.ledgers.push(fresh)
    if (!db.currentLedgerId) db.currentLedgerId = String(o.id)
    return true
  }
  var changed = false
  if (o.name && String(o.name).slice(0, 20) !== existing.name) {
    existing.name = String(o.name).slice(0, 20)
    changed = true
  }
  if (o.ownerName && String(o.ownerName).slice(0, 12) !== existing.ownerName) {
    existing.ownerName = String(o.ownerName).slice(0, 12)
    changed = true
  }
  if (o.inviteCode && o.inviteCode !== existing.inviteCode) {
    existing.inviteCode = String(o.inviteCode)
    changed = true
  }
  var ids = Object.keys(members)
  for (i = 0; i < ids.length; i++) {
    var id = ids[i]
    var cur = existing.members[id]
    if (!cur) {
      existing.members[id] = members[id]
      changed = true
    } else if (members[id].name && members[id].name !== cur.name) {
      cur.name = members[id].name
      changed = true
    }
  }
  // 账本级配置（账户/预算/周期/分类）：按 cfgAt 时间戳 LWW
  var cfgAt = toIso(o.cfgAt)
  if (cfgAt && (!existing.cfgAt || cfgAt > existing.cfgAt)) {
    if (Array.isArray(o.accounts) && o.accounts.length) existing.accounts = o.accounts
    if (o.budget && typeof o.budget === 'object') existing.budget = o.budget
    if (Array.isArray(o.recurring)) existing.recurring = o.recurring
    if (Array.isArray(o.categories)) existing.categories = o.categories
    if (Array.isArray(o.challenges)) existing.challenges = o.challenges
    existing.cfgAt = cfgAt
    changed = true
  }
  return changed
}

/** 合并云端记录（LWW：本地有未推送且不旧的脏数据时保留本地）；返回是否有变化 */
function applyRemoteRecord(o) {
  ensure()
  if (!o || !o.id || !o.ledgerId) return false
  if (hiddenIds[o.ledgerId]) return false
  if (o.type !== 'income' && o.type !== 'expense' && o.type !== 'transfer') return false
  var amount = Math.round(Number(o.amount))
  if (!isFinite(amount) || amount <= 0) return false
  var date = String(o.date || '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false
  var updatedAt = toIso(o.updatedAt)
  var existing = getRecord(o.id)
  if (existing) {
    if (existing.updatedAt >= updatedAt) return false
    existing.amount = amount
    existing.type = o.type
    existing.category = o.type === 'transfer' ? 'transfer' : String(o.category || 'other_out')
    existing.accountId = String(o.accountId || '')
    existing.transferTo = String(o.transferTo || '')
    existing.transferToName = String(o.transferToName || '')
    existing.date = date
    existing.note = String(o.note == null ? '' : o.note).slice(0, 50)
    existing.memberName = String(o.memberName || '成员').slice(0, 12)
    existing.deleted = !!o.deleted
    existing.updatedAt = updatedAt
    existing.dirty = false
    return true
  }
  db.records.push({
    id: String(o.id),
    ledgerId: String(o.ledgerId),
    memberId: String(o.memberId || ''),
    memberName: String(o.memberName || '成员').slice(0, 12),
    type: o.type,
    amount: amount,
    category: o.type === 'transfer' ? 'transfer' : String(o.category || 'other_out'),
    accountId: String(o.accountId || ''),
    transferTo: String(o.transferTo || ''),
    transferToName: String(o.transferToName || ''),
    date: date,
    note: String(o.note == null ? '' : o.note).slice(0, 50),
    createdAt: toIso(o.createdAt),
    updatedAt: updatedAt,
    deleted: !!o.deleted,
    dirty: false
  })
  return true
}

/* ---------------- 存钱挑战 ---------------- */

/** 把存储结构加工成页面直接可用的视图数据 */
function challengeView(c) {
  var target = Math.max(0, Math.round(Number(c.target) || 0))
  var saved = Math.max(0, Math.round(Number(c.saved) || 0))
  var pct = target > 0 ? Math.min(100, Math.round(saved / target * 1000) / 10) : 0
  var daysLeft = null
  if (c.deadline) {
    var d1 = u.parseDate(c.deadline)
    var d0 = u.parseDate(u.dateStr(new Date()))
    if (d1 instanceof Date && d0 instanceof Date && !isNaN(d1) && !isNaN(d0)) {
      daysLeft = Math.round((d1.getTime() - d0.getTime()) / 86400000)
    }
  }
  return {
    id: String(c.id),
    name: String(c.name || '存钱挑战'),
    target: target,
    saved: saved,
    targetText: u.formatCents(target),
    savedText: u.formatCents(saved),
    leftText: u.formatCents(Math.max(0, target - saved)),
    pct: pct,
    done: target > 0 && saved >= target,
    deadline: c.deadline || '',
    daysLeft: daysLeft,
    daysLeftAbs: daysLeft === null ? 0 : Math.abs(daysLeft),
    note: c.note || '',
    createdAt: c.createdAt || ''
  }
}

function challengesOf(ledgerId) {
  ensure()
  var l = getLedger(ledgerId)
  if (!l) return []
  ensureExtras(l)
  var list = l.challenges.map(challengeView)
  // 进行中在前，已达成沉底
  list.sort(function (a, b) {
    if (a.done !== b.done) return a.done ? 1 : -1
    return String(a.createdAt) < String(b.createdAt) ? 1 : -1
  })
  return list
}

function addChallenge(ledgerId, fields) {
  return withLedger(ledgerId, function (l) {
    var target = Math.round(Number(fields.target) || 0)
    if (target <= 0) return null
    var c = {
      id: u.genId('ch'),
      name: String(fields.name || '').slice(0, 16) || '存钱挑战',
      target: target,
      saved: Math.max(0, Math.round(Number(fields.saved) || 0)),
      deadline: /^\d{4}-\d{2}-\d{2}$/.test(fields.deadline || '') ? fields.deadline : '',
      note: String(fields.note || '').slice(0, 30),
      createdAt: isoNow()
    }
    l.challenges.push(c)
    return challengeView(c)
  })
}

function updateChallenge(ledgerId, id, patch) {
  return withLedger(ledgerId, function (l) {
    for (var i = 0; i < l.challenges.length; i++) {
      if (l.challenges[i].id !== id) continue
      var c = l.challenges[i]
      if (patch.name != null) c.name = String(patch.name).slice(0, 16) || c.name
      if (patch.target != null) {
        var t = Math.round(Number(patch.target) || 0)
        if (t > 0) c.target = t
      }
      if (patch.deadline != null) {
        c.deadline = /^\d{4}-\d{2}-\d{2}$/.test(patch.deadline) ? patch.deadline : ''
      }
      return challengeView(c)
    }
    return null
  })
}

/** 存入（正数）或取出（负数），amount 单位分 */
function depositChallenge(ledgerId, id, amount) {
  return withLedger(ledgerId, function (l) {
    for (var i = 0; i < l.challenges.length; i++) {
      if (l.challenges[i].id !== id) continue
      var c = l.challenges[i]
      var next = Math.round(Number(c.saved) || 0) + Math.round(Number(amount) || 0)
      c.saved = Math.max(0, next)
      return challengeView(c)
    }
    return null
  })
}

function removeChallenge(ledgerId, id) {
  return withLedger(ledgerId, function (l) {
    var before = l.challenges.length
    l.challenges = l.challenges.filter(function (c) { return c.id !== id })
    return before !== l.challenges.length
  })
}

module.exports = {
  init: init,
  flush: persist,
  getMe: getMe,
  getProfile: getProfile,
  setProfile: setProfile,
  applyCloudMe: applyCloudMe,
  setMyName: setMyName,
  createLedger: createLedger,
  getLedger: getLedger,
  currentLedger: currentLedger,
  setCurrentLedger: setCurrentLedger,
  renameLedger: renameLedger,
  deleteLedger: deleteLedger,
  listLedgers: listLedgers,
  recordsOf: recordsOf,
  getRecord: getRecord,
  addRecord: addRecord,
  updateRecord: updateRecord,
  deleteRecord: deleteRecord,
  addTransfer: addTransfer,
  statsOf: statsOf,
  accountsOf: accountsOf,
  saveAccounts: saveAccounts,
  assetSummary: assetSummary,
  budgetOf: budgetOf,
  saveBudget: saveBudget,
  recurringList: recurringList,
  addRecurring: addRecurring,
  removeRecurring: removeRecurring,
  toggleRecurring: toggleRecurring,
  runDueRecurring: runDueRecurring,
  categoriesOf: categoriesOf,
  saveCategories: saveCategories,
  challengesOf: challengesOf,
  addChallenge: addChallenge,
  updateChallenge: updateChallenge,
  depositChallenge: depositChallenge,
  removeChallenge: removeChallenge,
  searchRecords: searchRecords,
  exportCSV: exportCSV,
  exportReconcileCSV: exportReconcileCSV,
  txnKey: txnKey,
  importedKeySet: importedKeySet,
  importRows: importRows,
  reconcile: reconcile,
  sharePackage: sharePackage,
  importSharePackage: importSharePackage,
  onChange: onChange,
  replaceMyId: replaceMyId,
  exportLedgersForSync: exportLedgersForSync,
  drainDirty: drainDirty,
  clearDirty: clearDirty,
  applyRemoteLedger: applyRemoteLedger,
  applyRemoteRecord: applyRemoteRecord
}
