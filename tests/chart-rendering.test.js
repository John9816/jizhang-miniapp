var assert = require('assert')
var fs = require('fs')
var path = require('path')
var vm = require('vm')
var failures = 0
function test(name, fn) {
  try { fn(); console.log('PASS ' + name) }
  catch (e) { failures++; console.error('FAIL ' + name + ': ' + e.message) }
}
function setup() {
  var exports = [], canvases = {}, definition
  var context = new Proxy({}, { get: function (o, key) {
    if (key === 'measureText') return function () { return { width: 24 } }
    if (key === 'createLinearGradient') return function () { return { addColorStop: function () {} } }
    return o[key] || function () {}
  } })
  var wx = {
    getWindowInfo: function () { return { pixelRatio: 3 } },
    canvasToTempFilePath: function (options) { exports.push(options) },
    createSelectorQuery: function () {
      var selectors = [], current
      var query = {
        select: function (selector) { current = selector; return query },
        fields: function () {
          canvases[current] = canvases[current] || { getContext: function () { return context } }
          selectors.push({ node: canvases[current], width: 1, height: 1 }); return query
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
    Page: function (p) { definition = p }, wx: wx, setTimeout: setTimeout, clearTimeout: clearTimeout,
    require: function (p) {
      if (/db\.js$/.test(p)) return { currentLedger: function () { return { id: 'test' } }, recordsOf: function () { return [] } }
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
  return { page: page, exports: exports, canvases: canvases }
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
if (failures) process.exit(1)
