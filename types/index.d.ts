export type Snapshot = {
  mode: string
  tier: string | null
  model: string | null
  reason: string
  classifier: string
  queued: number
}

declare module 'claude-code' {
  interface PluginState {
    gearshift: { snapshot: Snapshot; band: boolean }
  }
}
