const db = require('../../utils/db.js')
const u = require('../../utils/util.js')

var PIE_COLORS = ['#4F46E5', '#0EA5E9', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#14B8A6', '#F97316', '#6B7280']

Page({
  data: {
    period: 'month',
    periodLabel: '',
    refKey: '',
    pieType: 'expense',
    summary: { income: 0, expense: 0, balance: 0, incomeText: '0.00', expenseText: '0.00', balanceText: '0.00' },
    mom: { expensePct: 0, incomePct: 0 },
    pieItems: [],
    pieTotalText: '0.00',
    catRank: [],
    monthly: [],
    trend: [],
    trendGran: 'day',
    hasData: false,
    customStart: '',
    customEnd: '',
    showCustom: false,
    posterPath: ''
  },

  onLoad() {
    this.loadData()
  },

  onShow() {
    this.loadData()
  },

  setPeriod(e) {
    var period = e.currentTarget.dataset.period
    var patch = { period: period }
    if (period === 'custom') patch.showCustom = true
    this.setData(patch)
    if (period !== 'custom') this.loadData()
  },

  setPieType(e) {
    this.setData({ pieType: e.currentTarget.dataset.type })
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
    this.setData({ showCustom: false })
    this.loadData()
  },

  prevPeriod() {
    var ref = this.refDate()
    var key = this.data.period === 'week' ? u.shiftWeek(ref, -1)
      : this.data.period === 'year' ? String(parseInt(ref.slice(0, 4), 10) - 1) + '-01-01'
      : u.shiftMonth(ref.slice(0, 7), -1) + '-01'
    this.setData({ refKey: key })
    this.loadData()
  },

  nextPeriod() {
    var ref = this.refDate()
    var key = this.data.period === 'week' ? u.shiftWeek(ref, 1)
      : this.data.period === 'year' ? String(parseInt(ref.slice(0, 4), 10) + 1) + '-01-01'
      : u.shiftMonth(ref.slice(0, 7), 1) + '-01'
    this.setData({ refKey: key })
    this.loadData()
  },

  refDate() {
    if (this.data.refKey) return this.data.refKey
    return u.dateStr(new Date())
  },

  loadData() {
    var ledger = db.currentLedger()
    if (!ledger) {
      this.setData({ hasData: false })
      return
    }
    var period = this.data.period
    var p = u.periodOf(period, this.refDate(), { start: this.data.customStart, end: this.data.customEnd })
    var all = db.recordsOf(ledger.id).filter(function (r) {
      return r.date >= p.start && r.date <= p.end
    })
    var s = u.calcSummary(all)
    // 环比：上一个同长度周期
    var prevP = u.periodOf(period, this.data.period === 'custom' ? p.start : (period === 'week' ? u.addDays(p.start, -7) : period === 'year' ? String(parseInt(ref0(p), 10) - 1) + '-01-01' : u.shiftMonth(p.key, -1) + '-01'), { start: '', end: '' })
    var prevRecs = db.recordsOf(ledger.id).filter(function (r) {
      return r.date >= prevP.start && r.date <= prevP.end
    })
    var ps = u.calcSummary(prevRecs)
    var mom = u.momChange(s, ps)

    // 饼图：当前类型 top6 + 其他
    var cats = u.categoryStats(all, this.data.pieType)
    var pieItems = cats.slice(0, 6).map(function (c, i) {
      return { key: c.key, name: c.name, icon: c.icon, pct: c.pct, amountText: c.amountText, color: PIE_COLORS[i] }
    })
    var restPct = 0
    for (var i = 6; i < cats.length; i++) restPct += cats[i].pct
    if (cats.length > 6) {
      pieItems.push({ key: '__rest', name: '其他' + (cats.length - 6) + '类', icon: '✨', pct: Math.round(restPct * 10) / 10, amountText: '', color: '#9CA3AF' })
    }

    // 趋势：月按日、周按日、年按月
    var gran = period === 'year' ? 'week' : 'day'
    this.setData({
      periodLabel: p.label,
      hasData: all.length > 0,
      summary: {
        income: s.income,
        expense: s.expense,
        balance: s.balance,
        incomeText: u.formatCents(s.income),
        expenseText: u.formatCents(s.expense),
        balanceText: u.formatCents(s.balance)
      },
      mom: mom,
      pieItems: pieItems,
      pieTotalText: this.data.pieType === 'expense' ? u.formatCents(s.expense) : u.formatCents(s.income),
      catRank: cats,
      monthly: db.recordsOf(ledger.id),
      trend: u.trendSeries(all, p.start, p.end, gran),
      trendGran: gran,
      periodStart: p.start,
      periodEnd: p.end
    })
    var self = this
    setTimeout(function () { self.drawCharts() }, 30)
  },

  drawCharts() {
    var sys = wx.getSystemInfoSync()
    var dpr = sys.pixelRatio || 2
    var self = this
    var query = wx.createSelectorQuery()
    query.select('#pieCanvas').fields({ node: true, size: true })
    query.select('#barCanvas').fields({ node: true, size: true })
    query.select('#lineCanvas').fields({ node: true, size: true })
    query.exec(function (res) {
      if (!res || !res.length) return
      self.drawPie(res[0], dpr)
      self.drawBar(res[1], dpr)
      self.drawLine(res[2], dpr)
    })
  },

  drawPie(nodeInfo, dpr) {
    if (!nodeInfo || !nodeInfo.node || this.data.pieItems.length === 0) return
    var canvas = nodeInfo.node
    var ctx = canvas.getContext('2d')
    var w = nodeInfo.width
    var h = w
    canvas.width = w * dpr
    canvas.height = h * dpr
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, w, h)
    var cx = w / 2
    var cy = h / 2
    var r = Math.min(w, h) / 2 - 8
    var inner = r * 0.62
    var total = 0
    var i
    for (i = 0; i < this.data.pieItems.length; i++) total += this.data.pieItems[i].pct
    var start = -Math.PI / 2
    for (i = 0; i < this.data.pieItems.length; i++) {
      var item = this.data.pieItems[i]
      var angle = total > 0 ? (item.pct / total) * Math.PI * 2 : 0
      if (angle <= 0) continue
      ctx.beginPath()
      ctx.moveTo(cx, cy)
      ctx.arc(cx, cy, r, start, start + angle)
      ctx.closePath()
      ctx.fillStyle = item.color
      ctx.fill()
      start += angle
    }
    // 中心留空
    ctx.globalCompositeOperation = 'destination-out'
    ctx.beginPath()
    ctx.arc(cx, cy, inner, 0, Math.PI * 2)
    ctx.fill()
    ctx.globalCompositeOperation = 'source-over'
  },

  drawBar(nodeInfo, dpr) {
    if (!nodeInfo || !nodeInfo.node) return
    var canvas = nodeInfo.node
    var ctx = canvas.getContext('2d')
    var w = nodeInfo.width
    var h = nodeInfo.height || 220
    canvas.width = w * dpr
    canvas.height = h * dpr
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, w, h)
    // 近 12 个月支出
    var ledger = db.currentLedger()
    if (!ledger) return
    var recs = db.recordsOf(ledger.id)
    var months = []
    var now = new Date()
    var i
    for (i = 11; i >= 0; i--) {
      var d = new Date(now.getFullYear(), now.getMonth() - i, 1)
      var key = d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2)
      months.push({ key: key, expense: 0 })
    }
    for (i = 0; i < recs.length; i++) {
      var r = recs[i]
      if (r.type !== 'expense') continue
      var mk = String(r.date).slice(0, 7)
      for (var j = 0; j < months.length; j++) {
        if (months[j].key === mk) { months[j].expense += r.amount; break }
      }
    }
    var max = 0
    for (i = 0; i < months.length; i++) max = Math.max(max, months[i].expense)
    var padL = 8
    var padR = 8
    var bw = (w - padL - padR) / months.length
    var top = 16
    var bottom = h - 28
    for (i = 0; i < months.length; i++) {
      var m = months[i]
      var bh = max > 0 ? (m.expense / max) * (bottom - top) : 0
      var x = padL + i * bw + bw * 0.2
      var y = bottom - bh
      ctx.fillStyle = m.expense === 0 ? '#E5E7EB' : (i === months.length - 1 ? '#4F46E5' : '#A5B4FC')
      this.roundRect(ctx, x, y, bw * 0.6, Math.max(bh, 2), 4)
      ctx.fill()
      // 月份标签（隔一个显示）
      if (i % 2 === 0 || i === months.length - 1) {
        ctx.fillStyle = '#9CA3AF'
        ctx.font = '18px sans-serif'
        ctx.textAlign = 'center'
        ctx.fillText(parseInt(m.key.slice(5, 7), 10) + '月', x + bw * 0.3, h - 8)
      }
    }
    // 基线
    ctx.strokeStyle = '#E5E7EB'
    ctx.beginPath()
    ctx.moveTo(padL, bottom)
    ctx.lineTo(w - padR, bottom)
    ctx.stroke()
  },

  drawLine(nodeInfo, dpr) {
    if (!nodeInfo || !nodeInfo.node) return
    var canvas = nodeInfo.node
    var ctx = canvas.getContext('2d')
    var w = nodeInfo.width
    var h = nodeInfo.height || 220
    canvas.width = w * dpr
    canvas.height = h * dpr
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, w, h)
    var series = this.data.trend
    if (!series.length) return
    var left = 8
    var right = w - 8
    var top = 16
    var bottom = h - 28
    var max = 0
    var i
    for (i = 0; i < series.length; i++) max = Math.max(max, series[i].expense, series[i].income)
    if (max === 0) {
      ctx.fillStyle = '#9CA3AF'
      ctx.font = '22px sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText('本周期暂无收支数据', w / 2, h / 2)
      return
    }
    var stepX = series.length > 1 ? (right - left) / (series.length - 1) : 0
    // 网格（3 条横线）
    ctx.strokeStyle = '#F3F4F6'
    var g
    for (g = 1; g <= 3; g++) {
      var gy = top + (bottom - top) * g / 4
      ctx.beginPath()
      ctx.moveTo(left, gy)
      ctx.lineTo(right, gy)
      ctx.stroke()
    }
    // 支出线
    ctx.strokeStyle = '#4F46E5'
    ctx.lineWidth = 2
    ctx.beginPath()
    for (i = 0; i < series.length; i++) {
      var px = left + stepX * i
      var py = bottom - (series[i].expense / max) * (bottom - top)
      if (i === 0) ctx.moveTo(px, py)
      else ctx.lineTo(px, py)
    }
    ctx.stroke()
    // 收入线
    ctx.strokeStyle = '#10B981'
    ctx.beginPath()
    for (i = 0; i < series.length; i++) {
      var px2 = left + stepX * i
      var py2 = bottom - (series[i].income / max) * (bottom - top)
      if (i === 0) ctx.moveTo(px2, py2)
      else ctx.lineTo(px2, py2)
    }
    ctx.stroke()
    // 日期标签（首/中/尾）
    ctx.fillStyle = '#9CA3AF'
    ctx.font = '18px sans-serif'
    ctx.textAlign = 'left'
    ctx.fillText(series[0].label, left, h - 8)
    ctx.textAlign = 'right'
    ctx.fillText(series[series.length - 1].label, right, h - 8)
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

  makePoster() {
    // 年度账单海报：先算数据并挂载 canvas，再绘制导出
    var ledger = db.currentLedger()
    if (!ledger) return
    var year = u.dateStr(new Date()).slice(0, 4)
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
      setTimeout(function () { self.drawPoster(ledger, year, recs) }, 50)
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
      var h = 480
      var dpr = wx.getSystemInfoSync().pixelRatio || 2
      canvas.width = w * dpr
      canvas.height = h * dpr
      var ctx = canvas.getContext('2d')
      ctx.scale(dpr, dpr)
      // 背景
      var grad = ctx.createLinearGradient(0, 0, 0, h)
      grad.addColorStop(0, '#4F46E5')
      grad.addColorStop(1, '#7C3AED')
      ctx.fillStyle = grad
      ctx.fillRect(0, 0, w, h)
      ctx.fillStyle = 'rgba(255,255,255,0.10)'
      ctx.beginPath()
      ctx.arc(w - 40, 40, 90, 0, Math.PI * 2)
      ctx.fill()
      // 文案
      ctx.fillStyle = '#FFFFFF'
      ctx.textAlign = 'left'
      ctx.font = '600 30px sans-serif'
      ctx.fillText(year + ' 年度账单', 32, 64)
      ctx.font = '20px sans-serif'
      ctx.fillStyle = 'rgba(255,255,255,0.8)'
      ctx.fillText(ledger.name + ' · ' + recs.length + ' 笔记录 · ' + mem + ' 人共同记账', 32, 96)
      // 三个数字
      var cols = [
        { label: '总收入', value: u.formatCents(s.income) },
        { label: '总支出', value: u.formatCents(s.expense) },
        { label: '结余', value: u.formatCents(s.balance) }
      ]
      var colW = (w - 64) / 3
      for (var i = 0; i < cols.length; i++) {
        var x = 32 + colW * i + colW / 2
        ctx.textAlign = 'center'
        ctx.fillStyle = 'rgba(255,255,255,0.75)'
        ctx.font = '18px sans-serif'
        ctx.fillText(cols[i].label, x, 160)
        ctx.fillStyle = '#FFFFFF'
        ctx.font = '600 26px sans-serif'
        ctx.fillText('¥' + cols[i].value, x, 192)
      }
      // 分类 top3
      ctx.textAlign = 'left'
      ctx.fillStyle = 'rgba(255,255,255,0.8)'
      ctx.font = '20px sans-serif'
      ctx.fillText('支出前三', 32, 240)
      for (i = 0; i < top3.length; i++) {
        var y = 278 + i * 42
        ctx.fillStyle = 'rgba(255,255,255,0.16)'
        this.roundRect(ctx, 32, y - 22, w - 64, 36, 10)
        ctx.fill()
        ctx.fillStyle = '#FFFFFF'
        ctx.font = '22px sans-serif'
        ctx.fillText(top3[i].icon + ' ' + top3[i].name, 48, y + 3)
        ctx.textAlign = 'right'
        ctx.fillText('¥' + top3[i].amountText + '（' + top3[i].pct + '%）', w - 48, y + 3)
        ctx.textAlign = 'left'
      }
      ctx.fillStyle = 'rgba(255,255,255,0.65)'
      ctx.font = '18px sans-serif'
      ctx.fillText('—— 由记账本小程序生成', 32, h - 28)
      wx.canvasToTempFilePath({
        canvas: canvas,
        success: function (r) {
          self.setData({ posterPath: r.tempFilePath })
          wx.previewImage({ urls: [r.tempFilePath], current: r.tempFilePath })
        },
        fail: function () {
          wx.showToast({ title: '生成失败', icon: 'none' })
        }
      })
    })
  }
})

function ref0(p) {
  return p.start
}
