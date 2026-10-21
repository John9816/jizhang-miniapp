const db = require('../../utils/db.js')
const u = require('../../utils/util.js')

var PALETTE = ['#FFD24A', '#FFAE63', '#F08A7E', '#86C7A8', '#8CB6EE', '#B49BE8', '#D9CDB0']

/** 年视图按月聚合 */
function monthlySeries(records, start, end) {
  var y = parseInt(start.slice(0, 4), 10)
  var points = []
  var i
  for (i = 1; i <= 12; i++) {
    points.push({ key: y + '-' + (i < 10 ? '0' + i : i), label: i + '月', income: 0, expense: 0 })
  }
  for (i = 0; i < records.length; i++) {
    var r = records[i]
    if (r.type === 'transfer') continue
    var mi = parseInt(String(r.date).slice(5, 7), 10) - 1
    if (mi < 0 || mi > 11) continue
    if (r.type === 'income') points[mi].income += r.amount
    else points[mi].expense += r.amount
  }
  return points
}

function daysInclusive(start, end) {
  var a = u.parseDate(start)
  var b = u.parseDate(end)
  if (!(a instanceof Date) || !(b instanceof Date)) return 1
  return Math.max(1, Math.round((b.getTime() - a.getTime()) / 86400000) + 1)
}

Page({
  data: {
    statusBar: 20,
    pieType: 'expense',
    period: 'month',
    periods: [
      { key: 'week', name: '周' },
      { key: 'month', name: '月' },
      { key: 'year', name: '年' },
      { key: 'custom', name: '自定义' }
    ],
    periodLabel: '',
    refKey: '',
    mainLabel: '总支出',
    mainTotal: '0.00',
    momText: '',
    momUp: false,
    dailyText: '0.00',
    pieItems: [],
    pieTotalText: '0.00',
    summary: { income: 0, expense: 0, balance: 0, incomeText: '0.00', expenseText: '0.00', balanceText: '0.00' },
    trend: [],
    hasData: false,
    tip: null,
    showCustom: false,
    customStart: '',
    customEnd: '',
    posterShow: false,
    posterPath: ''
  },

  onLoad() {
    var info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    var today = u.dateStr(new Date())
    this.setData({
      statusBar: (info && info.statusBarHeight) || 20,
      customStart: today.slice(0, 8) + '01',
      customEnd: today
    })
    this.loadData()
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 2 })
    }
    if (this._loaded) this.loadData()
    this._loaded = true
  },

  /* ---------------- 条件切换 ---------------- */

  setPeriod(e) {
    var period = e.currentTarget.dataset.period
    if (period === 'custom') {
      this.setData({ period: period, showCustom: true })
      return
    }
    this.setData({ period: period, refKey: '', tip: null })
    this.loadData()
  },

  setPieType(e) {
    var type = e.currentTarget.dataset.type
    if (type === this.data.pieType) return
    this.setData({ pieType: type, tip: null })
    this.loadData()
  },

  onCustomStart(e) {
    this.setData({ customStart: e.detail.value })
  },

  onCustomEnd(e) {
    this.setData({ customEnd: e.detail.value })
  },

  applyCustom() {
    var s = this.data.customStart
    var en = this.data.customEnd
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '') || !/^\d{4}-\d{2}-\d{2}$/.test(en || '') || s > en) {
      wx.showToast({ title: '请选择有效日期范围', icon: 'none' })
      return
    }
    this.setData({ showCustom: false, period: 'custom', tip: null })
    this.loadData()
  },

  cancelCustom() {
    this.setData({ showCustom: false, period: 'month' })
    this.loadData()
  },

  prevPeriod() {
    var ref = this.refDate()
    var key = this.data.period === 'week' ? u.shiftWeek(ref, -1)
      : this.data.period === 'year' ? String(parseInt(ref.slice(0, 4), 10) - 1) + '-01-01'
      : u.shiftMonth(ref.slice(0, 7), -1) + '-01'
    this.setData({ refKey: key, tip: null })
    this.loadData()
  },

  nextPeriod() {
    var ref = this.refDate()
    var key = this.data.period === 'week' ? u.shiftWeek(ref, 1)
      : this.data.period === 'year' ? String(parseInt(ref.slice(0, 4), 10) + 1) + '-01-01'
      : u.shiftMonth(ref.slice(0, 7), 1) + '-01'
    this.setData({ refKey: key, tip: null })
    this.loadData()
  },

  refDate() {
    return this.data.refKey || u.dateStr(new Date())
  },

  /* ---------------- 数据 ---------------- */

  loadData() {
    var ledger = db.currentLedger()
    if (!ledger) {
      this.setData({ hasData: false, periodLabel: '暂无账本' })
      return
    }
    var period = this.data.period
    var p = u.periodOf(period, this.refDate(), { start: this.data.customStart, end: this.data.customEnd })
    var recs = db.recordsOf(ledger.id)
    var all = recs.filter(function (r) { return r.date >= p.start && r.date <= p.end })

    var s = u.calcSummary(all)

    // 上一周期
    var prevStart
    if (period === 'week') prevStart = u.addDays(p.start, -7)
    else if (period === 'year') prevStart = String(parseInt(p.start.slice(0, 4), 10) - 1) + '-01-01'
    else if (period === 'custom') prevStart = ''
    else prevStart = u.shiftMonth(p.key, -1) + '-01'
    var prevP = prevStart ? u.periodOf(period, prevStart, { start: '', end: '' }) : { start: '', end: '' }
    var prevRecs = prevStart ? recs.filter(function (r) { return r.date >= prevP.start && r.date <= prevP.end }) : []
    var ps = u.calcSummary(prevRecs)
    var mom = u.momChange(s, ps)
    var momPct = this.data.pieType === 'income' ? mom.incomePct : mom.expensePct

    // 日均
    var today = u.dateStr(new Date())
    var endForAvg = p.end < today ? p.end : today
    var days = daysInclusive(p.start, endForAvg < p.start ? p.start : endForAvg)
    var mainTotal = this.data.pieType === 'income' ? s.income : s.expense

    // 占比
    var cats = u.categoryStats(all, this.data.pieType)
    var pieItems = cats.map(function (c, i) {
      return {
        key: c.key,
        name: c.name,
        icon: c.icon,
        pct: c.pct,
        amountText: c.amountText,
        color: PALETTE[i % PALETTE.length]
      }
    })
    // 超过 6 项合并尾部
    if (pieItems.length > 6) {
      var rest = pieItems.slice(5)
      var restPct = 0
      for (var i = 0; i < rest.length; i++) restPct += rest[i].pct
      pieItems = pieItems.slice(0, 5)
      pieItems.push({ key: '__rest', name: '其他 ' + rest.length + ' 项', icon: '✨', pct: Math.round(restPct * 10) / 10, amountText: '', color: '#D9CDB0' })
    }

    // 趋势
    var trend = period === 'year'
      ? monthlySeries(all, p.start, p.end)
      : u.trendSeries(all, p.start, p.end, 'day')

    this.setData({
      periodLabel: p.label,
      hasData: all.length > 0,
      mainLabel: this.data.pieType === 'income' ? '总收入' : '总支出',
      mainTotal: u.formatCents(mainTotal),
      momText: (momPct > 0 ? '+' : '') + momPct + '%',
      momUp: momPct > 0,
      dailyText: u.formatCents(Math.round(mainTotal / days)),
      pieItems: pieItems,
      pieTotalText: u.formatCents(mainTotal),
      summary: {
        income: s.income,
        expense: s.expense,
        balance: s.balance,
        incomeText: u.formatCents(s.income),
        expenseText: u.formatCents(s.expense),
        balanceText: u.formatCents(s.balance)
      },
      trend: trend
    })

    var self = this
    setTimeout(function () { self.drawCharts() }, 40)
  },

  /* ---------------- 绘制 ---------------- */

  drawCharts() {
    var sys = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    var dpr = sys.pixelRatio || 2
    var self = this
    var query = wx.createSelectorQuery()
    query.select('#lineCanvas').fields({ node: true, size: true })
    query.select('#pieCanvas').fields({ node: true, size: true })
    query.select('#barCanvas').fields({ node: true, size: true })
    query.exec(function (res) {
      if (!res || !res.length) return
      self._lineNode = res[0]
      self._dpr = dpr
      self.drawLine(res[0], dpr)
      self.drawPie(res[1], dpr)
      self.drawBar(res[2], dpr)
    })
  },

  drawLine(nodeInfo, dpr) {
    if (!nodeInfo || !nodeInfo.node) return
    var canvas = nodeInfo.node
    var ctx = canvas.getContext('2d')
    var w = nodeInfo.width
    var h = nodeInfo.height || 190
    canvas.width = w * dpr
    canvas.height = h * dpr
    if (ctx.setTransform) ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, w, h)

    var series = this.data.trend
    if (!series || !series.length) return
    var key = this.data.pieType === 'income' ? 'income' : 'expense'
    var left = 36
    var right = w - 10
    var top = 18
    var bottom = h - 24

    var max = 0
    var i
    for (i = 0; i < series.length; i++) max = Math.max(max, series[i][key])
    if (max === 0) max = 100
    max = max * 1.2

    var stepX = series.length > 1 ? (right - left) / (series.length - 1) : 0
    this._geom = { left: left, right: right, top: top, bottom: bottom, stepX: stepX, max: max, w: w, h: h }

    // 网格与纵轴
    ctx.strokeStyle = '#F3EBD8'
    ctx.lineWidth = 1
    ctx.font = '10px sans-serif'
    ctx.fillStyle = '#B9B2A3'
    ctx.textAlign = 'right'
    for (i = 0; i <= 3; i++) {
      var gy = top + (bottom - top) * i / 3
      ctx.beginPath()
      ctx.moveTo(left, gy)
      ctx.lineTo(right, gy)
      ctx.stroke()
      var v = max * (3 - i) / 3
      ctx.fillText('¥' + (v >= 10000 ? (v / 10000).toFixed(1) + 'w' : Math.round(v / 100)), left - 6, gy + 3)
    }

    // 面积
    var grad = ctx.createLinearGradient(0, top, 0, bottom)
    grad.addColorStop(0, 'rgba(255, 201, 60, 0.36)')
    grad.addColorStop(1, 'rgba(255, 201, 60, 0.02)')
    ctx.beginPath()
    ctx.moveTo(left, bottom)
    for (i = 0; i < series.length; i++) {
      var px = left + stepX * i
      var py = bottom - (series[i][key] / max) * (bottom - top)
      if (i === 0) ctx.lineTo(px, py)
      else {
        var prevX = left + stepX * (i - 1)
        var prevY = bottom - (series[i - 1][key] / max) * (bottom - top)
        var midX = (prevX + px) / 2
        ctx.bezierCurveTo(midX, prevY, midX, py, px, py)
      }
    }
    ctx.lineTo(right, bottom)
    ctx.closePath()
    ctx.fillStyle = grad
    ctx.fill()

    // 折线
    ctx.beginPath()
    for (i = 0; i < series.length; i++) {
      var lx = left + stepX * i
      var ly = bottom - (series[i][key] / max) * (bottom - top)
      if (i === 0) ctx.moveTo(lx, ly)
      else {
        var pX = left + stepX * (i - 1)
        var pY = bottom - (series[i - 1][key] / max) * (bottom - top)
        var mX = (pX + lx) / 2
        ctx.bezierCurveTo(mX, pY, mX, ly, lx, ly)
      }
    }
    ctx.strokeStyle = '#F0AE18'
    ctx.lineWidth = 2.4
    ctx.lineJoin = 'round'
    ctx.stroke()

    // 横轴标签
    ctx.fillStyle = '#B9B2A3'
    ctx.font = '10px sans-serif'
    ctx.textAlign = 'left'
    ctx.fillText(series[0].label, left, h - 6)
    if (series.length > 2) {
      var mid = Math.floor((series.length - 1) / 2)
      ctx.textAlign = 'center'
      ctx.fillText(series[mid].label, left + stepX * mid, h - 6)
    }
    ctx.textAlign = 'right'
    ctx.fillText(series[series.length - 1].label, right, h - 6)

    // 选中点
    var tip = this.data.tip
    if (tip && tip.index >= 0 && tip.index < series.length) {
      var tx = left + stepX * tip.index
      var tv = series[tip.index][key]
      var ty = bottom - (tv / max) * (bottom - top)
      ctx.strokeStyle = '#E9C56A'
      ctx.setLineDash([3, 4])
      ctx.beginPath()
      ctx.moveTo(tx, top)
      ctx.lineTo(tx, bottom)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.beginPath()
      ctx.arc(tx, ty, 5.5, 0, Math.PI * 2)
      ctx.fillStyle = '#FFFFFF'
      ctx.fill()
      ctx.lineWidth = 2.6
      ctx.strokeStyle = '#F0AE18'
      ctx.stroke()
    } else if (series.length) {
      // 末点高亮
      var ex = right
      var ey = bottom - (series[series.length - 1][key] / max) * (bottom - top)
      ctx.beginPath()
      ctx.arc(ex, ey, 4, 0, Math.PI * 2)
      ctx.fillStyle = '#F0AE18'
      ctx.fill()
    }
  },

  drawPie(nodeInfo, dpr) {
    if (!nodeInfo || !nodeInfo.node) return
    var canvas = nodeInfo.node
    var ctx = canvas.getContext('2d')
    var w = nodeInfo.width
    var h = nodeInfo.height || nodeInfo.width
    canvas.width = w * dpr
    canvas.height = h * dpr
    if (ctx.setTransform) ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, w, h)

    var items = this.data.pieItems
    var cx = w / 2
    var cy = h / 2
    var r = Math.min(w, h) / 2 - 6
    var inner = r * 0.66

    if (!items.length) {
      ctx.beginPath()
      ctx.arc(cx, cy, (r + inner) / 2, 0, Math.PI * 2)
      ctx.strokeStyle = '#F1E9D6'
      ctx.lineWidth = r - inner
      ctx.stroke()
    } else {
      var total = 0
      var i
      for (i = 0; i < items.length; i++) total += items[i].pct
      var start = -Math.PI / 2
      var gap = items.length > 1 ? 0.03 : 0
      for (i = 0; i < items.length; i++) {
        var angle = total > 0 ? (items[i].pct / total) * Math.PI * 2 : 0
        if (angle <= 0) continue
        ctx.beginPath()
        ctx.arc(cx, cy, (r + inner) / 2, start + gap / 2, start + angle - gap / 2)
        ctx.strokeStyle = items[i].color
        ctx.lineWidth = r - inner
        ctx.lineCap = 'round'
        ctx.stroke()
        start += angle
      }
    }

    // 圆心文字
    ctx.textAlign = 'center'
    ctx.fillStyle = '#2E2A22'
    ctx.font = '600 ' + Math.max(12, Math.round(w * 0.108)) + 'px sans-serif'
    ctx.fillText(this.data.pieTotalText, cx, cy + 1)
    ctx.fillStyle = '#A79E8B'
    ctx.font = Math.round(w * 0.068) + 'px sans-serif'
    ctx.fillText(this.data.pieType === 'income' ? '总收入' : '总支出', cx, cy + Math.round(w * 0.115))
  },

  drawBar(nodeInfo, dpr) {
    if (!nodeInfo || !nodeInfo.node) return
    var canvas = nodeInfo.node
    var ctx = canvas.getContext('2d')
    var w = nodeInfo.width
    var h = nodeInfo.height || 160
    canvas.width = w * dpr
    canvas.height = h * dpr
    if (ctx.setTransform) ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, w, h)

    var ledger = db.currentLedger()
    if (!ledger) return
    var recs = db.recordsOf(ledger.id)
    var months = []
    var now = new Date()
    var i
    for (i = 11; i >= 0; i--) {
      var d = new Date(now.getFullYear(), now.getMonth() - i, 1)
      months.push({ key: d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2), value: 0 })
    }
    for (i = 0; i < recs.length; i++) {
      var r = recs[i]
      if (r.type !== 'expense') continue
      var mk = String(r.date).slice(0, 7)
      for (var j = 0; j < months.length; j++) {
        if (months[j].key === mk) { months[j].value += r.amount; break }
      }
    }
    var max = 0
    for (i = 0; i < months.length; i++) max = Math.max(max, months[i].value)
    var padL = 4
    var padR = 4
    var bw = (w - padL - padR) / months.length
    var top = 10
    var bottom = h - 22
    for (i = 0; i < months.length; i++) {
      var m = months[i]
      var bh = max > 0 ? (m.value / max) * (bottom - top) : 0
      var x = padL + i * bw + bw * 0.22
      var y = bottom - bh
      ctx.fillStyle = m.value === 0 ? '#F0E8D5' : (i === months.length - 1 ? '#F5B417' : '#FFDD82')
      this.roundRect(ctx, x, y, bw * 0.56, Math.max(bh, 3), 3)
      ctx.fill()
      if (i % 2 === 0 || i === months.length - 1) {
        ctx.fillStyle = '#B9B2A3'
        ctx.font = '9px sans-serif'
        ctx.textAlign = 'center'
        ctx.fillText(parseInt(m.key.slice(5, 7), 10) + '月', x + bw * 0.28, h - 6)
      }
    }
  },

  roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2)
    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.arcTo(x + w, y, x + w, y + h, r)
    ctx.arcTo(x + w, y + h, x, y + h, r)
    ctx.arcTo(x, y + h, x, y, r)
    ctx.arcTo(x, y, x + w, y, r)
    ctx.closePath()
  },

  /* ---------------- 点选某天 ---------------- */

  onChartTouch(e) {
    var g = this._geom
    var series = this.data.trend
    if (!g || !series || !series.length) return
    var t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0])
    if (!t) return
    var x = t.x != null ? t.x : t.clientX
    var idx = Math.round((x - g.left) / (g.stepX || 1))
    if (idx < 0) idx = 0
    if (idx > series.length - 1) idx = series.length - 1
    this.selectPoint(idx)
  },

  selectPoint(idx) {
    var g = this._geom
    var series = this.data.trend
    if (!g || !series || !series[idx]) return
    var key = this.data.pieType === 'income' ? 'income' : 'expense'
    var item = series[idx]
    var value = item[key]
    var px = g.left + g.stepX * idx
    var py = g.bottom - (value / g.max) * (g.bottom - g.top)
    var boxW = 116
    var left = px - boxW / 2
    if (left < 4) left = 4
    if (left > g.w - boxW - 4) left = g.w - boxW - 4
    this.setData({
      tip: {
        index: idx,
        date: item.key.length === 7 ? item.key.slice(5, 7).replace(/^0/, '') + '月' : u.cnDate(item.key),
        value: u.formatCents(value),
        label: this.data.pieType === 'income' ? '收入' : '支出',
        left: left,
        top: Math.max(0, py - 56)
      }
    })
    this.drawLine(this._lineNode, this._dpr)
  },

  hideTip() {
    if (!this.data.tip) return
    this.setData({ tip: null })
    this.drawLine(this._lineNode, this._dpr)
  },

  /* ---------------- 年度海报 ---------------- */

  makePoster() {
    var ledger = db.currentLedger()
    if (!ledger) return
    if (!db.isVip()) {
      wx.showModal({
        title: '海报为会员功能',
        content: '升级会员后可解锁高级统计图表与年度海报，分享更美观的收支报告。',
        confirmText: '去开通',
        cancelText: '知道了',
        success: function (r) { if (r.confirm) wx.navigateTo({ url: '/pages/vip/vip' }) }
      })
      return
    }
    var year = (this.data.refKey || u.dateStr(new Date())).slice(0, 4)
    var p = u.periodOf('year', year + '-06-01')
    var recs = db.recordsOf(ledger.id).filter(function (r) {
      return r.date >= p.start && r.date <= p.end
    })
    if (!recs.length) {
      wx.showToast({ title: year + ' 年还没有记录', icon: 'none' })
      return
    }
    var self = this
    this.setData({ posterShow: true }, function () {
      setTimeout(function () { self.drawPoster(ledger, year, recs) }, 60)
    })
  },

  drawPoster(ledger, year, recs) {
    var s = u.calcSummary(recs)
    var top3 = u.categoryStats(recs, 'expense').slice(0, 3)
    var mem = u.memberStats(recs, ledger.members).length
    var self = this
    var query = wx.createSelectorQuery()
    query.select('#posterCanvas').fields({ node: true, size: true }).exec(function (res) {
      if (!res || !res[0] || !res[0].node) return
      var canvas = res[0].node
      var w = res[0].width
      var h = 470
      var dpr = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()).pixelRatio || 2
      canvas.width = w * dpr
      canvas.height = h * dpr
      var ctx = canvas.getContext('2d')
      ctx.scale(dpr, dpr)

      var grad = ctx.createLinearGradient(0, 0, w, h)
      grad.addColorStop(0, '#FFE58A')
      grad.addColorStop(0.55, '#FFCE4A')
      grad.addColorStop(1, '#F2A912')
      ctx.fillStyle = grad
      ctx.fillRect(0, 0, w, h)

      ctx.fillStyle = 'rgba(255,255,255,0.26)'
      ctx.beginPath()
      ctx.arc(w - 34, 34, 84, 0, Math.PI * 2)
      ctx.fill()
      ctx.beginPath()
      ctx.arc(w - 96, h - 30, 60, 0, Math.PI * 2)
      ctx.fill()

      ctx.fillStyle = '#4A3200'
      ctx.textAlign = 'left'
      ctx.font = '700 26px sans-serif'
      ctx.fillText(year + ' 年度账单', 28, 58)
      ctx.font = '14px sans-serif'
      ctx.fillStyle = 'rgba(74,50,0,0.66)'
      ctx.fillText(ledger.name + ' · ' + recs.length + ' 笔 · ' + mem + ' 人共记', 28, 86)

      var cols = [
        { label: '总收入', value: u.formatCents(s.income) },
        { label: '总支出', value: u.formatCents(s.expense) },
        { label: '结余', value: u.formatCents(s.balance) }
      ]
      var colW = (w - 56) / 3
      for (var i = 0; i < cols.length; i++) {
        var x = 28 + colW * i + colW / 2
        ctx.textAlign = 'center'
        ctx.fillStyle = 'rgba(74,50,0,0.6)'
        ctx.font = '13px sans-serif'
        ctx.fillText(cols[i].label, x, 136)
        ctx.fillStyle = '#4A3200'
        ctx.font = '700 21px sans-serif'
        ctx.fillText('¥' + cols[i].value, x, 168)
      }

      ctx.textAlign = 'left'
      ctx.fillStyle = 'rgba(74,50,0,0.6)'
      ctx.font = '14px sans-serif'
      ctx.fillText('支出前三', 28, 216)
      for (i = 0; i < top3.length; i++) {
        var y = 254 + i * 40
        ctx.fillStyle = 'rgba(255,255,255,0.5)'
        this.roundRect(ctx, 28, y - 20, w - 56, 32, 10)
        ctx.fill()
        ctx.fillStyle = '#4A3200'
        ctx.font = '16px sans-serif'
        ctx.fillText(top3[i].icon + ' ' + top3[i].name, 42, y + 2)
        ctx.textAlign = 'right'
        ctx.fillText('¥' + top3[i].amountText + ' · ' + top3[i].pct + '%', w - 42, y + 2)
        ctx.textAlign = 'left'
      }
      ctx.fillStyle = 'rgba(74,50,0,0.5)'
      ctx.font = '13px sans-serif'
      ctx.fillText('—— 记账本 · 存钱罐', 28, h - 26)

      wx.canvasToTempFilePath({
        canvas: canvas,
        success: function (r) {
          self.setData({ posterShow: false })
          wx.previewImage({ urls: [r.tempFilePath], current: r.tempFilePath })
        },
        fail: function () {
          self.setData({ posterShow: false })
          wx.showToast({ title: '生成失败', icon: 'none' })
        }
      })
    })
  }
})
