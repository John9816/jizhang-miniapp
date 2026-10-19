#!/usr/bin/env bash
# 记账本小程序后端一键部署（Debian 12 / 阿里云 ECS）
# 架构：node 服务监听 127.0.0.1:3123（HTTP） → nginx 反代 → certbot HTTPS 证书
# 用法：bash deploy.sh   （在 server/ 目录下执行）
set -euo pipefail

APP_DIR=/opt/jizhang-api
SVC=jizhang-api
DOMAIN=jizhang-api.751152.xyz

echo "==> [1/7] 检查 Node.js（需要 >= 22.5）"
NODE_MAJOR=0
NODE_MINOR=0
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR=$(node -p 'parseInt(process.versions.node.split(".")[0], 10)')
  NODE_MINOR=$(node -p 'parseInt(process.versions.node.split(".")[1], 10)')
fi
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 5 ]; }; then
  echo "    未检测到 Node 22.5+，通过 NodeSource 安装 Node 24 LTS ..."
  apt-get update -y
  apt-get install -y ca-certificates curl gnupg
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi
node -v
node -e 'require("node:sqlite")' 2>/dev/null || { echo "当前 Node 不支持内置 node:sqlite，请升级"; exit 1; }

echo "==> [2/7] 创建运行用户与目录"
id -u jizhang >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin jizhang
mkdir -p "$APP_DIR/data"
cp -f server.js backup.js .env.example "$APP_DIR/"
chown -R jizhang:jizhang "$APP_DIR"
if [ ! -f "$APP_DIR/.env" ]; then
  cp -f .env.example "$APP_DIR/.env"
  chown jizhang:jizhang "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  echo "    已生成 $APP_DIR/.env —— 请编辑填入 APPID/APPSECRET"
fi

echo "==> [3/7] 防火墙状态确认（80/443 由 nginx 对外，安全组需已放行）"
if command -v ufw >/dev/null 2>&1; then
  ufw --no-pager status | head -20 || true
else
  echo "    未安装 ufw，跳过（阿里云安全组层面管理）。"
fi

echo "==> [4/7] 安装 systemd 服务"
NODE_BIN=$(command -v node)
cp -f jizhang-api.service "/etc/systemd/system/$SVC.service"
sed -i "s|^ExecStart=.*|ExecStart=$NODE_BIN server.js|" "/etc/systemd/system/$SVC.service"
systemctl daemon-reload
systemctl enable "$SVC" >/dev/null 2>&1
systemctl restart "$SVC"
sleep 1
systemctl --no-pager --lines=5 status "$SVC" || true

echo "==> [5/7] 安装 nginx 反代配置"
if [ -f nginx-jizhang-api.conf ] && command -v nginx >/dev/null 2>&1; then
  cp -f nginx-jizhang-api.conf /etc/nginx/conf.d/jizhang-api.conf
  if nginx -t 2>/dev/null; then
    systemctl reload nginx
    echo "    已安装 /etc/nginx/conf.d/jizhang-api.conf 并 reload"
  else
    echo "    nginx -t 校验失败，请检查配置"
  fi
else
  echo "    未安装 nginx 或无配置文件，跳过"
fi

echo "==> [6/7] 每日自动备份"
cat > /etc/cron.daily/jizhang-backup <<EOF
#!/bin/sh
$NODE_BIN $APP_DIR/backup.js >> $APP_DIR/data/backup.log 2>&1
EOF
chmod 755 /etc/cron.daily/jizhang-backup

echo "==> [7/7] 完成。后续步骤："
cat <<TIPS
  1. 编辑 /opt/jizhang-api/.env 填入 APPID / APPSECRET，然后：
     systemctl restart jizhang-api
  2. HTTPS 证书（nginx 已托管 443，certbot 已在本机，自动续期已开启）：
     certbot --nginx -d $DOMAIN --redirect --non-interactive
  3. 小程序后台 → 开发管理 → 开发设置 → 服务器域名：
     request 合法域名填 https://$DOMAIN
  4. 小程序端：config.js 里 cloud.enabled = true，apiBase = https://$DOMAIN
TIPS
