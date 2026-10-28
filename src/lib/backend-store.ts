import fs from "node:fs"
import path from "node:path"
import Database from "better-sqlite3"
import { createInitialDemoState, demoProducts } from "./demo-data"
import type { DemoState } from "./demo-data"
import type { PendingAction, ProductionRun } from "./demo-types"
import { validateTransition } from "./workflow"
import { broadcastCueEvent } from "./events"

const STORE_DIR = path.join(process.cwd(), "data")
const STORE_PATH = path.join(STORE_DIR, "cue.sqlite")

let database: Database.Database | null = null
let sqliteDisabled = false

function defaultStore(): DemoState {
  const seeded = createInitialDemoState()
  seeded.user = {
    id: "demo-user",
    name: "Baker Demo",
    email: "demo@cue.local",
    accountType: "demo",
    collection: "users",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  return seeded
}

function getFallbackStore(): DemoState {
  if ((globalThis as any).__cueStore) return (globalThis as any).__cueStore
  const jsonPath = path.join(STORE_DIR, "store.json")
  try {
    if (fs.existsSync(jsonPath)) {
      const data = JSON.parse(fs.readFileSync(jsonPath, "utf8"))
      ;(globalThis as any).__cueStore = data
      return data
    }
  } catch {}
  const seeded = defaultStore()
  ;(globalThis as any).__cueStore = seeded
  return seeded
}

function saveFallbackStore(next: DemoState): DemoState {
  ;(globalThis as any).__cueStore = next
  const jsonPath = path.join(STORE_DIR, "store.json")
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true })
    fs.writeFileSync(jsonPath, JSON.stringify(next, null, 2))
  } catch {}
  return next
}

