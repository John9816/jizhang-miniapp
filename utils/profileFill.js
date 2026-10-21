/**
 * 头像 / 昵称采集的「统一落库逻辑」。
 *
 * 首页首屏资料卡（components/profile-fill）与个人页（pages/profile）都从这里取，
 * 避免两处各写一遍 chooseAvatar 持久化 + 昵称保存，造成行为不一致。
 *
 * 平台约束（重要）：微信已废弃 wx.getUserProfile 的真实数据返回，头像与昵称
 * 必须由用户分别通过「chooseAvatar 按钮」和「nickname 输入框」两个独立手势给出，
 * 没有一次性同时拿到两者的 API。本模块只负责把这两份数据规范地落库 + 上云。
 */

var db = require('./db.js')
var cloud = require('./cloud.js')
var avatar = require('./avatar.js')

/**
 * 保存头像：chooseAvatar 回调里的 avatarUrl 是临时路径，必须压成 dataURL 长期保存。
 * @param {string} tempUrl chooseAvatar 给的临时路径
 * @param {function} cb callback(err, dataUrl)
 */
function applyAvatar(tempUrl, cb) {
  avatar.persist(tempUrl, function (err, dataUrl) {
    if (err) return cb && cb(err)
    db.setProfile({ avatar: dataUrl })
    cloud.updateProfile({ avatar: dataUrl })
    if (cb) cb(null, dataUrl)
  })
}

/**
 * 保存昵称：input type="nickname" 的 bindnickname（微信昵称建议）或手动输入都走这里。
 * @param {string} value 昵称原文
 * @returns {boolean} 是否发生了实际写入
 */
function applyNickname(value) {
  var v = String(value == null ? '' : value).trim().slice(0, 12)
  if (!v) return false
  if (v === db.getMe().name) return false
  db.setMyName(v)
  cloud.updateProfile({ nickname: v })
  return true
}

/**
 * 头像加载失败：dataURL 不会过期；走到这里说明存的是失效的 http 地址，清掉让用户重选。
 * @returns {boolean} 是否清除了头像
 */
function onAvatarError(src) {
  if (src && /^https?:\/\//.test(src)) {
    db.setProfile({ avatar: '' })
    return true
  }
  return false
}

module.exports = {
  applyAvatar: applyAvatar,
  applyNickname: applyNickname,
  onAvatarError: onAvatarError
}
