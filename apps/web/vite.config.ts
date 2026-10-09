import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { dayTheme } from "./day-theme";
import { palette } from "./day-palette";

// 端口从环境变量读，默认是分配给够级的 5292（网页）/ 3021（服务）。
// 要另起一套服务（比如人机、界面用特殊环境变量测）时：WEB_PORT=5392 SERVER_PORT=3121 npm run dev。
const webPort = Number(process.env.WEB_PORT ?? 5292);
const serverPort = Number(process.env.SERVER_PORT ?? 3021);
const serverTarget = `http://localhost:${serverPort}`;

export default defineConfig({
  // 部署在子路径时用 BASE_PATH 指定，例如 BASE_PATH=/gouji/ npm run build。
  base: process.env.BASE_PATH ?? "/",
  plugins: [react(), dayTheme(palette)],
  server: {
    port: webPort,
    strictPort: true,
    proxy: {
      "/socket.io": { target: serverTarget, ws: true },
      "/health": serverTarget,
    },
  },
});
