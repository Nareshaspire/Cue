import { getStore } from "@/lib/backend-store"
import { onCueEvent, type RealtimeEvent } from "@/lib/events"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(request: Request) {
  const encoder = new TextEncoder()
  let cleanup: (() => void) | null = null

  const stream = new ReadableStream({
    start(controller) {
      // 1. Send initial connected payload with current store state
      try {
        const store = getStore()
        const initialEvent: RealtimeEvent = {
          type: "CONNECTED",
          timestamp: Date.now(),
          runs: store.runs,
          pendingActions: store.pendingActions,
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(initialEvent)}\n\n`))
      } catch {
        // Fallback gracefully if initial fetch fails
      }

      // 2. Listen to real-time events triggered by REST API mutations or Alexa voice commands
      const unsubscribe = onCueEvent((event) => {
        try {
          const payload = event.runs
            ? event
            : {
                ...event,
                runs: getStore().runs,
                pendingActions: getStore().pendingActions,
              }
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
        } catch {
          // Controller might already be closed
        }
      })

      // 3. Periodic keep-alive heartbeat comment every 15s
      const heartbeatInterval = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: heartbeat\n\n`))
        } catch {
          clearInterval(heartbeatInterval)
        }
      }, 15000)

      cleanup = () => {
        unsubscribe()
        clearInterval(heartbeatInterval)
      }
    },
    cancel() {
      if (cleanup) {
        cleanup()
      }
    },
  })

  request.signal.addEventListener("abort", () => {
    if (cleanup) {
      cleanup()
    }
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform, no-store",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  })
}
