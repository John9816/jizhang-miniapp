/**
 * 外部账单解析：微信支付账单 CSV / 支付宝账单 CSV → 统一流水行。
 * 不依赖 wx，可在 Node 下直接 require 做单元测试。
 *
 * 输出行格式（与 utils/db.js 的 importRows / reconcile 对齐）：
 * {
 *   src: 'wechat' | 'alipay' | 'self',
 *   txn: '交易单号'（self 格式为空，走退化键）,
 *   date: 'YYYY-MM-DD',
 *   type: 'expense' | 'income',
 *   amount: 分,
 *   party: '交易对方',
 *   note: '商品说明 / 摘要',
 *   category: '账本分类 key（guessCategory 推断，用户可改）',
 *   channel: '支付方式',
 *   status: '原始状态文本',
 *   line: '在文件中的行号（从 1 数）'
 * }
 */

var gbk = require('./gbk.js')
var u = require('./util.js')
var identity = require('./bill-identity.js')

var SOURCE_LABELS = {
  wechat: '微信账单',
  alipay: '支付宝账单',
  self: '记账本导出'
}

/* ---------------- CSV 解析（引号感知） ---------------- */

function parseCSV(text) {
  var rows = []
  var row = []
  var field = ''
  var inQuotes = false
  var i = 0
  var n = text.length
  while (i < n) {
    var c = text.charAt(i)
    if (inQuotes) {
      if (c === '"') {
        if (text.charAt(i + 1) === '"') { field += '"'; i += 2; continue }
        inQuotes = false
        i++
        continue
      }
      field += c
      i++
      continue
    }
    if (c === '"' && field === '') { inQuotes = true; i++; continue }
    if (c === ',') { row.push(field); field = ''; i++; continue }
    if (c === '\r') { i++; continue }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue }
    field += c
    i++
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row) }
  return rows
}

/**
 * 微信/支付宝个别版本导出金额千分位且不加引号（"￥1,234.56" 会被拆成两格），
 * 按表头列数把"￥1"+"234.56"这类相邻数字段合并回来。
 */
function mergeSplitNumbers(cells, expected) {
  var out = cells.slice()
  var guard = 0
  while (out.length > expected && guard < 100) {
    guard++
    var merged = false
    for (var i = 0; i < out.length - 1; i++) {
      var a = out[i]
      var b = out[i + 1]
      if (/^[￥¥]?\d{1,3}$/.test(a) && /^[￥¥]?\d{1,3}(\.\d{1,2})?$/.test(b)) {
        out.splice(i, 2, a + ',' + b)
        merged = true
        break
      }
    }
    if (!merged) break
  }
  return out
}

/* ---------------- 编码判断 ----------------
 * 微信/支付宝导出的 CSV 绝大多数是 GBK；UTF-8 文件（带或不带 BOM）也兼容。
 * TextDecoder 的 strict 模式在两种编码上都能给出可靠判断。 */

function isUtf8Bytes(bytes) {
  var i = 0
  var n = bytes.length
  while (i < n) {
    var b = bytes[i]
    if (b < 0x80) { i++; continue }
    var extra
    if (b >= 0xc2 && b <= 0xdf) extra = 1
    else if (b >= 0xe0 && b <= 0xef) extra = 2
    else if (b >= 0xf0 && b <= 0xf4) extra = 3
    else return false
    if (i + extra >= n) return false
    for (var k = 1; k <= extra; k++) {
      if ((bytes[i + k] & 0xc0) !== 0x80) return false
    }
    if (extra === 2 && b === 0xe0 && bytes[i + 1] < 0xa0) return false // overlong
    if (extra === 3) {
      if (b === 0xf0 && bytes[i + 1] < 0x90) return false // overlong
      if (b === 0xed && bytes[i + 1] >= 0xa0) return false // surrogate
      if (b === 0xf4 && bytes[i + 1] >= 0x90) return false // > U+10FFFF
    }
    i += extra + 1
  }
  return true
}

function stripBom(text) {
  return text.charAt(0) === '\ufeff' ? text.slice(1) : text
}

