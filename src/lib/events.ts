import { EventEmitter } from "node:events"
import type { PendingAction, ProductionRun } from "./demo-types"

export type RealtimeEventType =
  | "CONNECTED"
  | "RUN_UPDATED"
  | "TASK_PROPOSED"
  | "TASK_CONFIRMED"
  | "RUN_CREATED"
  | "RUN_DELETED"
  | "STATE_RESET"
  | "HEARTBEAT"

export type RealtimeEvent = {
  type: RealtimeEventType
  timestamp: number
  runId?: string
  taskKey?: string
  runs?: ProductionRun[]
  pendingActions?: PendingAction[]
  pendingAction?: PendingAction
  confirmed?: boolean
}

// Attach to globalThis to preserve emitter across HMR in Next.js dev server
const GLOBAL_BUS_KEY = "__cueEventBus"

function getEventBus(): EventEmitter {
  const g = globalThis as unknown as { [GLOBAL_BUS_KEY]?: EventEmitter }
  if (!g[GLOBAL_BUS_KEY]) {
    const bus = new EventEmitter()
    bus.setMaxListeners(100)
    g[GLOBAL_BUS_KEY] = bus
  }
  return g[GLOBAL_BUS_KEY]
}

export const cueEventBus = getEventBus()

export function broadcastCueEvent(event: Omit<RealtimeEvent, "timestamp">) {
  const fullEvent: RealtimeEvent = {
    ...event,
    timestamp: Date.now(),
  }
  cueEventBus.emit("cue_update", fullEvent)
}

export function onCueEvent(handler: (event: RealtimeEvent) => void): () => void {
  cueEventBus.on("cue_update", handler)
  return () => {
    cueEventBus.off("cue_update", handler)
  }
}
