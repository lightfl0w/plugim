---
layout: home

hero:
  name: plugim
  text: 插件化即时通讯
  tagline: 部署、运维与开发文档
  actions:
    - theme: brand
      text: 快速开始
      link: /guide/install
    - theme: alt
      text: 环境变量
      link: /config/env
    - theme: alt
      text: 插件开发
      link: /dev/plugin

features:
  - title: 安装向导
    details: 第一次打开站点进入 /install，依次配置数据库与日志目录、创建管理员、选择注册策略
  - title: 单端口运行
    details: pnpm build 之后一个进程同时提供页面、RPC 和 WebSocket
  - title: 两种数据库
    details: SQLite 或 PostgreSQL，由安装向导写入的 data/install.json 决定
  - title: WebRTC 通话
    details: 语音、视频、屏幕共享；两端不在同一网络时需要 coturn 中继
  - title: 媒体文件外置
    details: 图片、语音、文件存本地磁盘或 S3 兼容对象存储，后台可切换、改上限、逐个删除
  - title: 插件化内核
    details: 前后端共用 @plugim/core 的 Context，服务、事件与界面槽位都靠声明装配，后端插件与界面插件都能单独启停
---
