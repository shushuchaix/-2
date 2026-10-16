import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "/app/",
  publicDir: false,
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: {
    outDir: "../public/app",
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: {
      output: {
        manualChunks(id) {
          const modulePath = id.replaceAll("\\", "/");
          if (
            modulePath.includes("/node_modules/@base-ui/") ||
            modulePath.includes("/node_modules/@floating-ui/")
          )
            return "ui-primitives";
          if (
            [
              "/node_modules/react/",
              "/node_modules/react-dom/",
              "/node_modules/scheduler/",
            ].some((part) => modulePath.includes(part))
          )
            return "react-runtime";
        },
      },
    },
  },
});
