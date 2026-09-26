# TURN 音视频中继

语音、视频、屏幕共享走 WebRTC。同一个局域网里 STUN 一般就能直连；跨 NAT（家宽、4G/5G）就必须有 TURN 中继，否则能接通但听不到声音、看不到画面。

## 部署 coturn

```bash
apt install coturn
```

`/etc/turnserver.conf` 里几个关键项：

```ini
listening-port=3478
tls-listening-port=5349
realm=turn.example.com
external-ip=203.0.113.10
min-port=49160
max-port=49200
fingerprint
use-auth-secret
static-auth-secret=与下面 PLUGIM_TURN_PASS 一致
no-multicast-peers
no-cli
pidfile=/var/run/turnserver.pid
```

```bash
sed -i 's/TURNSERVER_ENABLED=0/TURNSERVER_ENABLED=1/' /etc/default/coturn
systemctl restart coturn
systemctl enable coturn
```

`external-ip` 填 TURN 机器的公网 IP；这台机器本身还在内网 NAT 后面时，写成 `公网IP/内网IP`。防火墙放行 UDP 3478、TCP/UDP 5349 和 49160-49200 端口段。

## plugim 侧配置

`.env` 里填三项：

```bash
PLUGIM_TURN_URL=turn:turn.example.com:3478?transport=udp
PLUGIM_TURN_USER=plugim
PLUGIM_TURN_PASS=与 static-auth-secret 一致
```

服务端在通话信令里把凭证下发给两端，前端不用改。

::: warning
`PLUGIM_TURN_PASS` 就是 coturn 的长期共享密钥，拿到它的人都能用你的中继带宽。公网环境建议定期轮换，配合防火墙限制来源；更稳的做法是改成 RESTful 时间限定凭证（hmac 短期用户名）。
:::

## STUN

默认内置 Google 公共 STUN `stun:stun.l.google.com:19302`，可以用 `PLUGIM_STUN_URLS` 换成自建列表，逗号分隔。配了 TURN 之后 STUN 只负责加速直连探测，可以保留。

## 验证

1. 两端设备接到不同的网络（蜂窝网络或不同 NAT 后面）
2. 发起语音通话，能听到声音
3. 在 TURN 机器上抓包，能看到中继流量：`tcpdump -i any -n port 49160 or port 3478`

通话能接通但没声音、信令正常，基本就是 TURN 没配好或者端口段没放行。`chrome://webrtc-internals` 里看 `local-candidate-type` 是不是 `relay` 也能确认。
