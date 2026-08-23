// รัน env var ด้วย export (ตามปกติ) แล้วสั่ง: pm2 start ecosystem_config.js --update-env
// ห้ามใส่ API key ตรงนี้ — ใช้ export GEMINI_API_KEY=... / DISCORD_TOKEN=... ฯลฯ ใน shell ก่อน start เสมอ
module.exports = {
  apps: [
    {
      name: "skibidri-ai",
      script: "./index.js",
      cwd: __dirname,
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      max_memory_restart: "300M",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
