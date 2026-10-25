// 与 motion.wxss 的退出时长保持一致；动画结束前保留遮罩，防止点击穿透。
var EXIT_MS = 180

function updateTab(page) {
  if (typeof page.updateTabBar === 'function') page.updateTabBar()
}

function open(page, key, patch) {
  var entries = page._motionOverlays || (page._motionOverlays = {})
  if (entries[key]) clearTimeout(entries[key].timer)
  entries[key] = { timer: null }
  var data = Object.assign({}, patch || {})
  data[key] = true
  data[key + 'Leaving'] = false
  page.setData(data)
  updateTab(page)
}

function close(page, key, options) {
  if (!page.data[key]) return
  options = options || {}
  var entries = page._motionOverlays || (page._motionOverlays = {})
  if (entries[key]) clearTimeout(entries[key].timer)
  var entry = entries[key] = { timer: null }
  var data = Object.assign({}, options.patch || {})
  data[key] = false
  data[key + 'Leaving'] = true
  page.setData(data)
  updateTab(page)
  entry.timer = setTimeout(function () {
    if (entries[key] !== entry) return
    delete entries[key]
    var patch = {}
    patch[key + 'Leaving'] = false
    page.setData(patch)
    updateTab(page)
    if (typeof options.after === 'function') options.after()
  }, EXIT_MS)
}

function hasOverlay(page, keys) {
  return keys.some(function (key) { return !!(page.data[key] || page.data[key + 'Leaving']) })
}

function cleanup(page) {
  var entries = page._motionOverlays || {}
  var patch = {}
  Object.keys(entries).forEach(function (key) {
    clearTimeout(entries[key].timer)
    patch[key] = false
    patch[key + 'Leaving'] = false
  })
  page._motionOverlays = {}
  if (Object.keys(patch).length) page.setData(patch)
  updateTab(page)
}

// 两个同形的关键帧交替使用，数据刷新不清空内容，也不为动画反复重建列表。
function reveal(page, field) {
  field = field || 'pageMotion'
  var patch = {}
  patch[field] = page.data[field] === 'motion-a' ? 'motion-b' : 'motion-a'
  page.setData(patch)
}

module.exports = { open: open, close: close, hasOverlay: hasOverlay, cleanup: cleanup, reveal: reveal }
