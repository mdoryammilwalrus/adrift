import { defineConfig } from "vite"
import { svelte } from "@sveltejs/vite-plugin-svelte"
import { viteSingleFile } from "vite-plugin-singlefile"

export default defineConfig({
  plugins: [
    svelte({

    }),
    (process.env.VITE_ADRIFT_SINGLEFILE && !process.env.VITE_ADRIFT_CDN) && viteSingleFile()
  ],
  build: {
    dev: true,
    minify: false,
    target: "esnext",
    outDir: "dist",
    sourcemap: true,
    rollupOptions: {
      external: [
        "./sw.js"
      ]
    }
  }
})
