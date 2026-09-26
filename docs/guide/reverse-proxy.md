# 反向代理与 HTTPS

plugim 只监听一个 HTTP 端口，反代要原样转发页面、`/rpc` 和 `/ws` 的 WebSocket 升级。非 localhost 访问时，浏览器只在安全上下文（HTTPS）下开放麦克风、摄像头，所以公网部署 HTTPS 是必须的。

## Caddy

`Caddyfile`：

```
im.example.com {
    encode gzip
    reverse_proxy 127.0.0.1:3000
}
```

Caddy 自动申请和续期证书，也原生支持 WebSocket 转发。

```bash
sudo systemctl reload caddy
```

## Nginx

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name im.example.com;

    ssl_certificate     /etc/letsencrypt/live/im.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/im.example.com/privkey.pem;

    client_max_body_size 32m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}

server {
    listen 80;
    server_name im.example.com;
    return 301 https://$host$request_uri;
}
```

::: warning 常见问题
1. `Upgrade`、`Connection` 头没带，页面能开但 WebSocket 连不上，表现为聊天页右上角一直显示连接中。
2. `client_max_body_size` 太小，图片和文件发不出去，建议至少 32m，和站内单文件上限 20MB 对应。
3. 证书链不完整，移动端 WebSocket 握手会失败。
:::

## 内网证书

没有公网域名就用 mkcert 给内网 IP 签一张，浏览器信任之后同样是安全上下文，麦克风、摄像头可用，Nginx、Caddy 配置不变。

## 验证

```bash
curl -I https://im.example.com/health
openssl s_client -connect im.example.com:443 </dev/null 2>/dev/null | head -2
```

浏览器打开站点，聊天页头部连接状态变绿就说明 WebSocket 通了。

跨 NAT 的媒体流需要中继，见 [TURN 音视频中继](/guide/turn)。
