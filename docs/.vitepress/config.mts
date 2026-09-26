import { defineConfig } from "vitepress";

export default defineConfig({
    lang: "zh-CN",
    title: "plugim",
    description: "插件化即时通讯的部署与运维文档",
    lastUpdated: true,
    cleanUrls: true,
    themeConfig: {
        nav: [
            { text: "指南", link: "/guide/install", activeMatch: "/guide/" },
            { text: "配置", link: "/config/env", activeMatch: "/config/" },
        ],
        sidebar: {
            "/guide/": [
                {
                    text: "部署指南",
                    items: [
                        { text: "安装与初始化", link: "/guide/install" },
                        { text: "生产部署", link: "/guide/deploy" },
                        {
                            text: "反向代理与 HTTPS",
                            link: "/guide/reverse-proxy",
                        },
                        { text: "TURN 音视频中继", link: "/guide/turn" },
                        { text: "备份与升级", link: "/guide/backup" },
                    ],
                },
            ],
            "/config/": [
                {
                    text: "配置参考",
                    items: [{ text: "环境变量", link: "/config/env" }],
                },
            ],
        },
        search: { provider: "local" },
        outline: { level: [2, 3] },
        socialLinks: [],
        footer: { message: "plugim 部署文档" },
    },
});
