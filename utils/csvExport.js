// 文件发送由用户在微信的选择窗口中完成。
var u = require('./util.js')
var busy = false

function show(options) {
  options = options || {}
  if (busy) return Promise.resolve({ ok: false, busy: true })
  if (!options.csv || !options.count) {
    wx.showToast({ title: '没有可导出的记录', icon: 'none' })
    return Promise.resolve({ ok: false })
  }
  busy = true
  return new Promise(function (resolve) {
    var loading = false
    function finish(result) {
      if (loading) wx.hideLoading()
      busy = false
      resolve(result)
    }
    function fail(err, message) {
      var cancelled = /cancel/i.test((err && err.errMsg) || '')
      if (!cancelled) wx.showToast({ title: message, icon: 'none' })
      finish({ ok: false, cancelled: cancelled })
    }
    wx.showActionSheet({
      itemList: ['导出 CSV 文件', '复制 CSV 内容'],
      success: function (choice) {
        if (choice.tapIndex === 1) {
          wx.setClipboardData({
            data: options.csv,
            success: function () {
              wx.showToast({ title: '已复制 ' + options.count + ' 笔', icon: 'success' })
              finish({ ok: true, mode: 'copy' })
            },
            fail: function (err) { fail(err, '复制失败，请重试') }
          })
          return
        }
        if (!wx.shareFileMessage || !wx.env || !wx.env.USER_DATA_PATH) {
          wx.showToast({ title: '当前微信不支持文件分享，请选择复制或更新微信', icon: 'none' })
          return finish({ ok: false })
        }
        loading = true
        wx.showLoading({ title: '生成文件', mask: true })
        // 固定一个缓存文件，避免每次导出都占用新的本机空间。
        var filePath = wx.env.USER_DATA_PATH + '/jizhang-export.csv'
        var name = String(options.name || '账本').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '').trim().slice(0, 48) || '账本'
        var fileName = name + '_' + u.dateStr(new Date()) + '.csv'
        wx.getFileSystemManager().writeFile({
          filePath: filePath, data: options.csv, encoding: 'utf8',
          success: function () {
            wx.hideLoading()
            loading = false
            wx.shareFileMessage({
              filePath: filePath, fileName: fileName,
              success: function () { finish({ ok: true, mode: 'file' }) },
              fail: function (err) { fail(err, '文件发送失败，可重试或选择复制') }
            })
          },
          fail: function (err) { fail(err, '文件生成失败，请检查存储空间或选择复制') }
        })
      },
      fail: function (err) { fail(err, '无法打开导出选项，请重试') }
    })
  })
}

module.exports = { show: show }
