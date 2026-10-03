import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Served as static files from the :8000 hub at /kds/, so assets resolve
// from there rather than from the site root.
export default defineConfig({
  plugins: [react()],
  base: '/kds/'
})