function decodeBytes(bytes) {
  var arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  if (arr.length === 0) return ''
  if (isUtf8Bytes(arr)) {
    try {
      var txt = new TextDecoder('utf-8').decode(arr)
      return stripBom(txt.replace(/^\r\n/, ''))
    } catch (e) { /* 落到 GBK */ }
  }
  var gbkTxt = gbk.decode(arr)
  // 若解出大量替换字符，说明不是 GBK，退回 UTF-8 宽松解码
  var bad = 0
  for (var i = 0; i < gbkTxt.length; i++) if (gbkTxt.charAt(i) === '\ufffd') bad++
  if (bad > 0 && bad * 50 >= gbkTxt.length) {
    try {
      return stripBom(new TextDecoder('utf-8', { fatal: false }).decode(arr))
    } catch (e) { /* keep gbk result */ }
  }
  return gbkTxt
}

/* ---------------- 表头识别 ---------------- */

function findHeader(rows) {
  for (var i = 0; i < rows.length && i < 60; i++) {
    var names = (rows[i] || []).map(function (s) { return String(s || '').trim() })
    // 不要求「交易时间」一定在首列：支付宝不同版本的导出会把时间列放在中间
    if (names.indexOf('交易时间') >= 0 && names.indexOf('收/支') >= 0) {
      return { index: i, names: names }
    }
  }
  return null
}

function detectFormat(names) {
  if (!names) return null
  var has = function (k) { return names.indexOf(k) >= 0 }
  if (has('交易单号') && has('商户单号')) return 'wechat'
  if (has('交易订单号') && has('商家订单号')) return 'alipay'
  if (has('摘要') && has('来源')) return 'self'
  return null
}

/* ---------------- 字段清洗 ---------------- */

/** "￥1,234.56" / "35.00" / "-12.30" / "CNY35" → 分为单位整数（0 表示无法解析） */
function toCents(input) {
  var t = String(input == null ? '' : input)
    .replace(/[cnyCNY¥￥元]/g, '')
    .replace(/[,\s，]/g, '')
  var neg = false
  if (t.charAt(0) === '-') { neg = true; t = t.slice(1) }
  if (t.charAt(0) === '+') t = t.slice(1)
  var m = t.match(/^\d{1,12}(\.\d{1,2})?/)
  if (!m) return 0
  var cents = u.yuanToCents(m[0])
  return neg ? -cents : cents
}

function normDirection(v) {
  var s = String(v == null ? '' : v).trim()
  if (s === '收入' || s === '收入/收款') return 'income'
  if (s === '支出' || s === '支出/付款') return 'expense'
  return ''
}

/**
 * 状态过滤：显式跳过 退款/关闭/失败/拒绝/等待/冻结 等，其余一律视为有效流水。
 * 不能反转为「只认成功」——微信的收款状态是「已收款」、提现类是「提现已到账」。
 */
function isSkipStatus(status) {
  var s = String(status == null ? '' : status).trim()
  if (!s) return false
  return /退款|关闭|失败|拒绝|不计收支|等待|冻结|处理中|进行中|超时|未完成/.test(s)
}

function pickDate(v) {
  var m = String(v == null ? '' : v).match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/)
  if (!m) return ''
  var mo = m[2].length < 2 ? '0' + m[2] : m[2]
  var da = m[3].length < 2 ? '0' + m[3] : m[3]
  return m[1] + '-' + mo + '-' + da
}

/* ---------------- 分类推断 ---------------- */

