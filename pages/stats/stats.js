const db = require('../../utils/db.js')
const u = require('../../utils/util.js')
const motion = require('../../utils/motion.js')
const vip = require('../../utils/vip.js')
const analytics = require('../../utils/advanced-stats.js')
const recordView = require('../../utils/record-view.js')
const calendar = require('../../utils/date-calendar.js')

// 金黄到深棕的明度差区分类别；图例始终提供名称、金额与占比。
var PALETTE = ['#E8A72D', '#8C641E', '#F6C95B', '#B78024', '#FFE2A0', '#D9B56B', '#6F4D18']

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
    contentTop: 64,
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
    lineChartPath: '',
    pieChartPath: '',
    barChartPath: '',
    chartError: false,
    showCustom: false,
    customStart: '',
    customEnd: '',
    posterShow: false,
    posterPath: '',
    analysisTab: 'compare', analysisTabs: [{key:'compare',name:'收支对比'},{key:'ranking',name:'分类排行'},{key:'calendar',name:'收支日历'}],
    analysis: { ranking: [], calendar: [], comparison: {} }, calendarMonth: '', selectedDay: null, comparisonTip: null, showAllRanks: false,
    weekdays: ['一','二','三','四','五','六','日']
  },

  onLoad() {
    var info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    var today = u.dateStr(new Date())
    this.setData({
      statusBar: (info && info.statusBarHeight) || 20,
      contentTop: u.navigationTop(info),
      customStart: today.slice(0, 8) + '01',
      customEnd: today
    })
    this.loadData()
  },

  onShow() {
    this._chartHidden = false
    motion.reveal(this)
    this.updateTabBar()
    if (this._loaded) this.loadData()
    this._loaded = true
  },

  onHide() { this.stopRendering(); motion.cleanup(this) },
  onUnload() { this.stopRendering(); motion.cleanup(this) },

  stopRendering() {
    this._chartHidden = true
    this._chartVersion = (this._chartVersion || 0) + 1
    clearTimeout(this._chartTimer)
    clearTimeout(this._posterTimer)
  },

  updateTabBar() {
    var tab = typeof this.getTabBar === 'function' && this.getTabBar()
    if (tab) tab.setData({ selected: 2, hidden: motion.hasOverlay(this, ['showCustom', 'posterShow']) })
  },

  /* ---------------- 条件切换 ---------------- */

  setPeriod(e) {
    var period = e.currentTarget.dataset.period
    if (period === 'custom') {
      if (this.data.showCustom) return
      this._customBefore = { start: this.data.customStart, end: this.data.customEnd }
      motion.open(this, 'showCustom')
      return
    }
    if (this.data.period === period) return
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
    if (!calendar.valid(s) || !calendar.valid(en) || s > en) {
      wx.showToast({ title: '请选择有效日期范围', icon: 'none' })
      return
    }
    if (daysInclusive(s, en) > 366) { wx.showToast({title:'日期范围最多为 366 天',icon:'none'}); return }
    if (!this.data.showCustom) return
    motion.close(this, 'showCustom', { patch: { period: 'custom', tip: null } })
    this._customBefore = null
    this.updateTabBar()
    this.loadData()
  },

  cancelCustom() {
    var patch = {}
    if (this._customBefore) {
      patch.customStart = this._customBefore.start
      patch.customEnd = this._customBefore.end
    }
    motion.close(this, 'showCustom', { patch: patch })
    this._customBefore = null
    this.updateTabBar()
  },

  goAdd() {
    wx.navigateTo({ url: '/pages/edit/edit' })
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

  setAnalysisTab(e) { this.setData({analysisTab:e.currentTarget.dataset.tab}); motion.reveal(this,'analysisMotion') },
  toggleRanks() { this.setData({showAllRanks:!this.data.showAllRanks}) },
  selectComparison(e) { this.setData({comparisonTip:this.data.analysis.series.find(function(p){return p.key===e.currentTarget.dataset.key})||null}) },
  changeCalendarMonth(e) {
    var month=calendar.shiftMonth(this.data.analysis.calendarMonth,Number(e.currentTarget.dataset.delta))
    if(month<this._analysisStart.slice(0,7)||month>this._analysisEnd.slice(0,7))return
    this.setData({calendarMonth:month,selectedDay:null});this.loadAnalysis()
  },
  loadAnalysis() {
    var ledger=db.currentLedger();if(!ledger||!this._analysisStart)return
    var type=this.data.pieType
    var result=analytics.build(db.recordsOf(ledger.id),this._analysisStart,this._analysisEnd,type,function(key){return recordView.categoryInfo(ledger.id,type,key)},this.data.calendarMonth)
    this.setData({analysis:result,calendarMonth:result.calendarMonth})
    return result
  },
  selectCalendarDay(e) {
    var day=this.data.analysis.calendar.find(function(d){return d.date===e.currentTarget.dataset.date})
    if(!day||day.disabled||!day.inMonth)return
    this.setData({selectedDay:day})
  },
  viewAnalysisRecords(e) {
    var day=this.data.selectedDay,category=e.currentTarget.dataset.category||''
    var start=category?this._analysisStart:(day&&day.date),end=category?this._analysisEnd:(day&&day.date)
    if(!start)return
    wx.navigateTo({url:'/pages/search/search?type='+this.data.pieType+'&start='+start+'&end='+end+'&category='+encodeURIComponent(category)})
  },

  loadData() {
    // 条件变化时立即使旧导出失效，不能等下一次绘制才切换版本。
    this._chartVersion = (this._chartVersion || 0) + 1
    this._geom = null
    this._lineNode = null
    clearTimeout(this._chartTimer)
    this.setData({ lineChartPath: '', pieChartPath: '', barChartPath: '', chartError: false, tip: null })
    var ledger = db.currentLedger()
    if (!ledger) {
      this.setData({ hasData: false, periodLabel: '暂无账本' })
      return
    }
    var period = this.data.period
    var p = u.periodOf(period, this.refDate(), { start: this.data.customStart, end: this.data.customEnd })
    var recs = db.recordsOf(ledger.id)
    var all = recs.filter(function (r) { return r.date >= p.start && r.date <= p.end })
    this._analysisStart=p.start;this._analysisEnd=p.end
    this.setData({selectedDay:null,showAllRanks:false,comparisonTip:null})
    var advanced=this.loadAnalysis()

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
    // 自定义区间没有等长的「上一周期」，不展示环比（此前 prevRecs 为空会被 momChange 算成 +100%）
    var momPct = period === 'custom' ? null : (this.data.pieType === 'income' ? mom.incomePct : mom.expensePct)

    // 日均
    var today = u.dateStr(new Date())
    var endForAvg = p.end < today ? p.end : today
    var days = daysInclusive(p.start, endForAvg < p.start ? p.start : endForAvg)
    var mainTotal = this.data.pieType === 'income' ? s.income : s.expense

    // 占比
    var cats = advanced.ranking
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
    // 超过 6 项合并尾部（金额也要合并展示，否则「其他」行只有占比没有金额）
    if (pieItems.length > 6) {
      var restCats = cats.slice(5)
      var restPct = 0
      var restAmount = 0
      for (var i = 0; i < restCats.length; i++) {
        restPct += restCats[i].pct
        restAmount += restCats[i].amount
      }
      pieItems = pieItems.slice(0, 5)
      pieItems.push({ key: '__rest', name: '其他 ' + restCats.length + ' 项', icon: '✨', pct: Math.round(restPct * 10) / 10, amountText: u.formatCents(restAmount), color: PALETTE[6] })
    }

    // 趋势
    var trend = period === 'year'
      ? monthlySeries(all, p.start, p.end)
      : u.trendSeries(all, p.start, p.end, 'day')

    this.setData({
      periodLabel: p.label,
      hasData: mainTotal > 0,
      mainLabel: this.data.pieType === 'income' ? '总收入' : '总支出',
      mainTotal: u.formatCents(mainTotal),
      momText: momPct === null ? '' : (momPct > 0 ? '+' : '') + momPct + '%',
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
    motion.reveal(this, 'chartMotion')

    var self = this
    clearTimeout(this._chartTimer)
    this._chartTimer = setTimeout(function () {
      self._chartTimer = null
      if (!self._chartHidden) self.drawCharts()
    }, 40)
  },

  /* ---------------- 绘制 ---------------- */

  drawCharts() {
    if (this._chartHidden) return
    var version = this._chartVersion = (this._chartVersion || 0) + 1
    this.setData({ chartError: false })
    var sys = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    var dpr = sys.pixelRatio || 2
    var self = this
    var query = wx.createSelectorQuery()
    query.select('#lineCanvas').fields({ node: true, size: true })
    query.select('#pieCanvas').fields({ node: true, size: true })
    query.select('#barCanvas').fields({ node: true, size: true })
    query.select('#lineChart').boundingClientRect()
    query.select('#pieChart').boundingClientRect()
    query.select('#barChart').boundingClientRect()
    query.exec(function (res) {
      if (self._chartHidden || self._chartVersion !== version) return
      if (!res || !res.length) return
      self._dpr = dpr
      var nodes = res.slice(0, 3).map(function (info, i) {
        var rect = res[i + 3]
        return info && info.node && rect && rect.width > 0 && rect.height > 0
          ? { node: info.node, width: rect.width, height: rect.height } : null
      })
      self._lineNode = nodes[0]
      self.drawLine(nodes[0], dpr)
      self.drawPie(nodes[1], dpr)
      self.drawBar(nodes[2], dpr)
    })
  },

  exportChart(kind, canvas) {
    var self = this
    var version = this._chartVersion
    var pending = this._chartExports || (this._chartExports = {})
    var id = pending[kind] = (pending[kind] || 0) + 1
    function current() {
      return !self._chartHidden && self._chartVersion === version && pending[kind] === id
    }
    function fail() { if (current()) self.setData({ chartError: true }) }
    try {
      wx.canvasToTempFilePath({
        canvas: canvas,
        fileType: 'png',
        success: function (res) {
          if (!current()) return
          var patch = {}
          patch[kind + 'ChartPath'] = res.tempFilePath
          self.setData(patch)
        },
        fail: fail
      })
    } catch (e) { fail() }
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
    var axis = u.chartAxis(max)
    max = axis.max
    ctx.font = '10px sans-serif'
    if (ctx.measureText) left = Math.max(left, ctx.measureText(axis.labels[0]).width + 12)

    var stepX = series.length > 1 ? (right - left) / (series.length - 1) : 0
    this._geom = { left: left, right: right, top: top, bottom: bottom, stepX: stepX, max: max, w: w, h: h }

    // 网格与纵轴
    ctx.strokeStyle = '#EFE3C7'
    ctx.lineWidth = 1
    ctx.font = '10px sans-serif'
    ctx.fillStyle = '#8C7959'
    ctx.textAlign = 'right'
    for (i = 0; i <= 3; i++) {
      var gy = top + (bottom - top) * i / 3
      ctx.beginPath()
      ctx.moveTo(left, gy)
      ctx.lineTo(right, gy)
      ctx.stroke()
      ctx.fillText(axis.labels[i], left - 6, gy + 3)
    }

    // 面积
    var grad = ctx.createLinearGradient(0, top, 0, bottom)
    grad.addColorStop(0, 'rgba(246, 201, 91, 0.36)')
    grad.addColorStop(1, 'rgba(246, 201, 91, 0.02)')
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
    ctx.strokeStyle = '#B78024'
    ctx.lineWidth = 2.4
    ctx.lineJoin = 'round'
    ctx.stroke()

    // 横轴标签
    ctx.fillStyle = '#8C7959'
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
      ctx.strokeStyle = '#D9B56B'
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
      ctx.strokeStyle = '#B78024'
      ctx.stroke()
    } else if (series.length) {
      // 末点高亮
      var ex = right
      var ey = bottom - (series[series.length - 1][key] / max) * (bottom - top)
      ctx.beginPath()
      ctx.arc(ex, ey, 4, 0, Math.PI * 2)
      ctx.fillStyle = '#B78024'
      ctx.fill()
    }
    this.exportChart('line', canvas)
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
      ctx.strokeStyle = '#F3E4B8'
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
    ctx.fillStyle = '#3B2A18'
    ctx.font = '600 ' + Math.max(12, Math.round(w * 0.108)) + 'px sans-serif'
    ctx.fillText(this.data.pieTotalText, cx, cy + 1)
    ctx.fillStyle = '#8C7959'
    ctx.font = Math.round(w * 0.068) + 'px sans-serif'
    ctx.fillText(this.data.pieType === 'income' ? '总收入' : '总支出', cx, cy + Math.round(w * 0.115))
    this.exportChart('pie', canvas)
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
      ctx.fillStyle = m.value === 0 ? '#F3E4B8' : (i === months.length - 1 ? '#E8A72D' : '#F6C95B')
      this.roundRect(ctx, x, y, bw * 0.56, Math.max(bh, 3), 3)
      ctx.fill()
      if (i % 2 === 0 || i === months.length - 1) {
        ctx.fillStyle = '#8C7959'
        ctx.font = '9px sans-serif'
        ctx.textAlign = 'center'
        ctx.fillText(parseInt(m.key.slice(5, 7), 10) + '月', x + bw * 0.28, h - 6)
      }
    }
    this.exportChart('bar', canvas)
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
    if (!this.data.hasData) return
    var g = this._geom
    var series = this.data.trend
    if (!g || !series || !series.length) return
    var t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0])
    if (!t) return
    var clientX = t.clientX != null ? t.clientX : t.x
    if (typeof clientX !== 'number') return
    var self = this
    var version = this._chartVersion
    // 普通 view/image 的触点是页面坐标，滚动后仍须以当前容器位置换算。
    wx.createSelectorQuery().select('#lineChart').boundingClientRect(function (rect) {
      if (!rect || self._chartHidden || self._chartVersion !== version) return
      var x = clientX - rect.left
      var idx = Math.round((x - g.left) / (g.stepX || 1))
      idx = Math.max(0, Math.min(series.length - 1, idx))
      self.selectPoint(idx)
    }).exec()
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
    if (vip.featureEnabled() && !db.isVip()) {
      wx.showModal({
        title: '海报为会员功能',
        content: '升级会员后可解锁高级统计图表与年度海报，分享更美观的收支报告。',
        confirmText: '去开通',
        cancelText: '知道了',
        success: function (r) { if (r.confirm) wx.navigateTo({ url: '/pages/vip/vip' }) }
      })
      return
    }
    // 与按钮文案一致：生成「当前查看周期」的海报（早期版本固定生成年度海报，与文案不符）
    var p = u.periodOf(this.data.period, this.data.refKey || u.dateStr(new Date()), {
      start: this.data.customStart,
      end: this.data.customEnd
    })
    var recs = db.recordsOf(ledger.id).filter(function (r) {
      return r.type !== 'transfer' && r.date >= p.start && r.date <= p.end
    })
    if (!recs.length) {
      wx.showToast({ title: this.data.periodLabel + ' 还没有记录', icon: 'none' })
      return
    }
    var self = this
    motion.open(this, 'posterShow', { posterPath: '' })
    this.setData({}, function () {
      clearTimeout(self._posterTimer)
      self._posterTimer = setTimeout(function () { if (self.data.posterShow) self.drawPoster(ledger, self.data.periodLabel, recs) }, 80)
    })
  },

  closePoster() {
    motion.close(this, 'posterShow', { after: () => { this.setData({ posterPath: '' }) } })
  },

  /** 保存海报到相册；被拒时引导去设置打开权限 */
  savePoster() {
    var path = this.data.posterPath
    if (!path) return
    wx.saveImageToPhotosAlbum({
      filePath: path,
      success: function () { wx.showToast({ title: '已保存到相册', icon: 'success' }) },
      fail: function (e) {
        var msg = (e && e.errMsg) || ''
        if (msg.indexOf('auth') >= 0) {
          wx.showModal({
            title: '需要相册权限',
            content: '请在设置中允许保存到相册，即可保存海报',
            confirmText: '去设置',
            cancelText: '取消',
            success: function (r) { if (r.confirm) wx.openSetting() }
          })
        } else {
          wx.showToast({ title: '保存失败', icon: 'none' })
        }
      }
    })
  },

  drawPoster(ledger, title, recs) {
    var s = u.calcSummary(recs)
    var top3 = u.categoryStats(recs, 'expense').slice(0, 3)
    var mem = u.memberStats(recs, ledger.members).length
    var self = this
    var query = wx.createSelectorQuery().in(this)
    query.select('#posterCanvas').fields({ node: true, size: true }).exec(function (res) {
      if (!res || !res[0] || !res[0].node) {
        self.closePoster()
        wx.showToast({ title: '画布初始化失败，请重试', icon: 'none' })
        return
      }
      // 注意：exec 回调的 this 不是 Page 实例，后续一律用 self；
      // 此前 this.roundRect 在 top3 非空时必抛 TypeError，海报永远停在「正在生成…」
      try {
        self.renderPoster(res[0], ledger, title, recs, s, top3, mem)
      } catch (e) {
        self.closePoster()
        wx.showToast({ title: '生成失败，请重试', icon: 'none' })
      }
    })
  },

  renderPoster(nodeInfo, ledger, title, recs, s, top3, mem) {
    var self = this
    var canvas = nodeInfo.node
    var w = nodeInfo.width
    var h = 470
    var dpr = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()).pixelRatio || 2
    canvas.width = w * dpr
    canvas.height = h * dpr
    var ctx = canvas.getContext('2d')
    ctx.scale(dpr, dpr)

    var grad = ctx.createLinearGradient(0, 0, w, h)
    grad.addColorStop(0, '#FFE9A8')
    grad.addColorStop(0.55, '#F6C95B')
    grad.addColorStop(1, '#E8A72D')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, w, h)

    ctx.fillStyle = 'rgba(255,255,255,0.26)'
    ctx.beginPath()
    ctx.arc(w - 34, 34, 84, 0, Math.PI * 2)
    ctx.fill()
    ctx.beginPath()
    ctx.arc(w - 96, h - 30, 60, 0, Math.PI * 2)
    ctx.fill()

    ctx.fillStyle = '#3B2A18'
    ctx.textAlign = 'left'
    ctx.font = '700 26px sans-serif'
    ctx.fillText(title + ' 账单', 28, 58)
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
      ctx.fillStyle = '#3B2A18'
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
      ctx.fillStyle = '#3B2A18'
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
        // 生成成功：收起 loading，弹出预览（保存按钮此时可用）
        self.setData({ posterPath: r.tempFilePath })
      },
      fail: function () {
        self.closePoster()
        wx.showToast({ title: '生成失败', icon: 'none' })
      }
    })
  }
})