function ensureDatabase() {
  if (sqliteDisabled) return null
  if (database) return database
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true })
    database = new Database(STORE_PATH)
    database.pragma("journal_mode = WAL")
    database.exec(`
      CREATE TABLE IF NOT EXISTS app_state (
        id TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)
    const row = database
      .prepare("SELECT value FROM app_state WHERE id = 'cue-demo-state-v1'")
      .get() as { value?: string } | undefined
    if (!row) {
      database
        .prepare("INSERT INTO app_state (id, value) VALUES ('cue-demo-state-v1', ?) ")
        .run(JSON.stringify(defaultStore()))
    }
    return database
  } catch {
    sqliteDisabled = true
    return null
  }
}

export function resolveStorePath() {
  return STORE_PATH
}

export function getStore(): DemoState {
  const db = ensureDatabase()
  if (!db) {
    return getFallbackStore()
  }
  try {
    const row = db
      .prepare("SELECT value FROM app_state WHERE id = 'cue-demo-state-v1'")
      .get() as { value?: string } | undefined
    if (!row?.value) {
      const defaultState = defaultStore()
      db.prepare("INSERT INTO app_state (id, value) VALUES ('cue-demo-state-v1', ?) ")
        .run(JSON.stringify(defaultState))
      return defaultState
    }
    return JSON.parse(row.value) as DemoState
  } catch {
    return getFallbackStore()
  }
}

export function saveStore(next: DemoState) {
  const db = ensureDatabase()
  if (!db) {
    return saveFallbackStore(next)
  }
  try {
    db.prepare("UPDATE app_state SET value = ? WHERE id = 'cue-demo-state-v1' ")
      .run(JSON.stringify(next))
    return next
  } catch {
    return saveFallbackStore(next)
  }
}

export function listRuns() {
  return getStore().runs
}

export function getRunById(runId: string) {
  return getStore().runs.find((item) => item.id === runId) ?? null
}

export function getCurrentUser() {
  const store = getStore()
  if (!store.user) {
    const demoUser = defaultStore().user
    if (!demoUser) return null
    store.user = demoUser
    saveStore(store)
  }
  return store.user
}

export function getStatusSummary(run: ProductionRun) {
  return {
    runId: run.runId,
    product: typeof run.product === "object" ? run.product.name : run.product,
    eligibleCount: run.tasks.filter((task) => task.state === "READY").length,
    waitingCount: run.tasks.filter((task) => task.state === "WAITING").length,
    blockedCount: run.tasks.filter((task) => task.state === "BLOCKED").length,
    inspectionCount: run.tasks.filter((task) => task.state === "NEEDS_INSPECTION")
      .length,
    totalTasks: run.tasks.length,
    completionPercent: Math.round(
      (run.tasks.filter((task) => task.state === "COMPLETED").length /
        Math.max(run.tasks.length, 1)) *
        100,
    ),
  }
}

export function proposeTaskUpdate(
  runId: string,
  taskKey: string,
  nextState: ProductionRun["tasks"][number]["state"],
  reason = "",
  actionType: PendingAction["actionType"] = "transition",
) {
  const store = getStore()
  const run = store.runs.find((item) => item.id === runId)
  const task = run?.tasks.find((item) => item.taskKey === taskKey)
  if (!run || !task) {
    return { ok: false as const, error: "That task or run is no longer available." }
  }

  const validation = validateTransition(run, taskKey, nextState)
  if (!validation.ok) return validation
  if (actionType === "correction" && !reason.trim()) {
    return { ok: false as const, error: "A correction requires a reason." }
  }

  const pending = store.pendingActions.find(
    (item) =>
      item.productionRun === run.id &&
      item.taskKey === taskKey &&
      item.status === "PENDING",
  )
  if (pending) {
    return {
      ok: false as const,
      error: "Review or cancel the pending confirmation first.",
    }
  }

  const pendingAction: PendingAction = {
    id: `pending-${crypto.randomUUID()}`,
    owner: store.user?.id ?? "demo-user",
    productionRun: run.id,
    taskKey,
    expectedState: task.state,
    proposedState: nextState,
    actionType,
    reason: reason || undefined,
    status: "PENDING",
    snapshotVersion: run.version,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }

  const nextStore = {
    ...store,
    pendingActions: [...store.pendingActions, pendingAction],
  }
  saveStore(nextStore)
  broadcastCueEvent({
    type: "TASK_PROPOSED",
    runId: run.id,
    taskKey,
    pendingAction,
    runs: nextStore.runs,
    pendingActions: nextStore.pendingActions,
  })
  return { ok: true as const, pendingAction }
}

export function confirmPendingUpdate(id: string, confirm: boolean) {
  const store = getStore()
  const pending = store.pendingActions.find(
    (item) => item.id === id && item.status === "PENDING",
  )
  if (!pending) {
    return { ok: false as const, error: "That proposal is no longer available." }
  }

  const run = store.runs.find((item) => item.id === pending.productionRun)
  const task = run?.tasks.find((item) => item.taskKey === pending.taskKey)
  if (!run || !task) {
    return { ok: false as const, error: "That proposal is no longer available." }
  }

  if (run.version !== pending.snapshotVersion || task.state !== pending.expectedState) {
    const nextStore = {
      ...store,
      pendingActions: store.pendingActions.map((item) =>
        item.id === id ? { ...item, status: "STALE" as const } : item,
      ),
    }
    saveStore(nextStore)
    return {
      ok: false as const,
      error: "The run changed. Review its latest state before trying again.",
    }
  }

  if (!confirm) {
    const nextStore = {
      ...store,
      pendingActions: store.pendingActions.map((item) =>
        item.id === id ? { ...item, status: "CANCELLED" as const } : item,
      ),
    }
    saveStore(nextStore)
    broadcastCueEvent({
      type: "TASK_CONFIRMED",
      runId: run.id,
      taskKey: pending.taskKey,
      confirmed: false,
      runs: nextStore.runs,
      pendingActions: nextStore.pendingActions,
    })
    return { ok: true as const }
  }

  const nextState = pending.proposedState as ProductionRun["tasks"][number]["state"]
  const now = new Date().toISOString()
  const tasks = run.tasks.map((item) =>
    item.taskKey !== task.taskKey
      ? item
      : {
          ...item,
          state: nextState,
          startedAt: nextState === "IN_PROGRESS" ? now : item.startedAt,
          waitingStartedAt:
            nextState === "WAITING" ? now : item.waitingStartedAt,
          completedAt: nextState === "COMPLETED" ? now : undefined,
          readinessConfirmedAt:
            pending.actionType === "inspection" && nextState === "COMPLETED"
              ? now
              : item.readinessConfirmedAt,
          blockedReason: nextState === "BLOCKED" ? pending.reason : undefined,
          qualityStatus:
            pending.actionType === "inspection"
              ? nextState === "COMPLETED"
                ? "PASSED"
                : nextState === "BLOCKED"
                  ? "FAILED"
                  : item.qualityStatus
              : item.qualityStatus,
          qualityIssue:
            pending.actionType === "inspection" && nextState === "BLOCKED"
              ? pending.reason
              : item.qualityIssue,
        },
  )

  const completed = new Set(
    tasks.filter((item) => item.state === "COMPLETED").map((item) => item.taskKey),
  )

  const refreshed = tasks.map((item) => {
    const ready =
      (item.prerequisites ?? []).every((pre) => completed.has(pre.taskKey)) &&
      (item.waitingReason !== "freezing" || Boolean(run.selectedProcess))
    return item.state === "NOT_STARTED" && ready
      ? { ...item, state: "READY" as const }
      : item.state === "READY" && !ready
        ? { ...item, state: "NOT_STARTED" as const }
        : item
  })

  const done = refreshed
    .filter((item) => item.mandatory !== false)
    .every((item) => item.state === "COMPLETED")

  const nextStore = {
    ...store,
    runs: store.runs.map((item) =>
      item.id === run.id
        ? {
            ...item,
            tasks: refreshed,
            version: item.version + 1,
            status: done ? ("COMPLETED" as const) : ("IN_PROGRESS" as const),
            history: [
              ...(item.history ?? []),
              {
                taskKey: task.taskKey,
                fromState: task.state,
                toState: nextState,
                reason: pending.reason,
                actor: store.user?.name ?? "Baker",
                recordedAt: now,
              },
            ],
            updatedAt: now,
          }
        : item,
    ),
    pendingActions: store.pendingActions.map((item) =>
      item.id === id ? { ...item, status: "CONFIRMED" as const } : item,
    ),
  }

  saveStore(nextStore)
  broadcastCueEvent({
    type: "TASK_CONFIRMED",
    runId: run.id,
    taskKey: task.taskKey,
    confirmed: true,
    runs: nextStore.runs,
    pendingActions: nextStore.pendingActions,
  })
  return { ok: true as const }
}

export function getPendingActions() {
  return getStore().pendingActions
}

export function resetStoreToDemo() {
  const seeded = defaultStore()
  saveStore(seeded)
  broadcastCueEvent({
    type: "STATE_RESET",
    runs: seeded.runs,
    pendingActions: seeded.pendingActions,
  })
  return seeded
}

export function createRun(
  productId: string,
  options?: { quantity?: number; runType?: "customer-order" | "planned-production"; owner?: string },
): ProductionRun | null {
  const product = demoProducts.find(
    (item) => item.id === productId || item.slug === productId || item.name.toLowerCase() === productId.toLowerCase(),
  )
  if (!product) return null

  const id = `run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const runCode = `CUE-${id.slice(-6).toUpperCase()}`
  const now = new Date().toISOString()

  const tasks: ProductionRun["tasks"] = product.taskDefinitions.map((definition) => ({
    taskKey: definition.key,
    name: definition.name,
    sequence: definition.sequence,
    category: definition.category,
    prerequisites: definition.prerequisites ?? [],
    allowsParallel: definition.allowsParallel ?? false,
    waitingReason: definition.waitingReason ?? undefined,
    expectedMinutes: definition.expectedMinutes ?? undefined,
    physicalCheckRequired: definition.physicalCheckRequired ?? false,
    mandatory: definition.mandatory ?? true,
    state: definition.sequence === 1 ? ("READY" as const) : ("NOT_STARTED" as const),
  }))

  const store = getStore()
  const newRun: ProductionRun = {
    id,
    owner: options?.owner ?? store.user?.id ?? "baker",
    runId: runCode,
    product,
    runType: options?.runType ?? "planned-production",
    quantity: options?.quantity ?? 12,
    status: "IN_PROGRESS" as const,
    version: 1,
    tasks,
    history: [],
    createdAt: now,
    updatedAt: now,
  }

  const nextStore = {
    ...store,
    runs: [...store.runs, newRun],
  }
  saveStore(nextStore)
  broadcastCueEvent({
    type: "RUN_CREATED",
    runId: newRun.id,
    runs: nextStore.runs,
    pendingActions: nextStore.pendingActions,
  })
  return newRun
}

export function deleteRun(runId: string): boolean {
  const store = getStore()
  const target = store.runs.find(
    (r) => r.id === runId || r.runId.toLowerCase() === runId.toLowerCase(),
  )
  if (!target) return false

  const nextStore = {
    ...store,
    runs: store.runs.filter((r) => r.id !== target.id),
    pendingActions: store.pendingActions.filter((p) => p.productionRun !== target.id),
  }
  saveStore(nextStore)
  broadcastCueEvent({
    type: "RUN_DELETED",
    runId: target.id,
    runs: nextStore.runs,
    pendingActions: nextStore.pendingActions,
  })
  return true
}
