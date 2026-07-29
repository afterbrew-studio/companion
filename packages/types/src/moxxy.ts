/**
 * moxxy's wire format, and nothing else.
 *
 * moxxy is an EXTERNAL runtime: Companion never imports `@moxxy/*` packages.
 * These types mirror the JSON-RPC frames moxxy's gateway (`moxxy mobile
 * --standalone`) puts on the socket, and the subprotocol that authenticates it.
 * What travels INSIDE those frames is agent-agnostic and lives in `harness.js`.
 *
 * Mirrored from (reference only):
 *   - packages/runner/src/jsonrpc.ts        (frame shapes)
 *   - packages/desktop-ipc-contract/src/    (event channels)
 */

import type { HarnessEvent, HarnessEventBase, HarnessEventType } from './harness.js';

// ---------- JSON-RPC frames (the whole wire format) -------------------------

export interface RpcRequestFrame {
  readonly id: number;
  readonly method: string;
  readonly params?: unknown;
}

export interface RpcResponseFrame {
  readonly id: number;
  readonly result?: unknown;
  readonly error?: { readonly message: string; readonly data?: unknown };
}

export interface RpcNotificationFrame {
  readonly method: string;
  readonly params?: unknown;
}

/** Subprotocols the gateway expects on `Sec-WebSocket-Protocol`. */
export const MOXXY_WS_SUBPROTOCOL = 'moxxy.v1';
export const MOXXY_WS_BEARER_PREFIX = 'moxxy.bearer.';

/** Gateway event notification channels Companion subscribes to. */
export type GatewayEventChannel =
  | 'runner.event'
  | 'runner.turn.started'
  | 'runner.turn.complete'
  | 'connection.changed'
  | 'ask.request'
  | 'ask.resolved';

// ---------- compatibility aliases -------------------------------------------

/**
 * The transcript vocabulary moved to `harness.js` when it stopped being moxxy's
 * alone. These keep the old names resolving so the importing files can move
 * under typecheck instead of by hand.
 */
export type MoxxyEventType = HarnessEventType;
export type MoxxyEventBase = HarnessEventBase;
export type MoxxyEvent = HarnessEvent;
