import React from 'react'
import ReactDOM from 'react-dom/client'
import '@fontsource-variable/inter/index.css'
import '@fontsource/jetbrains-mono/latin-400.css'
import '@fontsource/jetbrains-mono/latin-500.css'
import '@fontsource/jetbrains-mono/latin-600.css'
import './monaco'
import './styles.css'
import App from './App'

document.documentElement.dataset.platform = window.api?.platform ?? 'linux'
ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
