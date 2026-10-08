import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MotionConfig } from 'motion/react'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.tsx'
import { AuthProvider } from './lib/AuthContext'
import { registerServiceWorker } from './lib/pwa'

registerServiceWorker()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      {/* One switch for the whole app: with prefers-reduced-motion set, every
          transform/layout animation made with motion is skipped. */}
      <MotionConfig reducedMotion="user">
        <AuthProvider>
          <App />
        </AuthProvider>
      </MotionConfig>
    </BrowserRouter>
  </StrictMode>,
)
