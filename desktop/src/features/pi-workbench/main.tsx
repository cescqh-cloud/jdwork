import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@/theme/globals.css'
import { applyDocumentLocale, getInitialLocale } from '@/i18n/locale'
import { PiWorkbenchApp } from './PiWorkbenchApp'
import './workbench.css'

applyDocumentLocale(getInitialLocale())
const root = document.getElementById('root')
if (!root) throw new Error('Pi workbench root is missing')
createRoot(root).render(<StrictMode><PiWorkbenchApp /></StrictMode>)
