module.exports = {
    apps: [
        {
            name: "plugim",
            script: "apps/server/target/release/plugim-server",
            cwd: __dirname,
            instances: 1,
            exec_mode: "fork",
            autorestart: true,
            max_restarts: 16,
            min_uptime: "20s",
            restart_delay: 3000,
            kill_timeout: 15000,
            listen_timeout: 20000,
            env: {
                PORT: "3000",
            },
            out_file: "data/logs/pm2-out.log",
            error_file: "data/logs/pm2-error.log",
            merge_logs: true,
            time: true,
        },
    ],
};
