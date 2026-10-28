import type { PendingAction, ProductionRun } from "@/lib/demo-types"

export type CueApiRunState = {
  ok: boolean
  runs: ProductionRun[]
  user: any
  pendingActions: PendingAction[]
}

export async function fetchRuns(): Promise<CueApiRunState> {
  const response = await fetch("/api/runs/", { cache: "no-store" })
  if (!response.ok) {
    throw new Error("Failed to load runs")
  }
  return response.json() as Promise<CueApiRunState>
}

export async function fetchRunById(runId: string): Promise<{ ok: boolean; run: ProductionRun }> {
  const response = await fetch(`/api/runs/${runId}/`, { cache: "no-store" })
  const json = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(json.error ?? "Failed to load run")
  }
  return json
}

export async function fetchRunStatus(runId: string) {
  const response = await fetch(`/api/runs/${runId}/status/`, { cache: "no-store" })
  const json = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(json.error ?? "Failed to load run status")
  }
  return json
}

export async function createRunApi(productId: string, options?: { quantity?: number; runType?: string }) {
  const response = await fetch("/api/runs/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ productId, ...options }),
  })
  const json = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(json.error ?? "Failed to create run")
  }
  return json as { ok: boolean; run: ProductionRun }
}

export async function deleteRunApi(runId: string) {
  const response = await fetch(`/api/runs/${runId}/`, {
    method: "DELETE",
  })
  const json = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(json.error ?? "Failed to delete run")
  }
  return json
}

export async function proposeTaskUpdate(
  runId: string,
  taskKey: string,
  nextState: string,
  reason = "",
  actionType = "transition",
) {
  const response = await fetch(`/api/runs/${runId}/propose/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ taskKey, nextState, reason, actionType }),
  })
  const json = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(json.error ?? "Failed to propose update")
  }
  return json
}

export async function confirmPendingUpdate(
  runId: string,
  pendingId: string,
  confirm = true,
) {
  const response = await fetch(`/api/runs/${runId}/confirm/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pendingId, confirm }),
  })
  const json = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(json.error ?? "Failed to confirm update")
  }
  return json
}

export function subscribeToRunStream(
  onEvent: (event: any) => void,
  onStatusChange?: (connected: boolean) => void,
): () => void {
  if (typeof window === "undefined" || !("EventSource" in window)) {
    return () => {}
  }

  const es = new EventSource("/api/runs/stream/")

  es.onopen = () => {
    onStatusChange?.(true)
  }

  es.onmessage = (messageEvent) => {
    try {
      const data = JSON.parse(messageEvent.data)
      onEvent(data)
    } catch {
      // Ignore comments / non-JSON messages
    }
  }

  es.onerror = () => {
    onStatusChange?.(false)
  }

  return () => {
    es.close()
    onStatusChange?.(false)
  }
}
