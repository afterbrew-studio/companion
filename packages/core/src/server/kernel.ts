import type Database from 'better-sqlite3';
import type { Authenticator, ModuleAcl, SpaServerMessage } from '@companion/contracts';
import type { DaemonConfig, Logger } from '@companion/services';
import type { ModuleId, ModuleManifest } from '../manifest.js';
import { DynamicRouter } from './router.js';
import { ServiceRegistry } from './service-registry.js';
import { ServerBus } from './bus.js';
import { MigrationRunner } from './migration-runner.js';
import { RbacGrid } from './rbac-grid.js';
import type { NotificationEmitter, SettingsRegistry } from './capabilities.js';
import type { ModuleContext, ModuleListing, ServerModule } from './context.js';
import type { WsScopeRegistry } from './ws-hub.js';
import { HttpError } from './router.js';

/** A compiled-in module: its cheap static manifest + a lazy loader for the heavy /api barrel. */
export interface InstalledModule {
  readonly manifest: ModuleManifest;
  load(): Promise<ServerModule>;
}

export interface KernelOptions {
  readonly db: Database.Database;
  readonly log: Logger;
  readonly config: DaemonConfig;
  readonly modules: readonly InstalledModule[];
  /** Browser push, backed by the app's WebSocket hub. */
  readonly broadcast: (msg: SpaServerMessage) => void;
  readonly pushToUser: (username: string, msg: SpaServerMessage) => void;
  /** The hub's scope-resolver registry (per-message visibility). */
  readonly ws: WsScopeRegistry;
}

interface ModuleRow {
  id: string;
  installed: number;
  enabled: number;
  version: number;
  required: number;
}

/**
 * The runtime host. Replaces the hand-wired `main()` composition root: reconcile
 * the installed set into the `modules` table, topo-sort by `dependsOn`, then for
 * each enabled module load → migrate → register services → mount routes →
 * onEnable, and finally a single post-activation pass (resumers). Toggling is a
 * live operation (routes mount/unmount, the RBAC grid recomputes).
 */
export class ModuleKernel {
  private readonly db: Database.Database;
  private readonly log: Logger;
  private readonly installed = new Map<ModuleId, InstalledModule>();
  private readonly loaded = new Map<ModuleId, ServerModule>();
  private readonly jobTimers = new Map<ModuleId, NodeJS.Timeout[]>();
  /** Modules with an enable/disable/uninstall transition in flight (reentrancy guard). */
  private readonly inFlight = new Set<ModuleId>();

  readonly services = new ServiceRegistry();
  readonly bus = new ServerBus();
  readonly migrations: MigrationRunner;
  readonly rbac = new RbacGrid();
  readonly router: DynamicRouter;

  private authenticator: Authenticator | null = null;
  private readonly ctx: ModuleContext;

  constructor(private readonly opts: KernelOptions) {
    this.db = opts.db;
    this.log = opts.log;
    for (const m of opts.modules) this.installed.set(m.manifest.id, m);
    this.migrations = new MigrationRunner(this.db, this.log);

    // `settings` is provided by module-core, `notifications` by module-workspace —
    // both required, so these resolve for the whole normal lifetime. If a target
    // is somehow absent (a boot-order bug), fail LOUDLY rather than silently drop.
    const notify: NotificationEmitter = {
      emit: (n) => {
        const svc = this.services.raw('notifications') as NotificationEmitter | undefined;
        if (!svc) return void this.log.error('ctx.notify.emit before the notifications service registered', { n });
        svc.emit(n);
      },
    };
    const settingsSvc = (): SettingsRegistry | undefined => {
      const svc = this.services.raw('settings') as SettingsRegistry | undefined;
      if (!svc) this.log.error('ctx.settings used before the settings service registered');
      return svc;
    };
    const settings: SettingsRegistry = {
      get: (k) => settingsSvc()?.get(k) ?? null,
      set: (k, v) => settingsSvc()?.set(k, v),
      delete: (k) => settingsSvc()?.delete(k),
    };
    this.ctx = {
      db: this.db,
      log: this.log,
      config: opts.config,
      fts: this.migrations.fts,
      services: this.services,
      bus: this.bus,
      broadcast: opts.broadcast,
      pushToUser: opts.pushToUser,
      notify,
      settings,
      rbac: this.rbac,
      ws: opts.ws,
      modules: {
        list: () => this.moduleList(),
        enable: (id) => this.enable(id),
        disable: (id) => this.disable(id),
        uninstall: (id) => this.uninstall(id),
      },
      isEnabled: (id) => this.isEnabled(id),
    };
    // The router needs an authenticator, wired once module-core provides it (boot()).
    this.router = new DynamicRouter(
      {
        verify: (token) => this.requireAuth().verify(token),
        require: (user, permission) => this.requireAuth().require(user, permission),
      },
      this.log,
    );
  }

