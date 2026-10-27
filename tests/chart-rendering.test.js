var assert = require('assert')
var fs = require('fs')
var path = require('path')
var vm = require('vm')
var failures = 0
function test(name, fn) {
  try { fn(); console.log('PASS ' + name) }
  catch (e) { failures++; console.error('FAIL ' + name + ': ' + e.message) }
}
function setup(options) {
  options = options || {}
  var exports = [], canvases = {}, definition, toasts = []
  var context = new Proxy({}, { get: function (o, key) {
    if (key === 'measureText') return function () { return { width: 24 } }
    if (key === 'createLinearGradient') return function () { return { addColorStop: function () {} } }
    return o[key] || function () {}
  } })
  var wx = {
    getWindowInfo: function () { return { pixelRatio: 3 } },
    canvasToTempFilePath: function (options) { exports.push(options) },
    showToast: function (options) { toasts.push(options) },
    createSelectorQuery: function () {
      var selectors = [], current
      var query = {
        in: function () { return query },
        select: function (selector) { current = selector; return query },
        fields: function () {
          if (current === '#posterCanvas' && options.missingPoster) {
            selectors.push({ node: null, width: 0, height: 0 })
            return query
          }
          canvases[current] = canvases[current] || { getContext: function () { return context } }
          selectors.push({ node: canvases[current], width: current === '#posterCanvas' ? 320 : 1, height: 1 }); return query
        },
        boundingClientRect: function (cb) {
          var rect = { left: 24, width: current === '#pieChart' ? 150 : 320, height: current === '#lineChart' ? 200 : 150 }
          selectors.push(rect); if (cb) cb(rect); return query
        },
        exec: function (cb) { if (cb) cb(selectors) }
      }
      return query
    }
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/stats/stats.js'), 'utf8'), {
    Page: function (p) { definition = p }, wx: wx, setTimeout: function () { return 1 }, clearTimeout: clearTimeout,
    require: function (p) {
      if (/db\.js$/.test(p)) return { currentLedger: function () { return { id: 'test' } }, recordsOf: function () { return options.records || [] } }
      if (/record-view\.js$/.test(p)) return { categoryInfo: function (ledgerId, type, key) { return { name: key, icon: '●' } } }
      return require(path.resolve(__dirname, '../pages/stats', p))
    }
  })
  var page = Object.assign({}, definition, {
    data: JSON.parse(JSON.stringify(definition.data)),
    setData: function (patch) { Object.assign(this.data, patch) }
  })
  page.data.hasData = true
  page.data.trend = [{ key: '2026-10-01', label: '10/01', expense: 100 }, { key: '2026-10-02', label: '10/02', expense: 200 }]
  page.data.pieItems = [{ pct: 100, color: '#E8A72D' }]
  return { page: page, exports: exports, canvases: canvases, toasts: toasts }
}
test('统计页面只展示普通图片，三个绘图画布均放在屏幕外', function () {
  var wxml = fs.readFileSync(path.join(__dirname, '../pages/stats/stats.wxml'), 'utf8')
  ;['line', 'pie', 'bar'].forEach(function (kind) {
    assert.ok(wxml.includes('src="{{' + kind + 'ChartPath}}"'), kind + ' 图表仍直接显示原生画布')
    assert.ok(new RegExp('<canvas[^>]+id="' + kind + 'Canvas"[^>]+class="chart-render-canvas"').test(wxml))
  })
  var css = fs.readFileSync(path.join(__dirname, '../pages/stats/stats.wxss'), 'utf8')
  assert.match(css, /\.chart-render-canvas\s*\{[^}]*left:\s*-\d{4,}px/)
})
test('图表按可见区域和屏幕像素比绘制，并导出为普通图片', function () {
  var s = setup(); s.page.drawCharts()
  assert.strictEqual(s.exports.length, 3)
  assert.strictEqual(s.canvases['#lineCanvas'].width, 960)
  assert.strictEqual(s.canvases['#lineCanvas'].height, 600)
  s.exports[0].success({ tempFilePath: 'line.png' })
  s.exports[1].success({ tempFilePath: 'pie.png' })
  s.exports[2].success({ tempFilePath: 'bar.png' })
  assert.strictEqual(s.page.data.lineChartPath, 'line.png')
  assert.strictEqual(s.page.data.pieChartPath, 'pie.png')
  assert.strictEqual(s.page.data.barChartPath, 'bar.png')
})
test('旧周期和已离开页面的异步图表不能覆盖当前图片', function () {
  var s = setup(); s.page.drawCharts(); s.page.drawCharts()
  assert.strictEqual(s.exports.length, 6)
  s.exports[3].success({ tempFilePath: 'current.png' })
  s.exports[0].success({ tempFilePath: 'stale.png' })
  assert.strictEqual(s.page.data.lineChartPath, 'current.png')
  s.page.stopRendering()
  s.exports[4].success({ tempFilePath: 'hidden.png' })
  assert.strictEqual(s.page.data.pieChartPath, '')
})
test('快速点选趋势时以最后一次点选图片为准', function () {
  var s = setup(); s.page.drawCharts()
  s.page.selectPoint(0); s.page.selectPoint(1)
  assert.strictEqual(s.exports.length, 5)
  s.exports[4].success({ tempFilePath: 'last-point.png' })
  s.exports[3].success({ tempFilePath: 'old-point.png' })
  assert.strictEqual(s.page.data.lineChartPath, 'last-point.png')
  assert.strictEqual(s.page.data.tip.index, 1)
})
test('趋势图片点选扣除容器偏移，使用本地坐标选择日期', function () {
  var s = setup(), selected
  s.page._geom = { left: 36, stepX: 100 }
  s.page.data.trend.push({ key: '2026-10-03' }, { key: '2026-10-04' })
  s.page.selectPoint = function (index) { selected = index }
  s.page.onChartTouch({ touches: [{ clientX: 200 }] })
  assert.strictEqual(selected, 1)
})
test('导出失败提供重试状态，重绘时清除失败提示', function () {
  var s = setup(); s.page.drawCharts()
  assert.strictEqual(s.exports.length, 3)
  s.exports[0].fail({ errMsg: 'export failed' })
  assert.strictEqual(s.page.data.chartError, true)
  s.page.drawCharts()
  assert.strictEqual(s.page.data.chartError, false)
})
test('海报包含支出前三名时可在 exec 回调中完成绘制并导出', function () {
  var s = setup()
  var recs = [
    { type: 'expense', category: 'food', amount: 3000, memberId: 'u1' },
    { type: 'expense', category: 'transport', amount: 2000, memberId: 'u1' },
    { type: 'expense', category: 'shopping', amount: 1000, memberId: 'u1' }
  ]
  s.page.drawPoster({ id: 'test', name: '家庭账本', members: { u1: { id: 'u1', name: '我' } } }, '2026年10月', recs)
  assert.strictEqual(s.exports.length, 1, '前三名卡片调用 roundRect 时不能丢失 Page 作用域')
  assert.strictEqual(s.canvases['#posterCanvas'].width, 960)
  s.exports[0].success({ tempFilePath: 'poster.png' })
  assert.strictEqual(s.page.data.posterPath, 'poster.png')
  assert.strictEqual(s.toasts.length, 0)
})
test('海报画布不存在时退出加载态并提示重试', function () {
  var s = setup({ missingPoster: true })
  s.page.drawPoster({ id: 'test', name: '家庭账本', members: {} }, '2026年10月', [{ type: 'expense', category: 'food', amount: 100 }])
  assert.strictEqual(s.exports.length, 0)
  assert.strictEqual(s.page.data.posterShow, false)
  assert.strictEqual(s.toasts[0].title, '画布初始化失败，请重试')
})
test('自定义统计区间不展示伪造环比，其他分类合并金额和占比', function () {
  var keys = ['food', 'transport', 'shopping', 'entertainment', 'medical', 'education', 'housing']
  var records = keys.map(function (key, i) {
    return { date: '2026-10-0' + (i + 1), type: 'expense', category: key, amount: (keys.length - i) * 100 }
  })
  var s = setup({ records: records })
  s.page.setData({ period: 'custom', customStart: '2026-10-01', customEnd: '2026-10-07' })
  s.page.loadData()
  assert.strictEqual(s.page.data.momText, '')
  assert.strictEqual(s.page.data.momUp, false)
  assert.strictEqual(s.page.data.pieItems.length, 6)
  var rest = s.page.data.pieItems[5]
  assert.strictEqual(rest.name, '其他 2 项')
  assert.strictEqual(rest.amountText, '3.00')
  assert.strictEqual(rest.pct, 10.7)
})
if (failures) process.exit(1)
