import assert from "node:assert/strict"
import test from "node:test"
import { broadcastCueEvent, onCueEvent } from "../src/lib/events.ts"
import {
  createRun,
  getStore,
  proposeTaskUpdate,
  confirmPendingUpdate,
  deleteRun,
  resetStoreToDemo,
} from "../src/lib/backend-store.ts"

test("broadcastCueEvent emits typed events to subscribers", () => {
  const events = []
  const unsubscribe = onCueEvent((event) => {
    events.push(event)
  })

  broadcastCueEvent({
    type: "HEARTBEAT",
  })

  unsubscribe()

  assert.equal(events.length, 1)
  assert.equal(events[0].type, "HEARTBEAT")
  assert.ok(typeof events[0].timestamp === "number")
})

test("proposing and confirming task updates emits real-time events", () => {
  const run = createRun("product-cheesecake", { quantity: 8 })
  assert.ok(run)
  const readyTask = run.tasks.find((t) => t.state === "READY")
  assert.ok(readyTask)

  const capturedEvents = []
  const unsubscribe = onCueEvent((event) => {
    capturedEvents.push(event)
  })

  // 1. Propose task update
  const proposed = proposeTaskUpdate(
    run.id,
    readyTask.taskKey,
    "IN_PROGRESS",
    "Started for test",
  )

  assert.equal(proposed.ok, true)
  assert.ok(capturedEvents.some((e) => e.type === "TASK_PROPOSED"))

  // 2. Confirm the pending action
  const pending = getStore().pendingActions.find(
    (p) => p.productionRun === run.id && p.taskKey === readyTask.taskKey,
  )
  assert.ok(pending)

  const confirmed = confirmPendingUpdate(pending.id, true)
  assert.equal(confirmed.ok, true)
  assert.ok(capturedEvents.some((e) => e.type === "TASK_CONFIRMED" && e.confirmed === true))

  unsubscribe()
})

test("run creation and deletion emits real-time events", () => {
  const events = []
  const unsubscribe = onCueEvent((event) => {
    events.push(event)
  })

  const newRun = createRun("product-pistachio", { quantity: 6 })
  assert.ok(newRun)
  assert.ok(events.some((e) => e.type === "RUN_CREATED" && e.runId === newRun.id))

  const deleted = deleteRun(newRun.id)
  assert.equal(deleted, true)
  assert.ok(events.some((e) => e.type === "RUN_DELETED" && e.runId === newRun.id))

  unsubscribe()
})