  private requireAuth(): Authenticator {
    if (!this.authenticator) throw new HttpError(503, 'kernel not ready');
    return this.authenticator;
  }

  /** Token → user for the WS hub's upgrade path; null before boot completes. */
  verifyToken(token: string | null): ReturnType<Authenticator['verify']> {
    return this.authenticator?.verify(token) ?? null;
  }

  isEnabled(id: ModuleId): boolean {
    const row = this.row(id);
    return !!row && row.enabled === 1;
  }

  private row(id: ModuleId): ModuleRow | undefined {
    return this.db.prepare(`SELECT * FROM modules WHERE id = ?`).get(id) as ModuleRow | undefined;
  }

  moduleList(): ModuleListing[] {
    return [...this.installed.values()]
      .filter((m) => this.row(m.manifest.id)?.installed !== 0)
      .map((m) => {
      const row = this.row(m.manifest.id);
      return {
        id: m.manifest.id,
        title: m.manifest.title,
        version: m.manifest.version,
        dependsOn: m.manifest.dependsOn ?? [],
        required: !!m.manifest.required,
        enabled: row ? row.enabled === 1 : false,
        permissions: m.manifest.permissions ?? [],
      };
    });
  }

  /** Reconcile the installed set into the `modules` table, then activate the enabled set. */
  async boot(): Promise<void> {
    const now = Date.now();
    for (const m of this.installed.values()) {
      // A newly compiled-in module is installed + enabled by default; ON CONFLICT
      // preserves an existing row's installed/enabled (only `required` may change
      // across builds), so a disabled or uninstalled module never resurrects.
      this.db
        .prepare(
          `INSERT INTO modules (id, installed, enabled, version, required, installed_at, updated_at)
           VALUES (?, 1, 1, 0, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET required = excluded.required, updated_at = excluded.updated_at`,
        )
        .run(m.manifest.id, m.manifest.required ? 1 : 0, now, now);
    }

    const enabled = this.topoSort(this.enabledIds());
    for (const id of enabled) this.loaded.set(id, await this.installed.get(id)!.load());

    // Grid must be live before any request is served, so Auth sees the perms.
    this.rebuildGrid(enabled);

    for (const id of enabled) {
      const mod = this.loaded.get(id)!;
      if (mod.migrations?.length) this.migrations.migrateUp(id, mod.migrations);
      this.services.setActiveModule(id);
      await mod.registerServices?.(this.ctx);
      this.services.setActiveModule(null);
    }

    // module-core (required, first) provides the authenticator the router uses.
    for (const id of enabled) {
      const mod = this.loaded.get(id)!;
      if (mod.provideAuthenticator) this.authenticator = mod.provideAuthenticator(this.ctx);
    }
    if (!this.authenticator) throw new Error('no module provided an authenticator (module-core missing?)');

    for (const id of enabled) {
      const mod = this.loaded.get(id)!;
      if (mod.routes) this.router.mount(id, mod.routes(this.ctx));
    }
    for (const id of enabled) await this.loaded.get(id)!.lifecycle?.onEnable?.(this.ctx);
    // Single post-activation pass: resumers fire only after every module subscribed.
    for (const id of enabled) await this.loaded.get(id)!.lifecycle?.postActivate?.(this.ctx);
    for (const id of enabled) this.startJobs(id);
    this.log.info(`kernel booted: ${enabled.length} module(s) enabled [${enabled.join(', ')}]`);
  }

  // ---- lifecycle transitions ----

