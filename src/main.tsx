import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MotionConfig } from 'motion/react'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.tsx'
import AppErrorBoundary from './components/AppErrorBoundary'
import NativeAppBridge from './components/NativeAppBridge'
import { AuthProvider } from './lib/AuthContext'
import { startNativeApp } from './lib/native'
import { registerServiceWorker } from './lib/pwa'

startNativeApp()
registerServiceWorker()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <NativeAppBridge />
      {/* One switch for the whole app: with prefers-reduced-motion set, every
          transform/layout animation made with motion is skipped. */}
      <MotionConfig reducedMotion="user">
        <AuthProvider>
          <AppErrorBoundary>
            <App />
          </AppErrorBoundary>
        </AuthProvider>
      </MotionConfig>
    </BrowserRouter>
  </StrictMode>,
)
