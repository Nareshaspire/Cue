"use client"

import { useEffect, useState, useSyncExternalStore } from "react"
import type { PendingAction, ProductionRun, User } from "@/lib/demo-types"
import {
  createInitialDemoState,
  demoProducts,
  type DemoState,
} from "./demo-data.ts"
import { validateTransition } from "./workflow.ts"

const STORAGE_KEY = "cue-demo-state-v1"
const CREDENTIALS_KEY = "cue-demo-credentials-v1"
let state = createInitialDemoState()
let hydrated = false
let syncChannel: BroadcastChannel | null = null

if (
  typeof window !== "undefined" &&
  typeof (window as any).document !== "undefined" &&
  typeof BroadcastChannel !== "undefined"
) {
  try {
    syncChannel = new BroadcastChannel("cue_production_sync")
    if ("unref" in syncChannel && typeof (syncChannel as any).unref === "function") {
      ;(syncChannel as any).unref()
    }
  } catch {}
}

const listeners = new Set<() => void>()
const emit = () => listeners.forEach((listener) => listener())
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
const getSnapshot = () => state

function readStored(): DemoState | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY)
    if (!value) return null
    const parsed = JSON.parse(value) as Partial<DemoState>
    if (
      parsed.version !== 1 ||
      !Array.isArray(parsed.runs) ||
      !Array.isArray(parsed.pendingActions)
    )
      return null
    if (
      parsed.user !== null &&
      parsed.user !== undefined &&
      (typeof parsed.user !== "object" ||
        typeof parsed.user.id !== "string" ||
        typeof parsed.user.email !== "string")
    )
      return null
    if (
      !parsed.runs.every(
        (run) =>
          run &&
          typeof run.id === "string" &&
          typeof run.runId === "string" &&
          Array.isArray(run.tasks) &&
          run.product,
      )
    )
      return null
    if (
      !parsed.pendingActions.every(
        (item) =>
          item &&
          typeof item.id === "string" &&
          typeof item.taskKey === "string" &&
          ["PENDING", "CONFIRMED", "CANCELLED", "STALE"].includes(item.status),
      )
    )
      return null
    return {
      version: 1,
      user: parsed.user ?? null,
      runs: parsed.runs,
      pendingActions: parsed.pendingActions,
    }
  } catch {
    return null
  }
}

function persist(next: DemoState) {
  state = next
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // The in-memory demo remains usable when the browser blocks persistence.
  }
  try {
    syncChannel?.postMessage({ type: "SYNC_DEMO_STATE", state: next })
  } catch {}
  emit()
}

export function useDemoState() {
  const value = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const [ready, setReady] = useState(hydrated)
  useEffect(() => {
    hydrateDemoState()
    setReady(true)
  }, [])
  return { state: value, ready }
}

export function hydrateDemoState() {
  if (hydrated) return
  const stored = readStored()
  if (stored) state = stored
  hydrated = true

  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    try {
      window.addEventListener("storage", (e) => {
        if (e.key === STORAGE_KEY) {
          const fresh = readStored()
          if (fresh) {
            state = fresh
            emit()
          }
        }
      })
      syncChannel?.addEventListener("message", (e) => {
        if (e.data?.type === "SYNC_DEMO_STATE" && e.data?.state) {
          state = e.data.state
          emit()
        }
      })
    } catch {}
  }

  emit()
}

export function getDemoState() {
  return state
}
export function saveDemoState(update: (current: DemoState) => DemoState) {
  persist(update(state))
}
export function resetDemoState() {
  hydrated = true
  const user = state.user
  persist({ ...createInitialDemoState(), user })
}
export function signOutDemo() {
  saveDemoState((current) => ({ ...current, user: null }))
}
export function hasActiveDemoUser() {
  return Boolean(state.user)
}

interface Credentials {
  email: string
  password: string
  user: User
}
function credentials(): Credentials[] {
  try {
    const value = window.localStorage.getItem(CREDENTIALS_KEY)
    return value ? JSON.parse(value) as Credentials[] : []
  } catch {
    return []
  }
}
function saveCredentials(value: Credentials[]) {
  try {
    window.localStorage.setItem(CREDENTIALS_KEY, JSON.stringify(value))
  } catch {
    throw new Error(
      "Browser storage is unavailable. The account could not be saved.",
    )
  }
}

