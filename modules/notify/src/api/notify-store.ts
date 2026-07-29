import type { Database } from 'better-sqlite3';
import { safeParse } from '@moxxy/companion-sdk/server';
import type { NotificationKind } from '@companion/module-workspace/contract';
import type {
  NotifyChannelKind,
  NotifyChannelRecord,
  NotifyDeliveryRecord,
  NotifyDeliveryStatus,
} from '../contract/index.js';
import { redactTarget } from './delivery.js';

interface ChannelRow {
  id: string;
  workspace_id: string | null;
  user_id: string | null;
  kind: string;
  name: string;
  url: string;
  secret: string | null;
  kinds: string;
  enabled: number;
  last_status: string | null;
  last_error: string | null;
  last_attempt_at: number | null;
  created_at: number;
  updated_at: number;
}

interface DeliveryRow {
  id: string;
  channel_id: string;
  channel_name: string;
  title: string;
  status: string;
  http_status: number | null;
  error: string | null;
  attempts: number;
  created_at: number;
}

/** The full row, including the credential. Never leaves the daemon. */
export interface ChannelTarget {
  readonly id: string;
  readonly workspaceId: string | null;
  readonly userId: string | null;
  readonly kind: NotifyChannelKind;
  readonly name: string;
  readonly url: string;
  readonly secret: string | null;
  readonly kinds: ReadonlyArray<NotificationKind>;
  readonly enabled: boolean;
}

function rowToChannel(row: ChannelRow): NotifyChannelRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    kind: row.kind as NotifyChannelKind,
    name: row.name,
    targetHint: redactTarget(row.url),
    enabled: !!row.enabled,
    kinds: safeParse<NotificationKind[]>(row.kinds, []),
    signed: row.secret !== null && row.secret !== '',
    lastStatus: row.last_status as NotifyDeliveryStatus | null,
    lastError: row.last_error,
    lastAttemptAt: row.last_attempt_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToTarget(row: ChannelRow): ChannelTarget {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    kind: row.kind as NotifyChannelKind,
    name: row.name,
    url: row.url,
    secret: row.secret,
    kinds: safeParse<NotificationKind[]>(row.kinds, []),
    enabled: !!row.enabled,
  };
}

function rowToDelivery(row: DeliveryRow): NotifyDeliveryRecord {
  return {
    id: row.id,
    channelId: row.channel_id,
    channelName: row.channel_name,
    title: row.title,
    status: row.status as NotifyDeliveryStatus,
    httpStatus: row.http_status,
    error: row.error,
    attempts: row.attempts,
    createdAt: row.created_at,
  };
}

/** Delivery attempts older than this are swept on insert. */
const DELIVERY_RETENTION_MS = 14 * 24 * 60 * 60_000;

/** Owner of the notify_channels / notify_deliveries tables. */
export class NotifyStore {
  constructor(private readonly db: Database) {}

  // ---------- channels --------------------------------------------------------------

  insert(channel: ChannelTarget & { createdAt: number; updatedAt: number }): void {
    this.db
      .prepare(
        `INSERT INTO notify_channels (id, workspace_id, user_id, kind, name, url, secret, kinds, enabled, created_at, updated_at)
         VALUES (@id, @workspaceId, @userId, @kind, @name, @url, @secret, @kinds, @enabled, @createdAt, @updatedAt)`,
      )
      .run({
        id: channel.id,
        workspaceId: channel.workspaceId,
        userId: channel.userId,
        kind: channel.kind,
        name: channel.name,
        url: channel.url,
        secret: channel.secret,
        kinds: JSON.stringify(channel.kinds),
        enabled: channel.enabled ? 1 : 0,
        createdAt: channel.createdAt,
        updatedAt: channel.updatedAt,
      });
  }