var EXPENSE_RULES = [
  // 话费/套餐/流量放最前：「套餐」的「餐」会误中餐饮规则；这三个词在个人账本里几乎只对话费
  [/话费|套餐|流量/, 'phonebill'],
  [/餐|饭|食|咖啡|奶茶|肯德基|麦当劳|汉堡|星巴克|美团|饿了么|外卖|火锅|烧烤|小吃|食堂|面包|甜品|蛋糕|生鲜|买菜|菜场|水果|叮咚|饿了/, 'food'],
  [/超市|商场|购物|百货|淘宝|天猫|京东|拼多多|唯品会|优衣库|无印良品|宜家|便利店|盒马|屈臣氏/, 'shopping'],
  [/打车|出租|滴滴|快车|专车|地铁|公交|加油|充电|停车|高德|火车|机票|12306|航班|高铁|顺风车|过路/, 'transport'],
  [/房租|租房|租金|供暖|垃圾费/, 'home'],
  [/水费|自来水/, 'water'],
  [/电费|电价/, 'electric'],
  [/燃气|煤气|天然气/, 'gas'],
  [/物业/, 'property'],
  [/手机|移动|联通|电信|宽带/, 'phone'],
  [/游戏|电影|演出|网吧|直播|视频|会员|音乐|健身|旅游|门票|娱乐/, 'fun'],
  [/红包|礼金|人情|份子|寿宴|婚宴/, 'social'],
  [/书|课程|培训|教育|学费|考试|得到|网课|知识/, 'study'],
  [/医院|药|门诊|挂号|诊所|体检|牙科|医疗/, 'medical']
]

var INCOME_RULES = [
  [/工资|薪资|薪水|月薪|薪酬|年终奖/, 'salary'],
  [/理财|基金|收益|利息|分红|余额宝|股票|债|投资/, 'invest'],
  [/红包|礼金/, 'redpacket'],
  [/报销/, 'reimburse'],
  [/兼|外包|稿费|奖金|绩效|私活|劳务/, 'parttime']
]

function guessCategory(type, party, note, categoryField) {
  var hay = String(party || '') + ' ' + String(categoryField || '') + ' ' + String(note || '')
  var rules = type === 'income' ? INCOME_RULES : EXPENSE_RULES
  for (var i = 0; i < rules.length; i++) {
    if (rules[i][0].test(hay)) return rules[i][1]
  }
  return type === 'income' ? 'other_in' : 'other_out'
}

/* ---------------- 主流程 ---------------- */

/** 解析与入账共用交易身份规则。 */
function rowKey(row) { return identity.key(row) }

function buildRow(src, cells, col, lineNo) {
  var get = function (name) {
    var idx = col[name]
    return idx == null ? '' : cells[idx]
  }
  var rawStatus = String(get('statusKey') || '').trim()
  // 微信「不计收支」写在状态列（转入零钱通等），按不计收支归类
  if (rawStatus === '不计收支') {
    return { skip: 'neutral', reason: '「不计收支」不计入账本', line: lineNo }
  }
  if (isSkipStatus(rawStatus)) {
    var bucket = rawStatus.indexOf('退款') >= 0 ? 'refund' : 'closed'
    return { skip: bucket, reason: '状态「' + rawStatus + '」不计入', line: lineNo }
  }
  var type = normDirection(get('dirKey'))
  if (!type) {
    return { skip: 'neutral', reason: '收/支为「' + String(get('dirKey') || '').trim() + '」不计收支', line: lineNo }
  }
  var date = pickDate(get('时间'))
  if (!date) return { skip: 'badRow', reason: '交易时间无法解析', line: lineNo }
  var amount = toCents(get('金额'))
  if (!(amount > 0)) return { skip: 'badRow', reason: '金额无法解析', line: lineNo }
  var note = String(get('noteKey') || '').trim()
  var party = String(get('partyKey') || '').trim()
  var categoryField = String(get('catKey') || '').trim()
  return {
    src: src,
    txn: (identity.normalize({ src: src, txn: get('txnKey') }) || {}).txn,
    time: identity.time(get('时间')),
    date: date,
    type: type,
    amount: amount,
    party: party,
    note: note || categoryField,
    category: guessCategory(type, party, note, categoryField),
    channel: String(get('channelKey') || '').trim(),
    status: rawStatus,
    line: lineNo
  }
}

/**
 * 解析账单文本。
 * 返回 { src, rows, stats, errors }；src 为 null 表示无法识别格式。
 */