export function authenticateDemo(
  emailValue: string,
  password: string,
  name?: string,
) {
  const email = emailValue.trim().toLowerCase()
  const records = credentials()
  if (name !== undefined) {
    if (
      !name.trim() ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      password.length < 8
    )
      return {
        ok: false as const,
        error:
          "Add your name, a valid email, and a password of at least 8 characters.",
      }
    if (records.some((item) => item.email === email))
      return {
        ok: false as const,
        error: "That email already has a demo account.",
      }
    const user: User = {
      id: `user-${crypto.randomUUID()}`,
      name: name.trim(),
      email,
      accountType: "baker",
      collection: "users",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    try {
      saveCredentials([...records, { email, password, user }])
    } catch (error) {
      return { ok: false as const, error: (error as Error).message }
    }
    saveDemoState((current) => ({ ...current, user }))
    return { ok: true as const }
  }
  const found = records.find(
    (item) => item.email === email && item.password === password,
  )
  if (!found)
    return {
      ok: false as const,
      error:
        "Those credentials did not match a CUE demo account on this browser.",
    }
  saveDemoState((current) => ({ ...current, user: found.user }))
  return { ok: true as const }
}

export function startDemoWorkspace() {
  const user: User = {
    id: "demo-user",
    name: "Baker Demo",
    email: "demo@cue.local",
    accountType: "demo",
    collection: "users",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  saveDemoState((current) => ({ ...createInitialDemoState(), user }))
}

export function createRunForProduct(productId: string) {
  const product = demoProducts.find((item) => item.id === productId)
  if (product) {
    const id = `run-${crypto.randomUUID()}`
    const tasks: ProductionRun["tasks"] = product.taskDefinitions.map(
      (definition) => ({
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
        state: definition.sequence === 1 ? "READY" : "NOT_STARTED",
      }),
    )
    saveDemoState((current) => ({
      ...current,
      runs: [
        ...current.runs,
        {
          id,
          owner: current.user?.id ?? "demo-user",
          runId: `CUE-${id.slice(-6).toUpperCase()}`,
          product,
          runType: "planned-production",
          quantity: 12,
          status: "IN_PROGRESS",
          version: 1,
          tasks,
          history: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    }))
  }
}

export function transitionRun(
  runId: string,
  taskKey: string,
  nextState: ProductionRun["tasks"][number]["state"],
  reason = "",
  actionType = "transition",
) {
  const run = state.runs.find((item) => item.id === runId)
  const task = run?.tasks.find((item) => item.taskKey === taskKey)
  if (!run || !task)
    return {
      ok: false as const,
      error: "That task or run is no longer available.",
    }
  const validation = validateTransition(run, taskKey, nextState)
  if (!validation.ok) return validation
  if (actionType === "correction" && !reason.trim())
    return { ok: false as const, error: "A correction requires a reason." }
  const pending: PendingAction | undefined = state.pendingActions.find(
    (item) =>
      item.productionRun === run.id &&
      item.taskKey === taskKey &&
      item.status === "PENDING",
  )
  if (pending)
    return {
      ok: false as const,
      error: "Review or cancel the pending confirmation first.",
    }
  const id = `pending-${crypto.randomUUID()}`
  saveDemoState((current) => ({
    ...current,
    pendingActions: [
      ...current.pendingActions,
      {
        id,
        owner: current.user?.id ?? "demo-user",
        productionRun: run.id,
        taskKey,
        expectedState: task.state,
        proposedState: nextState,
        actionType:
          actionType === "correction"
            ? "correction"
            : actionType === "inspection" ||
                (task.physicalCheckRequired && nextState === "COMPLETED")
              ? "inspection"
              : "transition",
        reason: reason || undefined,
        status: "PENDING",
        snapshotVersion: run.version,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ],
  }))
  return { ok: true as const }
}

export function confirmPending(id: string, confirm: boolean) {
  const pending = state.pendingActions.find(
    (item) => item.id === id && item.status === "PENDING",
  )
  const runId =
    pending &&
    (typeof pending.productionRun === "object"
      ? pending.productionRun.id
      : pending.productionRun)
  const run = state.runs.find((item) => item.id === runId)
  const task = run?.tasks.find((item) => item.taskKey === pending?.taskKey)
  if (!pending || !run || !task)
    return {
      ok: false as const,
      error: "That proposal is no longer available.",
    }
  if (
    run.version !== pending.snapshotVersion ||
    task.state !== pending.expectedState
  ) {
    saveDemoState((current) => ({
      ...current,
      pendingActions: current.pendingActions.map((item) =>
        item.id === id ? { ...item, status: "STALE" } : item,
      ),
    }))
    return {
      ok: false as const,
      error: "The run changed. Review its latest state before trying again.",
    }
  }
  if (!confirm) {
    saveDemoState((current) => ({
      ...current,
      pendingActions: current.pendingActions.map((item) =>
        item.id === id ? { ...item, status: "CANCELLED" } : item,
      ),
    }))
    return { ok: true as const }
  }
  const nextState =
    pending.proposedState as ProductionRun["tasks"][number]["state"]
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
                ? "PASSED" as const
                : nextState === "BLOCKED"
                  ? "FAILED" as const
                  : item.qualityStatus
              : item.qualityStatus,
          qualityIssue:
            pending.actionType === "inspection" && nextState === "BLOCKED"
              ? pending.reason
              : item.qualityIssue,
        },
  )
  const completed = new Set(
    tasks
      .filter((item) => item.state === "COMPLETED")
      .map((item) => item.taskKey),
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
  saveDemoState((current) => ({
    ...current,
    runs: current.runs.map((item) =>
      item.id === run.id
        ? {
            ...item,
            tasks: refreshed,
            version: item.version + 1,
            status: done ? "COMPLETED" : "IN_PROGRESS",
            history: [
              ...(item.history ?? []),
              {
                taskKey: task.taskKey,
                fromState: task.state,
                toState: nextState,
                reason: pending.reason,
                actor: current.user?.name ?? "Baker",
                recordedAt: now,
              },
            ],
            updatedAt: now,
          }
        : item,
    ),
    pendingActions: current.pendingActions.map((item) =>
      item.id === id ? { ...item, status: "CONFIRMED" } : item,
    ),
  }))
  return { ok: true as const }
}