  async enable(id: ModuleId): Promise<void> {
    const inst = this.installed.get(id);
    if (!inst) throw new HttpError(404, `unknown module: ${id}`);
    if (this.isEnabled(id)) return;
    if (this.inFlight.has(id)) throw new HttpError(409, `module '${id}' is busy`);
    for (const dep of inst.manifest.dependsOn ?? []) {
      if (!this.isEnabled(dep)) throw new HttpError(409, `enable dependency '${dep}' first`);
    }
    this.inFlight.add(id);
    try {
      const mod = this.loaded.get(id) ?? (await inst.load());
      this.loaded.set(id, mod);
      if (mod.migrations?.length) this.migrations.migrateUp(id, mod.migrations);
      this.services.setActiveModule(id);
      await mod.registerServices?.(this.ctx);
      this.services.setActiveModule(null);
      if (mod.routes) this.router.mount(id, mod.routes(this.ctx));
      // enable doubles as (re-)install: a module enabled after uninstall is now installed again.
      this.markState(id, { installed: true, enabled: true });
      this.rebuildGrid(this.topoSort(this.enabledIds()));
      await mod.lifecycle?.onEnable?.(this.ctx);
      await mod.lifecycle?.postActivate?.(this.ctx);
      this.startJobs(id);
      this.opts.broadcast({ t: 'modules.changed' });
    } finally {
      this.services.setActiveModule(null);
      this.inFlight.delete(id);
    }
  }

  async disable(id: ModuleId): Promise<void> {
    const inst = this.installed.get(id);
    if (!inst) throw new HttpError(404, `unknown module: ${id}`);
    if (inst.manifest.required) throw new HttpError(403, `module '${id}' is required`);
    if (!this.isEnabled(id)) return;
    if (this.inFlight.has(id)) throw new HttpError(409, `module '${id}' is busy`);
    const dependents = [...this.installed.values()].filter(
      (m) => this.isEnabled(m.manifest.id) && (m.manifest.dependsOn ?? []).includes(id),
    );
    if (dependents.length) {
      throw new HttpError(409, `disable dependents first: ${dependents.map((d) => d.manifest.id).join(', ')}`);
    }
    this.inFlight.add(id);
    try {
      const mod = this.loaded.get(id);
      this.stopJobs(id);
      // Stop serving BEFORE teardown: the module's paths answer 503 immediately,
      // so a request can't reach a half-shut-down service during a long onDisable
      // (e.g. operate awaiting orchestrator.shutdown()).
      this.router.unmount(id);
      this.markState(id, { enabled: false });
      this.rebuildGrid(this.topoSort(this.enabledIds()));
      await mod?.lifecycle?.onDisable?.(this.ctx);
      this.services.revokeModule(id);
      this.opts.broadcast({ t: 'modules.changed' });
    } finally {
      this.inFlight.delete(id);
    }
  }

  async uninstall(id: ModuleId): Promise<void> {
    const inst = this.installed.get(id);
    if (!inst) throw new HttpError(404, `unknown module: ${id}`);
    if (this.isEnabled(id)) throw new HttpError(409, `disable '${id}' before uninstalling`);
    if (this.inFlight.has(id)) throw new HttpError(409, `module '${id}' is busy`);
    this.inFlight.add(id);
    try {
      const mod = this.loaded.get(id) ?? (await inst.load());
      try {
        if (mod.migrations?.length) this.migrations.migrateDown(id, mod.migrations, 0);
      } catch {
        if (mod.purge) mod.purge(this.db);
        else throw new HttpError(409, `module '${id}' is irreversible and defines no purge()`);
      }
      // Clean slate so a later re-enable re-runs migrations from scratch, and the
      // module's paths become 404 (genuinely gone), not 503 (merely disabled). Keep
      // the row as installed=0 so boot's reconcile does NOT re-adopt/resurrect it.
      this.migrations.clearLedger(id);
      this.router.forget(id);
      this.markState(id, { installed: false, enabled: false, version: 0 });
      this.opts.broadcast({ t: 'modules.changed' });
    } finally {
      this.inFlight.delete(id);
    }
  }