function parseText(text) {
  var rows = parseCSV(stripBom(text))
  var header = findHeader(rows)
  var src = detectFormat(header && header.names)
  var out = { src: src, rows: [], stats: null, errors: [] }
  if (!header || !src) {
    out.errors.push({ line: 0, reason: '未识别到微信/支付宝账单表头（需「交易时间」+「收/支」开头的数据行）', raw: '' })
    out.stats = { lines: 0, kept: 0, incomeCents: 0, expenseCents: 0, skipped: { refund: 0, closed: 0, neutral: 0, badRow: 0, dup: 0 }, firstDate: '', lastDate: '' }
    return out
  }
  var names = header.names
  var col = {
    '时间': '交易时间',
    dirKey: '收/支',
    partyKey: src === 'self' ? '摘要' : '交易对方',
    catKey: src === 'alipay' ? '交易分类' : (src === 'self' ? '' : '交易类型'),
    noteKey: src === 'alipay' ? '商品说明' : (src === 'self' ? '摘要' : '商品'),
    channelKey: src === 'alipay' ? '收/付款方式' : (src === 'self' ? '' : '支付方式'),
    statusKey: src === 'alipay' ? '交易状态' : (src === 'self' ? '' : '当前状态'),
    txnKey: src === 'alipay' ? '交易订单号' : (src === 'self' ? '' : '交易单号'),
    '金额': src === 'alipay' ? '金额' : '金额(元)'
  }
  var idx = {}
  Object.keys(col).forEach(function (k) {
    var v = col[k]
    if (!v) { idx[k] = null; return }
    idx[k] = names.indexOf(v) >= 0 ? names.indexOf(v) : null
  })
  // self 格式的金额列名兜底：有的导出写「金额」而非「金额(元)」
  if (src === 'self' && idx['金额'] == null && names.indexOf('金额') >= 0) idx['金额'] = names.indexOf('金额')

  var seen = {}
  var kept = 0
  var incomeCents = 0
  var expenseCents = 0
  var skipped = { refund: 0, closed: 0, neutral: 0, badRow: 0, dup: 0 }
  var firstDate = ''
  var lastDate = ''

  for (var li = header.index + 1; li < rows.length; li++) {
    var cells = rows[li]
    if (!cells || cells.length === 0) continue
    if (cells.length === 1 && String(cells[0] || '').trim() === '') continue
    var lineNo = li + 1
    if (cells.length !== names.length) cells = mergeSplitNumbers(cells, names.length)
    if (cells.length !== names.length) {
      skipped.badRow++
      out.errors.push({ line: lineNo, reason: '列数不符（期望 ' + names.length + '，实得 ' + cells.length + '）', raw: cells.join('|').slice(0, 80) })
      continue
    }
    var built = buildRow(src, cells, idx, lineNo)
    if (built.skip) {
      skipped[built.skip]++
      out.errors.push({ line: lineNo, reason: built.reason, raw: cells.join('|').slice(0, 80) })
      continue
    }
    var key = rowKey(built)
    if (seen[key]) {
      skipped.dup++
      continue
    }
    seen[key] = true
    if (built.type === 'income') incomeCents += built.amount
    else expenseCents += built.amount
    if (!firstDate || built.date < firstDate) firstDate = built.date
    if (built.date > lastDate) lastDate = built.date
    kept++
    out.rows.push(built)
  }
  out.stats = {
    lines: kept + skipped.refund + skipped.neutral + skipped.closed + skipped.badRow + skipped.dup,
    kept: kept,
    incomeCents: incomeCents,
    expenseCents: expenseCents,
    skipped: skipped,
    firstDate: firstDate,
    lastDate: lastDate
  }
  return out
}

/** 解析账单字节（自动判断 GBK/UTF-8）。bytes 可以是 Uint8Array 或 ArrayBuffer */
function parseBytes(bytes) {
  var arr
  if (bytes instanceof ArrayBuffer) arr = new Uint8Array(bytes)
  else arr = bytes
  return parseText(decodeBytes(arr))
}

module.exports = {
  parseCSV: parseCSV,
  decodeBytes: decodeBytes,
  parseText: parseText,
  parseBytes: parseBytes,
  detectFormat: detectFormat,
  findHeader: findHeader,
  guessCategory: guessCategory,
  toCents: toCents,
  normDirection: normDirection,
  isSkipStatus: isSkipStatus,
  pickDate: pickDate,
  rowKey: rowKey,
  mergeSplitNumbers: mergeSplitNumbers,
  SOURCE_LABELS: SOURCE_LABELS
}
