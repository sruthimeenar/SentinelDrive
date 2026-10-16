import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'

// StrictMode is intentionally disabled: in dev it double-mounts effects, which
// would open the webcam stream twice and show duplicate permission prompts.
ReactDOM.createRoot(document.getElementById('root')).render(<App />)
