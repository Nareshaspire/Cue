"use client"

import Link from "next/link"
import { useEffect, useState } from "react"
import type { PendingAction, ProductionRun } from "@/lib/demo-types"
import { demoProducts } from "@/lib/demo-data"
import {
  confirmPending,
  createRunForProduct,
  resetDemoState,
  signOutDemo,
  useDemoState,
} from "@/lib/demo-storage"
import {
  fetchRuns,
  confirmPendingUpdate,
  createRunApi,
  subscribeToRunStream,
} from "@/lib/cue-api"
import DashboardClient from "./DashboardClient"

export default function AppPage() {
  const { state: localData } = useDemoState()
  const [runs, setRuns] = useState<ProductionRun[]>([])
  const [pendingActions, setPendingActions] = useState<PendingAction[]>([])
  const [message, setMessage] = useState("")
  const [userName, setUserName] = useState("Lead Baker")
  const [isLiveConnected, setIsLiveConnected] = useState(false)

  const loadData = async () => {
    try {
      const payload = await fetchRuns()
      if (payload?.runs?.length) {
        setRuns(payload.runs)
      }
      if (Array.isArray(payload?.pendingActions)) {
        setPendingActions(payload.pendingActions)
      }
      if (payload?.user?.name) {
        setUserName(payload.user.name)
      }
    } catch {
      // Graceful fallback to local demo state
    }
  }

  useEffect(() => {
    void loadData()

    // Real-time server stream subscription
    const unsubscribe = subscribeToRunStream(
      (event) => {
        if (Array.isArray(event.runs) && event.runs.length) {
          setRuns(event.runs)
        }
        if (Array.isArray(event.pendingActions)) {
          setPendingActions(event.pendingActions)
        }
        if (event.type === "TASK_CONFIRMED") {
          setMessage(
            event.confirmed
              ? "Task update confirmed in real time."
              : "Proposed update cancelled.",
          )
        } else if (event.type === "TASK_PROPOSED") {
          setMessage("New task transition proposed for review.")
        }
      },
      (connected) => {
        setIsLiveConnected(connected)
      },
    )

    return () => {
      unsubscribe()
    }
  }, [])

  // Use server runs/pending if available, otherwise fallback to local demo-storage
  const currentRuns: ProductionRun[] = runs.length
    ? runs
    : (localData.runs as ProductionRun[])

  // Merge pending actions: local pending actions take priority if present
  const localPending = localData.pendingActions.find(
    (item) => item.status === "PENDING",
  ) as PendingAction | undefined
  const serverPending = pendingActions.find((item) => item.status === "PENDING")
  const pending = localPending ?? serverPending

  const pendingRunId =
    pending &&
    (typeof pending.productionRun === "object"
      ? pending.productionRun.id
      : pending.productionRun)
  const run = currentRuns.find((item) => item.id === pendingRunId)
  const task = run?.tasks.find((item) => item.taskKey === pending?.taskKey)
  const product = run && typeof run.product === "object" ? run.product : undefined

  async function resolve(confirmed: boolean) {
    if (!pending) return
    // 1. Immediately update local demo storage so UI and Alexa react in real-time
    const localResult = confirmPending(pending.id, confirmed)
    setMessage(
      localResult.ok
        ? confirmed
          ? `Update confirmed: ${task?.name ?? "task"}.`
          : "Update cancelled. No production task changed."
        : localResult.error,
    )

    // 2. Sync with backend API if run is available
    if (run) {
      try {
        await confirmPendingUpdate(run.id, pending.id, confirmed)
        await loadData()
      } catch {
        // Backend sync is best-effort; local state is already updated
      }
    }
  }

  const allPending = localPending
    ? [localPending]
    : pendingActions.filter((item) => item.status === "PENDING")

  return (
    <main className="app-page">
      <header className="app-header">
        <Link href="/" className="app-logo">
          <img src="/cue/logo.png" alt="CUE" />
        </Link>
        <div className="app-user">
          <span>
            <strong>{localData.user?.name ?? userName}</strong>
            <small>Production workspace</small>
          </span>
          <button
            className="button button--secondary"
            onClick={() => {
              signOutDemo()
              window.location.assign("/")
            }}
          >
            Sign out
          </button>
        </div>
      </header>
      <div className="app-shell">
        <div className="app-title">
          <div>
            <div className="eyebrow-row">
              <p className="eyebrow">Production board · Connected & responsive</p>
              <span
                className={`live-sync-badge ${
                  isLiveConnected ? "is-live" : "is-connecting"
                }`}
                title={
                  isLiveConnected
                    ? "Real-time kitchen stream connected via SSE"
                    : "Connecting to real-time production stream..."
                }
              >
                <span className="live-pulse-dot" />
                {isLiveConnected ? "Live Kitchen Stream" : "Connecting..."}
              </span>
            </div>
            <h1>Good work starts with a clear next step.</h1>
            <p>Updates are validated in real time before they are applied.</p>
          </div>
          <div className="pending-count">
            <strong>{allPending.length}</strong>
            <span>awaiting confirmation</span>
          </div>
        </div>

        {message && (
          <p
            className={
              message.startsWith("Update confirmed")
                ? "operation-banner operation-banner--success"
                : "form-alert"
            }
            role="status"
          >
            {message}
          </p>
        )}

        {pending && run && (
          <section
            className="confirmation-panel"
            aria-labelledby="confirm-title"
          >
            <div>
              <p className="card-kicker">Review before changing the run</p>
              <h2 id="confirm-title">Confirm this task update?</h2>
              <dl className="confirmation-summary">
                <div>
                  <dt>Production run</dt>
                  <dd>{run.runId}</dd>
                </div>
                <div>
                  <dt>Product</dt>
                  <dd>{product?.name ?? "Unavailable"}</dd>
                </div>
                <div>
                  <dt>Task</dt>
                  <dd>{task?.name ?? pending.taskKey}</dd>
                </div>
                <div>
                  <dt>Proposed state</dt>
                  <dd>
                    {pending.proposedState.replaceAll("_", " ").toLowerCase()}
                  </dd>
                </div>
              </dl>
              {pending.actionType === "inspection" && (
                <p className="inspection-question">
                  Have you physically verified the required condition for this
                  task?
                </p>
              )}
            </div>
            <div className="confirmation-actions">
              <button
                className="button button--secondary"
                onClick={() => void resolve(false)}
              >
                Cancel
              </button>
              <button
                className="button button--primary"
                onClick={() => void resolve(true)}
              >
                {pending.actionType === "inspection"
                  ? "Confirm After Inspection"
                  : "Confirm Update"}
              </button>
            </div>
          </section>
        )}

        {currentRuns.length ? (
          <DashboardClient
            runs={currentRuns}
            pendingActions={allPending}
            onRefresh={loadData}
          />
        ) : (
          <section className="empty-board">
            <span className="cue-avatar">C</span>
            <h2>Your production board is ready.</h2>
            <p>Choose a product to create your first independent run.</p>
            <div>
              {demoProducts.map((item) => (
                <button
                  className="button button--primary"
                  key={item.id}
                  onClick={async () => {
                    createRunForProduct(item.id)
                    try {
                      await createRunApi(item.id)
                      await loadData()
                    } catch {}
                    setMessage(`Started production run for ${item.name}.`)
                  }}
                >
                  Start {item.name}
                </button>
              ))}
            </div>
          </section>
        )}

        <div className="app-footer-actions">
          <button
            className="button button--secondary"
            onClick={async () => {
              if (
                window.confirm("Restore production batches to baseline?")
              ) {
                resetDemoState()
                setMessage("Production batches restored to baseline.")
                await loadData()
              }
            }}
          >
            Restore production baseline
          </button>
        </div>
      </div>
    </main>
  )
}
