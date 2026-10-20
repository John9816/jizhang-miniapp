/**
 * 微信头像持久化工具。
 *
 * 背景：`button open-type="chooseAvatar"` 回调里的 avatarUrl 是**临时文件路径**
 * （形如 http://tmp/wxXXXX.png 或 wxfile://tmp_...），小程序下一次冷启动后即失效。
 * 直接存路径的结果是「头像昨天还好好的，今天变空白」。
 *
 * 做法：压缩 → 读成 base64 → 按真实格式拼 dataURL 落本地库。既在本机长期有效，
 * 也能随云同步下发到其他设备（头像压到几 KB 级，不会撑大同步包）。
 */

var MAX_DATA_LEN = 200000 // 与 db/cloud 的长度上限保持一致

/** 由 base64 首字节判断真实图片格式（避免 MIME 写错导致 image 组件不渲染） */
function mimeOf(base64) {
  if (base64.indexOf('iVBORw0KGgo') === 0) return 'png'
  if (base64.indexOf('/9j/') === 0) return 'jpeg'
  if (base64.indexOf('R0lGOD') === 0) return 'gif'
  if (base64.indexOf('UklGR') === 0) return 'webp'
  return 'png'
}

function toDataUrl(base64) {
  return 'data:image/' + mimeOf(base64) + ';base64,' + base64
}

function readAsDataUrl(fs, filePath, cb) {
  fs.readFile({
    filePath: filePath,
    encoding: 'base64',
    success: function (r) {
      var out = toDataUrl(r.data)
      if (out.length > MAX_DATA_LEN) return cb(new Error('头像过大，请重试'))
      cb(null, out)
    },
    fail: function (e) { cb(new Error((e && e.errMsg) || '读取头像失败')) }
  })
}

/**
 * 把 chooseAvatar 的临时路径转成永久可用的 dataURL。
 * @param {string} src  临时头像路径 / 已是 dataURL 或 http 地址
 * @param {function} cb callback(err, dataUrl)
 */
function persist(src, cb) {
  src = String(src || '')
  if (!src) return cb(new Error('头像路径为空'))
  // 已经是我们自己持久化的 dataURL，或服务端返回的永久地址，无需再处理
  if (/^data:image\//.test(src)) {
    return src.length > MAX_DATA_LEN ? cb(new Error('头像过大')) : cb(null, src)
  }
  if (/^https?:\/\//.test(src)) return cb(null, src)

  var fs = wx.getFileSystemManager && wx.getFileSystemManager()
  if (!fs) return cb(new Error('当前环境不支持读取头像文件'))

  if (!wx.compressImage) return readAsDataUrl(fs, src, cb)
  wx.compressImage({
    src: src,
    quality: 70,
    success: function (r) { readAsDataUrl(fs, r.tempFilePath, cb) },
    fail: function () { readAsDataUrl(fs, src, cb) }
  })
}

module.exports = { persist: persist, mimeOf: mimeOf, MAX_DATA_LEN: MAX_DATA_LEN }