  /**
   * Graceful process shutdown: stop jobs + run onDisable for every enabled
   * module in REVERSE topo order (dependents wind down before their
   * dependencies), WITHOUT flipping enabled flags — state stays durable for the
   * next boot. The app closes the DB afterwards.
   */
  async shutdown(): Promise<void> {
    const order = this.topoSort(this.enabledIds()).reverse();
    for (const id of order) {
      this.stopJobs(id);
      try {
        await this.loaded.get(id)?.lifecycle?.onDisable?.(this.ctx);
      } catch (err) {
        this.log.warn(`module '${id}' onDisable failed during shutdown`, { err: String(err) });
      }
    }
  }

  // ---- internals ----

  private enabledIds(): ModuleId[] {
    const rows = this.db.prepare(`SELECT id FROM modules WHERE enabled = 1`).all() as { id: string }[];
    return rows
      .map((r) => r.id)
      .filter((id) => {
        if (this.installed.has(id)) return true;
        // A stale row for a module no longer compiled into this build — skip it
        // (loading it would crash boot) rather than dereference undefined.
        this.log.warn(`enabled module '${id}' is not in the compiled registry — skipping`);
        return false;
      });
  }

  /** Partial UPDATE of a module row's durable state. */
  private markState(id: ModuleId, s: { installed?: boolean; enabled?: boolean; version?: number }): void {
    const sets = ['updated_at = @now'];
    const args: Record<string, number | string> = { id, now: Date.now() };
    if (s.installed !== undefined) {
      sets.push('installed = @installed');
      args.installed = s.installed ? 1 : 0;
    }
    if (s.enabled !== undefined) {
      sets.push('enabled = @enabled');
      args.enabled = s.enabled ? 1 : 0;
    }
    if (s.version !== undefined) {
      sets.push('version = @version');
      args.version = s.version;
    }
    this.db.prepare(`UPDATE modules SET ${sets.join(', ')} WHERE id = @id`).run(args);
  }

  private rebuildGrid(enabled: readonly ModuleId[]): void {
    const acls: ModuleAcl[] = [];
    for (const id of enabled) {
      const acl = this.loaded.get(id)?.acl;
      if (acl) acls.push(acl);
    }
    this.rbac.rebuild(acls);
  }

  private startJobs(id: ModuleId): void {
    const jobs = this.loaded.get(id)?.lifecycle?.jobs ?? [];
    const timers = jobs.map((j) => {
      const t = setInterval(() => {
        try {
          const r = j.run(this.ctx);
          if (r instanceof Promise) r.catch((err) => this.log.error(`job '${j.id}' failed`, err));
        } catch (err) {
          this.log.error(`job '${j.id}' failed`, err);
        }
      }, j.everyMs);
      t.unref?.();
      return t;
    });
    if (timers.length) this.jobTimers.set(id, timers);
  }

  private stopJobs(id: ModuleId): void {
    for (const t of this.jobTimers.get(id) ?? []) clearInterval(t);
    this.jobTimers.delete(id);
  }

  /** Kahn topological sort over `dependsOn`; throws on a cycle or a missing/disabled required dep. */
  private topoSort(ids: readonly ModuleId[]): ModuleId[] {
    const set = new Set(ids);
    // Every REQUIRED installed module must be in the enabled set (this iterates
    // the registry, not `ids`, so a disabled required module is actually caught).
    for (const inst of this.installed.values()) {
      if (inst.manifest.required && !set.has(inst.manifest.id)) {
        throw new Error(`required module '${inst.manifest.id}' is disabled`);
      }
    }
    for (const id of ids) {
      for (const dep of this.installed.get(id)?.manifest.dependsOn ?? []) {
        if (!set.has(dep)) throw new Error(`module '${id}' depends on disabled/missing '${dep}'`);
      }
    }
    const order: ModuleId[] = [];
    const visited = new Map<ModuleId, 0 | 1>(); // 0 = visiting, 1 = done
    const visit = (id: ModuleId): void => {
      const state = visited.get(id);
      if (state === 1) return;
      if (state === 0) throw new Error(`dependency cycle at module '${id}'`);
      visited.set(id, 0);
      for (const dep of this.installed.get(id)?.manifest.dependsOn ?? []) {
        if (set.has(dep)) visit(dep);
      }
      visited.set(id, 1);
      order.push(id);
    };
    for (const id of ids) visit(id);
    return order;
  }
}
