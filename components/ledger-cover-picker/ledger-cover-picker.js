/**
 * 账本封面选择器：预设渐变 + emoji 网格，外加「从相册选择」自定义图片。
 *
 * 受控组件：当前封面由父页面通过 cover 属性传入，用户选择后触发
 * coverchange 事件，父页面更新自己的状态后再传回来，组件不自己存封面。
 * 自定义图片走 avatar.persist 压缩成 dataURL（与头像同一套持久化方案），
 * 封面上限同样 200KB，能随分享包/云同步下发到其他设备。
 */
var u = require('../../utils/util.js')
var avatar = require('../../utils/avatar.js')

/**
 * 相册原图可能是几 MB 的大图，先降尺寸再交给 avatar.persist 压缩成 dataURL，
 * 否则很容易撞体积上限导致选图失败。用离屏 canvas，不依赖页面节点。
 * 封面只在 ≤112rpx 的图标位展示，480px 足够锐利，同步包也能保持轻量。
 */
function shrink(filePath, cb) {
  if (!wx.getImageInfo || !wx.createOffscreenCanvas || !wx.canvasToTempFilePath) {
    return cb(filePath)
  }
  wx.getImageInfo({
    src: filePath,
    success: function (info) {
      var MAX = 480
      var w = info.width || 0
      var h = info.height || 0
      if (!w || !h || (w <= MAX && h <= MAX)) return cb(filePath)
      var scale = Math.min(MAX / w, MAX / h)
      var cw = Math.round(w * scale)
      var ch = Math.round(h * scale)
      var canvas
      try {
        canvas = wx.createOffscreenCanvas({ type: '2d', width: cw, height: ch })
      } catch (e) { return cb(filePath) }
      var img = canvas.createImage()
      img.onload = function () {
        var ctx = canvas.getContext('2d')
        ctx.drawImage(img, 0, 0, cw, ch)
        wx.canvasToTempFilePath({
          canvas: canvas,
          fileType: 'jpg',
          quality: 0.7,
          success: function (r) { if (r.tempFilePath) return cb(r.tempFilePath); cb(filePath) },
          fail: function () { cb(filePath) }
        })
      }
      img.onerror = function () { cb(filePath) }
      img.src = filePath
    },
    fail: function () { cb(filePath) }
  })
}

Component({
  properties: {
    cover: { type: Object, value: null },
    title: { type: String, value: '选择封面' }
  },

  data: {
    covers: u.LEDGER_COVERS,
    current: { kind: 'preset', key: 'default' }
  },

  observers: {
    'cover': function (cover) {
      this.setData({ current: u.ledgerCoverInfo(cover) })
    }
  },

  lifetimes: {
    attached: function () {
      this.setData({ current: u.ledgerCoverInfo(this.data.cover) })
    }
  },

  methods: {
    onPickPreset: function (e) {
      var key = e.currentTarget.dataset.key
      this.setData({ current: { kind: 'preset', key: key } })
      this.triggerEvent('coverchange', { cover: { kind: 'preset', key: key } })
    },

    onChooseImage: function () {
      var self = this
      wx.chooseMedia({
        count: 1,
        mediaType: ['image'],
        sizeType: ['compressed'],
        sourceType: ['album', 'camera'],
        success: function (res) {
          var file = res.tempFiles && res.tempFiles[0]
          if (!file || !file.tempFilePath) return
          wx.showLoading({ title: '处理图片', mask: true })
          shrink(file.tempFilePath, function (small) {
            avatar.persist(small, function (err, dataUrl) {
              wx.hideLoading()
              if (err || !dataUrl) {
                wx.showToast({ title: (err && err.message) || '图片处理失败', icon: 'none' })
                return
              }
              self.setData({ current: { kind: 'image', image: dataUrl } })
              self.triggerEvent('coverchange', { cover: { kind: 'image', image: dataUrl } })
            })
          })
        }
      })
    }
  }
})
