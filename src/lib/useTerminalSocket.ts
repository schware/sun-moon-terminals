import { useEffect, useRef, useState } from 'react'
import { socketUrl } from './deviceServer'

export type ConnectionState = 'connecting' | 'open' | 'closed' | 'displaced'

/** The Device Server's close code for "another connection took this device id". */
const CLOSE_REPLACED = 4001

/**
 * The terminal's connection to the Device Server.
 *
 * <p>Frames are treated as a nudge and nothing more: `onEvent` fires and
 * the caller re-fetches. That is deliberate — a terminal that was offline
 * for a minute must not end up showing a screen assembled from whichever
 * frames it happened to catch, and reconnecting has to converge on the
 * truth rather than on the backlog.
 *
 * <p>Reconnects with a backoff, because a screen in a shop that gives up
 * after one dropped connection is a screen someone has to walk over and
 * restart.
 */
export function useTerminalSocket(
  deviceId: string,
  storeId: string,
  type: 'POS' | 'KDS' | 'DID',
  onEvent: () => void
): ConnectionState {
  const [state, setState] = useState<ConnectionState>('connecting')
  // In a ref so a re-render with a fresh closure does not tear down the
  // socket; the socket only cares that something wants to be told.
  const handler = useRef(onEvent)
  handler.current = onEvent

  useEffect(() => {
    let socket: WebSocket | null = null
    let retryTimer: number | undefined
    let attempt = 0
    let closedByUs = false

    const connect = () => {
      setState('connecting')
      socket = new WebSocket(socketUrl(deviceId, storeId, type))

      socket.onopen = () => {
        attempt = 0
        setState('open')
        // Whatever happened while this terminal was away is in the list,
        // not in the frames it missed.
        handler.current()
      }

      socket.onmessage = () => handler.current()

      socket.onclose = (event) => {
        if (closedByUs) return

        // Somebody else claimed this device id. Reconnecting would take it
        // back, they would take it again, and the two screens would knock
        // each other offline forever - so this one stops and says so.
        if (event.code === CLOSE_REPLACED) {
          setState('displaced')
          return
        }

        setState('closed')
        // 1s, 2s, 4s… capped at 16s. A wrong device id is refused at the
        // handshake, so retrying flat out would be a tight loop on a 400.
        attempt = Math.min(attempt + 1, 5)
        retryTimer = window.setTimeout(connect, 2 ** (attempt - 1) * 1000)
      }
    }

    connect()

    return () => {
      closedByUs = true
      window.clearTimeout(retryTimer)
      socket?.close()
    }
  }, [deviceId, storeId, type])

  return state
}
