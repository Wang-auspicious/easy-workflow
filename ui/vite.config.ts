import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const SERVER = `http://127.0.0.1:${process.env.FACTORY_PORT ?? 4317}`;

export default defineConfig({
  root: path.resolve(__dirname),
  base: "./",
  plugins: [react()],
  server: {
    port: 5317,
    strictPort: true,
    proxy: { "/api": { target: SERVER, changeOrigin: true }, "/evidence": { target: SERVER, changeOrigin: true } },
    fs: { allow: [path.resolve(__dirname, "..")] },
  },
  build: { outDir: "dist", emptyOutDir: true, target: "chrome130" },
});
