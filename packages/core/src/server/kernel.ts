import type Database from 'better-sqlite3';
import type { Authenticator, ModuleAcl, SpaServerMessage } from '@companion/contracts';
import type { DaemonConfig, Logger } from '@companion/services';
import type { ModuleId, ModuleManifest } from '../manifest.js';
import type { ModuleConfigState } from '../module-config.js';
import { DynamicRouter } from './router.js';
import { RawRouter } from './raw-router.js';
import { ServiceRegistry } from './service-registry.js';
import { ServerBus } from './bus.js';
import { MigrationRunner } from './migration-runner.js';
import { ModuleConfigStore, validatePatch } from './module-config-store.js';
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
  /** Byte-body, self-authenticating routes (webhooks) — the app shell dispatches these. */
  readonly rawRouter: RawRouter;

  private authenticator: Authenticator | null = null;
  /** The shared base — `moduleConfig` is the one per-module member, added by moduleCtx(). */
  private readonly ctx: Omit<ModuleContext, 'moduleConfig'>;
  /** Kernel-owned config storage — direct on the DB (never via the service registry). */
  private readonly moduleConfig: ModuleConfigStore;
  private readonly perModuleCtx = new Map<ModuleId, ModuleContext>();

  constructor(private readonly opts: KernelOptions) {
    this.db = opts.db;
    this.log = opts.log;
    for (const m of opts.modules) this.installed.set(m.manifest.id, m);
    this.migrations = new MigrationRunner(this.db, this.log);
    this.moduleConfig = new ModuleConfigStore(this.db);

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
        install: (id, config) => this.install(id, config),
        enable: (id) => this.enable(id),
        disable: (id) => this.disable(id),
        uninstall: (id) => this.uninstall(id),
        getConfig: (id) => this.getConfig(id),
        setConfig: (id, patch) => this.setConfig(id, patch),
      },
      isEnabled: (id) => this.isEnabled(id),
    };
    this.rawRouter = new RawRouter(this.log);
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

  private rowStmt?: import('better-sqlite3').Statement;
  private row(id: ModuleId): ModuleRow | undefined {
    this.rowStmt ??= this.db.prepare(`SELECT * FROM modules WHERE id = ?`);
    return this.rowStmt.get(id) as ModuleRow | undefined;
  }

  /**
   * The full ModuleContext one module's factories/lifecycle receive: the shared
   * base plus that module's own config accessor. Memoized — every spread field is
   * a stable reference, and the accessor reads the DB live on each call.
   */
  private moduleCtx(id: ModuleId): ModuleContext {
    let c = this.perModuleCtx.get(id);
    if (!c) {
      c = { ...this.ctx, moduleConfig: this.moduleConfig.accessorFor(id, this.configFields(id)) };
      this.perModuleCtx.set(id, c);
    }
    return c;
  }

  private configFields(id: ModuleId) {
    return this.installed.get(id)?.manifest.config ?? [];
  }

  /** Every required config field has a stored value or a declared default. */
  private isConfigured(id: ModuleId, storedKeys?: ReadonlySet<string>): boolean {
    const keys = storedKeys ?? new Set(Object.keys(this.moduleConfig.valuesFor(id)));
    return this.configFields(id).every((f) => !f.required || f.default !== undefined || keys.has(f.key));
  }

  moduleList(): ModuleListing[] {
    // One scan into a map, not a prepared-per-row N+1 (this endpoint is hit at
    // bootstrap and again on every modules.changed by every client).
    const rows = new Map(
      (this.db.prepare(`SELECT * FROM modules`).all() as ModuleRow[]).map((r) => [r.id, r]),
    );
    const cfgKeys = this.moduleConfig.keysByModule();
    return [...this.installed.values()].map((m) => {
      const id = m.manifest.id;
      const row = rows.get(id);
      return {
        id,
        title: m.manifest.title,
        version: m.manifest.version,
        dependsOn: m.manifest.dependsOn ?? [],
        required: !!m.manifest.required,
        installed: row ? row.installed === 1 : false,
        enabled: row ? row.enabled === 1 : false,
        configured: this.isConfigured(id, cfgKeys.get(id) ?? new Set()),
        permissions: m.manifest.permissions ?? [],
        config: m.manifest.config ?? [],
      };
    });
  }

  /** Reconcile the installed set into the `modules` table, then activate the enabled set. */
  async boot(): Promise<void> {
    const now = Date.now();
    for (const m of this.installed.values()) {
      // A newly compiled-in module auto-installs + enables by default; it lands as
      // "Available" (installed=0) instead when its manifest opts out or it has
      // required config with no default (it can't run unconfigured). Required
      // modules always install — an Available required module would brick topoSort.
      // ON CONFLICT preserves an existing row's installed/enabled (only `required`
      // may change across builds), so a disabled or uninstalled module never
      // resurrects and the policy only ever applies to genuinely new module ids.
      const blocking = (m.manifest.config ?? []).some((f) => f.required && f.default === undefined);
      const auto = m.manifest.required ? 1 : m.manifest.autoInstall === false || blocking ? 0 : 1;
      if (m.manifest.required && (m.manifest.autoInstall === false || blocking)) {
        this.log.warn(`required module '${m.manifest.id}' declares autoInstall:false or blocking config — ignored`);
      }
      this.db
        .prepare(
          `INSERT INTO modules (id, installed, enabled, version, required, installed_at, updated_at)
           VALUES (?, ?, ?, 0, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET required = excluded.required, updated_at = excluded.updated_at`,
        )
        .run(m.manifest.id, auto, auto, m.manifest.required ? 1 : 0, now, now);
    }

    // Consistency pass: the enabled set must be dependsOn-closed or topoSort
    // would crash boot. The auto-install policy can break closure — e.g. a new
    // module lands "Available" (autoInstall:false / blocking config) while a
    // dependent auto-installed, or an existing enabled module gained a dep on
    // it across a build. Two ordered passes keep the result deterministic:
    // FORCE first (a required module's whole dependsOn closure comes on — it
    // can never be pruned), then PRUNE the rest to disabled, durably and
    // loudly; a pruned module can be re-enabled once its dependency installs.
    const enabledSet = new Set(this.enabledIds());
    const visited = new Set<ModuleId>();
    const forceClosure = (id: ModuleId): void => {
      if (visited.has(id)) return; // also guards a manifest cycle (topoSort reports it)
      visited.add(id);
      for (const dep of this.installed.get(id)?.manifest.dependsOn ?? []) {
        if (!this.installed.has(dep)) {
          throw new Error(`required module '${id}' depends on '${dep}', which is not in the registry`);
        }
        if (!enabledSet.has(dep)) {
          this.log.warn(`required module '${id}' forces dependency '${dep}' to install`);
          enabledSet.add(dep);
          this.markState(dep, { installed: true, enabled: true });
        }
        forceClosure(dep);
      }
    };
    for (const m of this.installed.values()) if (m.manifest.required) forceClosure(m.manifest.id);
    for (let changed = true; changed; ) {
      changed = false;
      for (const id of [...enabledSet]) {
        for (const dep of this.installed.get(id)!.manifest.dependsOn ?? []) {
          if (enabledSet.has(dep)) continue;
          this.log.warn(`module '${id}' disabled: its dependency '${dep}' is not enabled`);
          enabledSet.delete(id);
          this.markState(id, { enabled: false });
          changed = true;
          break;
        }
      }
    }

    const enabled = this.topoSort([...enabledSet]);
    // Loads are independent (only the activation phases below are ordered), so
    // overlap the dynamic imports instead of paying their sum on cold start.
    const mods = await Promise.all(enabled.map((id) => this.installed.get(id)!.load()));
    enabled.forEach((id, i) => this.loaded.set(id, mods[i]!));

    // Grid must be live before any request is served, so Auth sees the perms.
    this.rebuildGrid(enabled);

    for (const id of enabled) {
      const mod = this.loaded.get(id)!;
      if (mod.migrations?.length) this.migrations.migrateUp(id, mod.migrations);
      this.services.setActiveModule(id);
      await mod.registerServices?.(this.moduleCtx(id));
      this.services.setActiveModule(null);
    }

    // module-core (required, first) provides the authenticator the router uses.
    for (const id of enabled) {
      const mod = this.loaded.get(id)!;
      if (mod.provideAuthenticator) this.authenticator = mod.provideAuthenticator(this.moduleCtx(id));
    }
    if (!this.authenticator) throw new Error('no module provided an authenticator (module-core missing?)');

    for (const id of enabled) {
      const mod = this.loaded.get(id)!;
      if (mod.routes) this.router.mount(id, mod.routes(this.moduleCtx(id)));
      if (mod.rawRoutes) this.rawRouter.mount(id, mod.rawRoutes(this.moduleCtx(id)));
    }
    for (const id of enabled) await this.loaded.get(id)!.lifecycle?.onEnable?.(this.moduleCtx(id));
    // Single post-activation pass: resumers fire only after every module subscribed.
    for (const id of enabled) await this.loaded.get(id)!.lifecycle?.postActivate?.(this.moduleCtx(id));
    for (const id of enabled) this.startJobs(id);
    this.log.info(`kernel booted: ${enabled.length} module(s) enabled [${enabled.join(', ')}]`);
  }

  // ---- lifecycle transitions ----

  /** 409 unless every required config field has a stored value or a default. */
  private assertConfigured(id: ModuleId): void {
    const stored = new Set(Object.keys(this.moduleConfig.valuesFor(id)));
    const missing = this.configFields(id)
      .filter((f) => f.required && f.default === undefined && !stored.has(f.key))
      .map((f) => f.key);
    if (missing.length) {
      throw new HttpError(409, `module '${id}' is missing required configuration: ${missing.join(', ')}`);
    }
  }

  /** The one path from "Available" to running: validate + persist config, then activate. */
  async install(id: ModuleId, config?: Readonly<Record<string, unknown>>): Promise<void> {
    const inst = this.installed.get(id);
    if (!inst) throw new HttpError(404, `unknown module: ${id}`);
    if (config && Object.keys(config).length) this.setConfig(id, config);
    if (this.isEnabled(id)) return; // idempotent — config patch (if any) still applied
    this.assertConfigured(id);
    // Config rows persisted above survive a failed activation (kept for the retry;
    // uninstall wipes them) — but installed=1 is only written on the success path.
    await this.activate(id, { markInstalled: true });
  }

  async enable(id: ModuleId): Promise<void> {
    const inst = this.installed.get(id);
    if (!inst) throw new HttpError(404, `unknown module: ${id}`);
    if (this.isEnabled(id)) return;
    if (this.row(id)?.installed === 0) throw new HttpError(409, `install '${id}' first`);
    this.assertConfigured(id);
    await this.activate(id, { markInstalled: false });
  }

  /** Shared enable/install machinery. Single inFlight take; state flips only on success. */
  private async activate(id: ModuleId, opts: { markInstalled: boolean }): Promise<void> {
    const inst = this.installed.get(id)!;
    if (this.inFlight.has(id)) throw new HttpError(409, `module '${id}' is busy`);
    for (const dep of inst.manifest.dependsOn ?? []) {
      if (!this.isEnabled(dep)) throw new HttpError(409, `enable dependency '${dep}' first`);
    }
    this.inFlight.add(id);
    try {
      const mod = this.loaded.get(id) ?? (await inst.load());
      this.loaded.set(id, mod);
      const ctx = this.moduleCtx(id);
      if (mod.migrations?.length) this.migrations.migrateUp(id, mod.migrations);
      this.services.setActiveModule(id);
      await mod.registerServices?.(ctx);
      this.services.setActiveModule(null);
      if (mod.routes) this.router.mount(id, mod.routes(ctx));
      if (mod.rawRoutes) this.rawRouter.mount(id, mod.rawRoutes(ctx));
      this.markState(id, opts.markInstalled ? { installed: true, enabled: true } : { enabled: true });
      this.rebuildGrid(this.topoSort(this.enabledIds()));
      await mod.lifecycle?.onEnable?.(ctx);
      await mod.lifecycle?.postActivate?.(ctx);
      this.startJobs(id);
      this.opts.broadcast({ t: 'modules.changed' });
    } finally {
      this.services.setActiveModule(null);
      this.inFlight.delete(id);
    }
  }

  // ---- per-module configuration ----

  /** Redacted read: secret values never leave the kernel — only their set/unset state. */
  getConfig(id: ModuleId): ModuleConfigState {
    const inst = this.installed.get(id);
    if (!inst) throw new HttpError(404, `unknown module: ${id}`);
    const stored = this.moduleConfig.valuesFor(id);
    const values: Record<string, string | number | boolean> = {};
    const secrets: Record<string, boolean> = {};
    for (const f of this.configFields(id)) {
      if (f.kind === 'secret') secrets[f.key] = stored[f.key] !== undefined;
      else if (stored[f.key] !== undefined) values[f.key] = stored[f.key]!;
    }
    return { values, secrets };
  }

  /** Validated partial update: omitted key = unchanged, `null` = clear, secrets reject `''`. */
  setConfig(id: ModuleId, patch: Readonly<Record<string, unknown>>): void {
    const inst = this.installed.get(id);
    if (!inst) throw new HttpError(404, `unknown module: ${id}`);
    // A write during an in-flight activation could unset a required key AFTER
    // assertConfigured passed — enabled-but-unconfigured through the API.
    if (this.inFlight.has(id)) throw new HttpError(409, `module '${id}' is busy`);
    const { set, clear } = validatePatch(this.configFields(id), patch);
    // Unsetting a required field of an ENABLED module would drift `configured`
    // apart from "running" through the API — an upgrade is the only sanctioned
    // way to reach that state. Refuse it here.
    if (this.isEnabled(id)) {
      const stillSet = new Set(Object.keys(this.moduleConfig.valuesFor(id)));
      for (const key of clear) stillSet.delete(key);
      for (const key of Object.keys(set)) stillSet.add(key);
      const broken = this.configFields(id)
        .filter((f) => f.required && f.default === undefined && !stillSet.has(f.key))
        .map((f) => f.key);
      if (broken.length) {
        throw new HttpError(409, `cannot unset required configuration of enabled module '${id}': ${broken.join(', ')}`);
      }
    }
    if (Object.keys(set).length) this.moduleConfig.setMany(id, set);
    for (const key of clear) this.moduleConfig.deleteKey(id, key);
    const keys = [...Object.keys(set), ...clear];
    if (!keys.length) return;
    this.bus.emit('module-config.changed', { moduleId: id, keys });
    this.opts.broadcast({ t: 'modules.changed' });
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
      this.rawRouter.unmount(id);
      this.markState(id, { enabled: false });
      this.rebuildGrid(this.topoSort(this.enabledIds()));
      await mod?.lifecycle?.onDisable?.(this.moduleCtx(id));
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
      // Clean slate so a later re-install re-runs migrations from scratch, and the
      // module's paths become 404 (genuinely gone), not 503 (merely disabled). Keep
      // the row as installed=0 so boot's reconcile does NOT re-adopt/resurrect it —
      // it shows under "Available" instead. User-entered config is wiped with it.
      this.migrations.clearLedger(id);
      this.moduleConfig.deleteAll(id);
      this.router.forget(id);
      this.rawRouter.forget(id);
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
        await this.loaded.get(id)?.lifecycle?.onDisable?.(this.moduleCtx(id));
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
          const r = j.run(this.moduleCtx(id));
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
