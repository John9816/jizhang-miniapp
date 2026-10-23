var db = require('../../utils/db.js')
var profileFill = require('../../utils/profileFill.js')

Component({
  properties: {
    // 'onboard'：首屏合并资料卡（带标题/关闭/完成）；'edit'：个人页内联编辑态
    mode: { type: String, value: 'onboard' }
  },

  data: {
    localAvatar: '',
    localName: ''
  },

  lifetimes: {
    attached: function () {
      var p = db.getProfile()
      this.setData({
        localAvatar: p.avatar || '',
        localName: p.name || ''
      })
      // 云同步可能晚于 attached 到货（登录同步是异步的）：监听 db 变化，
      // 同步拉取到头像/昵称时立即回显，避免卡片里显示空资料
      var self = this
      this._offDb = db.onChange(function () {
        var q = db.getProfile()
        var next = {}
        if ((q.avatar || '') !== self.data.localAvatar) next.localAvatar = q.avatar || ''
        if ((q.name || '') !== self.data.localName) next.localName = q.name || ''
        if (Object.keys(next).length) self.setData(next)
      })
    },
    detached: function () {
      if (this._offDb) this._offDb()
      this._offDb = null
    }
  },

  methods: {
    onChooseAvatar: function (e) {
      var url = e.detail && e.detail.avatarUrl
      if (!url) return
      var self = this
      wx.showLoading({ title: '保存头像', mask: true })
      profileFill.applyAvatar(url, function (err, dataUrl) {
        wx.hideLoading()
        if (err) {
          wx.showToast({ title: err.message || '头像保存失败', icon: 'none' })
          return
        }
        self.setData({ localAvatar: dataUrl })
        self.triggerEvent('change', { avatar: dataUrl })
      })
    },

    // 微信昵称建议被选中（input type="nickname" 的 bindnickname 事件，最可靠的获取方式）
    onNicknamePick: function (e) {
      var v = (e.detail && e.detail.nickname) || ''
      if (profileFill.applyNickname(v)) {
        this.setData({ localName: v })
        this.triggerEvent('change', { name: v })
      }
    },

    onNicknameInput: function (e) {
      this.setData({ localName: e.detail.value })
    },

    // 手动输入失焦时保存（微信昵称授权失败时的兜底）
    onNicknameBlur: function (e) {
      var v = (e.detail && e.detail.value) || ''
      if (profileFill.applyNickname(v)) {
        this.setData({ localName: v })
        this.triggerEvent('change', { name: v })
      }
    },

    onAvatarErr: function () {
      var av = this.data.localAvatar
      if (profileFill.onAvatarError(av)) {
        this.setData({ localAvatar: '' })
      }
    },

    // onboard 模式：关闭（标记已读，不再打扰）
    onClose: function () {
      db.setProfile({ guideDone: true })
      this.triggerEvent('done')
    },

    // onboard 模式：用户点「完成」
    onComplete: function () {
      db.setProfile({ guideDone: true })
      this.triggerEvent('done')
    }
  }
})
