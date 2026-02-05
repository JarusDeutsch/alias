import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'

const buildTimestamp = new Date().toISOString()

export default defineConfig({
  plugins: [tailwindcss()],
  define: {
    __BUILD_TIMESTAMP__: JSON.stringify(buildTimestamp),
  },
})