  /**
   * Patch a channel. `url` and `secret` are only written when supplied, so an
   * edit that does not retype the credential keeps it rather than blanking it.
   */
  update(
    id: string,
    fields: {
      name?: string;
      url?: string;
      secret?: string | null;
      kinds?: ReadonlyArray<NotificationKind>;
      enabled?: boolean;
      workspaceId?: string | null;
    },
  ): void {
    const existing = this.getRow(id);
    if (!existing) return;
    this.db
      .prepare(
        `UPDATE notify_channels SET name = ?, url = ?, secret = ?, kinds = ?, enabled = ?, workspace_id = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        fields.name ?? existing.name,
        fields.url ?? existing.url,
        fields.secret === undefined ? existing.secret : fields.secret,
        JSON.stringify(fields.kinds ?? safeParse<NotificationKind[]>(existing.kinds, [])),
        (fields.enabled ?? !!existing.enabled) ? 1 : 0,
        fields.workspaceId === undefined ? existing.workspace_id : fields.workspaceId,
        Date.now(),
        id,
      );
  }

  delete(id: string): boolean {
    return this.db.prepare(`DELETE FROM notify_channels WHERE id = ?`).run(id).changes > 0;
  }

  private getRow(id: string): ChannelRow | undefined {
    return this.db.prepare(`SELECT * FROM notify_channels WHERE id = ?`).get(id) as ChannelRow | undefined;
  }

  get(id: string): NotifyChannelRecord | undefined {
    const row = this.getRow(id);
    return row ? rowToChannel(row) : undefined;
  }

  /** The full row including the credential, for delivery only, never a route. */
  target(id: string): ChannelTarget | undefined {
    const row = this.getRow(id);
    return row ? rowToTarget(row) : undefined;
  }

  list(): NotifyChannelRecord[] {
    const rows = this.db.prepare(`SELECT * FROM notify_channels ORDER BY created_at`).all() as ChannelRow[];
    return rows.map(rowToChannel);
  }

  /**
   * Enabled channels a notification in this workspace should reach: the
   * workspace's own plus the instance-wide ones (workspace_id IS NULL). An
   * instance-wide notification reaches only the instance-wide channels, because
   * routing it into one team's Slack would be a surprise.
   */
  targetsFor(workspaceId: string | null, userId: string | null): ChannelTarget[] {
    // Recipient matching is 1:1 and deliberately not a superset relation. A
    // shared channel carries workspace-wide events only; a personal one carries
    // only what names its owner. Letting either take both would make every
    // personal destination a firehose of everyone's work, which is the exact
    // thing per-recipient routing exists to prevent.
    const owner = userId === null ? 'user_id IS NULL' : 'user_id = ?';
    const scope = workspaceId === null ? 'workspace_id IS NULL' : '(workspace_id IS NULL OR workspace_id = ?)';
    const params: string[] = [];
    if (userId !== null) params.push(userId);
    if (workspaceId !== null) params.push(workspaceId);
    const rows = this.db
      .prepare(`SELECT * FROM notify_channels WHERE enabled = 1 AND ${owner} AND ${scope}`)
      .all(...params) as ChannelRow[];
    return rows.map(rowToTarget);
  }

  recordAttempt(id: string, status: NotifyDeliveryStatus, error: string | null): void {
    this.db
      .prepare(`UPDATE notify_channels SET last_status = ?, last_error = ?, last_attempt_at = ? WHERE id = ?`)
      .run(status, error, Date.now(), id);
  }

  // ---------- delivery log ----------------------------------------------------------

  logDelivery(entry: NotifyDeliveryRecord): void {
    this.db
      .prepare(
        `INSERT INTO notify_deliveries (id, channel_id, channel_name, title, status, http_status, error, attempts, created_at)
         VALUES (@id, @channelId, @channelName, @title, @status, @httpStatus, @error, @attempts, @createdAt)`,
      )
      .run(entry);
    this.db.prepare(`DELETE FROM notify_deliveries WHERE created_at < ?`).run(Date.now() - DELIVERY_RETENTION_MS);
  }

  deliveries(limit = 100): NotifyDeliveryRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM notify_deliveries ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as DeliveryRow[];
    return rows.map(rowToDelivery);
  }
}
