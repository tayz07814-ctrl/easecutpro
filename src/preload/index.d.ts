import type { EaseCutApi } from './index'

declare global {
  interface Window {
    api: EaseCutApi
  }
}

export {}
