// 使用开发者工具自带的官方编译器验证模板和样式；仅输出临时产物。
var fs = require('fs')
var path = require('path')
var os = require('os')
var cp = require('child_process')
var root = path.join(__dirname, '..')
var bin = process.env.WECHAT_COMPILER_DIR || '/Applications/wechatwebdevtools.app/Contents/Resources/app.asar.unpacked/node_modules/wcc-exec'
if (!fs.existsSync(path.join(bin, 'wcc')) || !fs.existsSync(path.join(bin, 'wcsc'))) {
  console.error('未找到微信编译器，请通过 WECHAT_COMPILER_DIR 指定包含 wcc/wcsc 的目录。')
  process.exit(1)
}
function files(dir, ext) {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).reduce(function (out, item) {
    var name = path.join(dir, item.name)
    return out.concat(item.isDirectory() ? files(name, ext) : item.name.endsWith(ext) ? [name] : [])
  }, [])
}
var dirs = ['pages', 'components', 'custom-tab-bar']
var wxml = dirs.reduce(function (out, dir) { return out.concat(files(dir, '.wxml')) }, [])
var wxss = ['app.wxss', 'motion.wxss'].concat(dirs.reduce(function (out, dir) { return out.concat(files(dir, '.wxss')) }, []))
var temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jizhang-ui-compile-'))
try {
  ;[
    { bin: 'wcc', args: ['-o', path.join(temp, 'compiled.js')].concat(wxml), count: wxml.length },
    { bin: 'wcsc', args: ['-o', path.join(temp, 'compiled.css'), '-pc', String(wxss.length)].concat(wxss), count: wxss.length }
  ].forEach(function (task) {
    var result = cp.spawnSync(path.join(bin, task.bin), task.args, { cwd: root, encoding: 'utf8' })
    if (result.error) throw result.error
    if (result.status !== 0) throw Error(task.bin + ' 编译失败\n' + (result.stderr || '') + (result.stdout || ''))
    console.log('PASS ' + task.bin + '：' + task.count + ' 个文件编译通过')
  })
} catch (e) {
  console.error(e.message)
  process.exitCode = 1
} finally { fs.rmSync(temp, { recursive: true, force: true }) }
