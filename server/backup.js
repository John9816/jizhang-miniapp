#!/usr/bin/env node
/**
 * SQLite 每日备份：先 checkpoint 再拷贝，保留最近 14 份。
 * 由 cron.daily 调用：node /opt/jizhang-api/backup.js
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')

const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data')
const src = process.env.DATA_FILE || path.join(dataDir, 'jizhang.db')
const backupDir = path.join(dataDir, 'backups')
fs.mkdirSync(backupDir, { recursive: true })

const stamp = new Date().toISOString().slice(0, 10)
const dest = path.join(backupDir, 'jizhang-' + stamp + '.db')

const d = new DatabaseSync(src)
try {
  d.exec('PRAGMA wal_checkpoint(TRUNCATE)')
} catch (e) {
  console.error('[jizhang-backup] checkpoint 失败（仍尝试拷贝）：', e && e.message)
}
d.close()
fs.copyFileSync(src, dest)

const files = fs.readdirSync(backupDir)
  .filter(function (f) { return /^jizhang-\d{4}-\d{2}-\d{2}\.db$/.test(f) })
  .sort()
while (files.length > 14) {
  const f = files.shift()
  fs.unlinkSync(path.join(backupDir, f))
}
console.log('[jizhang-backup] ' + dest + ' (' + (fs.statSync(dest).size / 1024).toFixed(1) + ' KB)')
