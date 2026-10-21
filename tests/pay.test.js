/**
 * 个人虚拟支付接入测试：MOCK_WX 模式下以真实进程启动 server/server.js，
 * 覆盖：下单签名（paySig/signature 算法）、未知商品拒绝、未授权拒绝、
 * 发货推送（XML）幂等发货、VIP 状态生效并随 sync 下发。
 *
 * 运行：node tests/pay.test.js
 */
'use strict'

const { spawn } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const NODE = process.execPath
const PORT = 31345
const BASE = 'http://127.0.0.1:' + PORT
const SERVER = path.join(__dirname, '..', 'server', 'server.js')
const APP_KEY = 'test_app_key_0123456789'

let child = null
let passed = 0
let failed = 0

function test(name, fn) {
  return Promise.resolve().then(fn).then(function () {
    passed++
    console.log('  ok - ' + name)
  }, function (e) {
    failed++
    console.error('  FAIL - ' + name + ': ' + (e && e.message))
  })
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed') }

async function api(method, urlPath, body, token) {
  const headers = {}
  if (body !== undefined && body !== null) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = 'Bearer ' + token
  const resp = await fetch(BASE + urlPath, {
    method: method,
    headers: headers,
    body: body !== undefined && body !== null ? JSON.stringify(body) : undefined
  })
  let data = null
  try { data = await resp.json() } catch (e) {}
  return { status: resp.status, data: data }
}

function isHex64(s) { return typeof s === 'string' && /^[0-9a-f]{64}$/.test(s) }

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jizhang-pay-'))
  const dbFile = path.join(tmpDir, 'pay.db')

  child = spawn(NODE, [SERVER], {
    env: Object.assign({}, process.env, {
      MOCK_WX: '1',
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DATA_FILE: dbFile,
      VPAY_OFFER_ID: 'test_offer',
      VPAY_APP_KEY: APP_KEY,
      VPAY_PRODUCT_VIP: 'vip_perm',
      VPAY_PRODUCT_VIP_PRICE: '3000'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stderr = ''
  child.stderr.on('data', function (d) { stderr += d })

  const deadline = Date.now() + 10000
  let up = false
  while (Date.now() < deadline) {
    try { const r = await fetch(BASE + '/healthz'); if (r.ok) { up = true; break } } catch (e) {}
    await new Promise(function (r) { setTimeout(r, 150) })
  }
  if (!up) {
    console.error('服务未能在 10s 内启动，stderr:\n' + stderr)
    child.kill(); fs.rmSync(tmpDir, { recursive: true, force: true }); process.exit(1)
  }

  console.log('pay.test：个人虚拟支付接入（HTTP / MOCK_WX）')

  let tokenA = ''
  let openidA = ''

  await test('登录获取 token / openid', async function () {
    const a = await api('POST', '/api/login', { code: 'code-a', nickname: '小明' })
    assert(a.data.ok && a.data.token, '登录失败')
    tokenA = a.data.token
    openidA = a.data.me.id
  })

  await test('购买前 vip/status 为 false', async function () {
    const r = await api('GET', '/api/vip/status', null, tokenA)
    assert(r.data.ok && r.data.vip === false, '初始应为非会员')
  })

  await test('未知商品下单被拒（400）', async function () {
    const r = await api('POST', '/api/pay/order', { productId: 'bad_pid' }, tokenA)
    assert(r.status === 400 && /未知/.test(r.data.error || ''), '应拒绝未知商品')
  })

  await test('未带 token 下单应 401', async function () {
    const r = await api('POST', '/api/pay/order', { productId: 'vip_perm' })
    assert(r.status === 401, '应返回 401')
  })

  let outTradeNo = ''
  let signDataStr = ''
  await test('下单返回签名 payData，paySig 算法与官方一致', async function () {
    const r = await api('POST', '/api/pay/order', { productId: 'vip_perm' }, tokenA)
    assert(r.data.ok, '下单失败: ' + JSON.stringify(r.data))
    assert(r.data.mode === 'short_series_goods', 'mode 错误')
    assert(typeof r.data.signData === 'string', 'signData 应为字符串')
    signDataStr = r.data.signData
    const sd = JSON.parse(signDataStr)
    outTradeNo = sd.outTradeNo
    assert(/^T/.test(outTradeNo) && outTradeNo.length >= 8 && outTradeNo.length <= 32, 'outTradeNo 格式不符: ' + outTradeNo)
    assert(sd.productId === 'vip_perm' && sd.goodsPrice === 3000 && sd.env === 0 && sd.buyQuantity === 1, 'signData 字段错误')
    assert(r.data.paySig === crypto.createHmac('sha256', APP_KEY).update('requestVirtualPayment&' + signDataStr).digest('hex'), 'paySig 与官方算法不一致')
    assert(isHex64(r.data.signature), 'signature 应为 64 位 hex')
  })

  await test('发货推送（XML）后 VIP 生效且幂等', async function () {
    const xml = '<xml>' +
      '<Event><![CDATA[xpay_goods_deliver_notify]]></Event>' +
      '<OpenId><![CDATA[' + openidA + ']]></OpenId>' +
      '<OutTradeNo><![CDATA[' + outTradeNo + ']]></OutTradeNo>' +
      '<WeChatPayInfo><MchOrderNo><![CDATA[wx_order_001]]></MchOrderNo></WeChatPayInfo>' +
      '<GoodsInfo><ProductId><![CDATA[vip_perm]]></ProductId><Quantity>1</Quantity></GoodsInfo>' +
      '</xml>'
    const r = await fetch(BASE + '/api/pay/notify', {
      method: 'POST', headers: { 'Content-Type': 'text/xml' }, body: xml
    })
    assert(r.ok, '推送应成功')
    const txt = await r.text()
    assert(/ErrCode>0/.test(txt), '推送响应应含 ErrCode 0')

    const status = await api('GET', '/api/vip/status', null, tokenA)
    assert(status.data.ok && status.data.vip === true, '发货后仍为非会员')

    // 幂等：重复推送同一平台单号不重复发货（仍成功，不报错）
    const r2 = await fetch(BASE + '/api/pay/notify', {
      method: 'POST', headers: { 'Content-Type': 'text/xml' }, body: xml
    })
    assert(r2.ok, '重复推送应仍成功')
    const txt2 = await r2.text()
    assert(/ErrCode>0/.test(txt2), '重复推送响应应含 ErrCode 0')
  })

  await test('VIP 状态随 sync 快照下发到客户端', async function () {
    const r = await api('GET', '/api/sync?since=', null, tokenA)
    assert(r.data.me && r.data.me.vip === true, 'sync 的 me.vip 应为 true')
  })

  await test('非 deliver 事件被忽略且返回成功', async function () {
    const xml = '<xml><Event><![CDATA[other_event]]></Event></xml>'
    const r = await fetch(BASE + '/api/pay/notify', {
      method: 'POST', headers: { 'Content-Type': 'text/xml' }, body: xml
    })
    assert(r.ok, '非发货事件应被忽略并返回成功')
  })

  await test('消息推送 GET 验证回显 echostr', async function () {
    const r = await fetch(BASE + '/api/pay/notify?echostr=hello123')
    const txt = await r.text()
    assert(txt === 'hello123', 'echostr 应原样回显')
  })

  console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败')
  child.kill()
  fs.rmSync(tmpDir, { recursive: true, force: true })
  process.exit(failed ? 1 : 0)
}

main().catch(function (e) {
  console.error(e)
  if (child) child.kill()
  process.exit(1)
})
