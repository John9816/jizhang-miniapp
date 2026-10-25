Component({
  data: {
    // 0=首页 2=统计 3=我的（1 是中间的记一笔按钮，永不被选中）
    selected: 0,
    hidden: false,
    tabs: [
      { idx: 0, path: '/pages/index/index', icon: 'tab-home', on: 'tab-home-on', text: '首页' },
      { idx: 2, path: '/pages/stats/stats', icon: 'tab-stats', on: 'tab-stats-on', text: '统计' },
      { idx: 3, path: '/pages/profile/profile', icon: 'tab-me', on: 'tab-me-on', text: '我的' }
    ]
  },

  methods: {
    onTab(e) {
      var path = e.currentTarget.dataset.path
      var selected = { '/pages/index/index': 0, '/pages/stats/stats': 2, '/pages/profile/profile': 3 }
      if (this._navigating || selected[path] === this.data.selected || selected[path] === undefined) return
      this._navigating = true
      wx.switchTab({ url: path, complete: () => { this._navigating = false } })
    },

    onAdd() {
      if (this._navigating) return
      this._navigating = true
      wx.vibrateShort && wx.vibrateShort({ type: 'light' })
      wx.navigateTo({ url: '/pages/edit/edit', complete: () => { this._navigating = false } })
    }
  }
})
