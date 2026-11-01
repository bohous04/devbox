import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";

// Two bundles: the admin dashboard (index.html → dist/) and the guest page of the shared terminal
// (`vite build --mode share`: share.html → dist/share/). The guest gets only dist/share —
// the share listener in devd serves share.html and /assets/* from there, so the admin
// dashboard chunks are not publicly visible. Hence `base: "/"`: share.html lives at /s/<token> and
// references /assets/… from the root.
const share = defineConfig({
  base: "/",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: {
    outDir: "dist/share",
    emptyOutDir: false, // same reason as below; cleanup is done by tools/prune-dist-assets.ts
    rollupOptions: {
      input: fileURLToPath(new URL("./share.html", import.meta.url)),
      output: { manualChunks: { terminal: ["@xterm/xterm", "@xterm/addon-fit"], vendor: ["react", "react-dom"] } },
    },
  },
});

const admin = defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: {
    outDir: "dist",
    // DELIBERATELY not emptied. With `emptyOutDir: true` every deploy broke chunks for all
    // open tabs: a page is fetched only when clicked in the menu, and by then its
    // file no longer existed — a blank white page. Hashed names carry the content,
    // so two builds can sit side by side. Old ones are cleaned up by `bun run
    // tools/prune-dist-assets.ts` (runs right after the build, see package.json).
    emptyOutDir: false,
    rollupOptions: {
      output: {
        // Large dependencies into their own chunks, so they are cached across dashboard
        // deploys — their hash changes only when that library is upgraded.
        manualChunks: {
          charts: ["recharts"],
          terminal: ["@xterm/xterm", "@xterm/addon-fit"],
          vendor: ["react", "react-dom", "react-router-dom", "framer-motion"],
        },
      },
    },
  },
});

export default defineConfig(({ mode }) => (mode === "share" ? share : admin));
