import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    host: true, // listen on every interface so a phone on Tailscale / the LAN can open the dashboard
    proxy: {
      '/api': 'http://localhost:8788',
    },
  },
})
