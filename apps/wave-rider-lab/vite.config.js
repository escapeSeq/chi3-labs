import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  build: {
    outDir: "app/static",
    emptyOutDir: true,
  },
  server: {
    host: true,
    port: 5173,
  },
  preview: {
    host: true,
    port: 4173,
  },
});
