/**
 * An MCP server this run may reach.
 *
 * Resolved by the daemon exactly as `ResolvedModelSpec` is: which servers a run
 * gets is policy (the record's access list and workspace scope), and policy
 * belongs where the records are. What arrives here is the already-filtered list,
 * so the runtime carries no notion of who was allowed to attach what and cannot
 * widen its own reach by misreading a rule.
 *
 * The values inside can be credentials (a bearer header, a token in `env`), so
 * this travels to a remote runner under the same https-only rule the model spec
 * does.
 */

export type McpTransport =
  | {
      readonly kind: 'stdio';
      /** Executed directly, never through a shell: this is operator configuration, but it still never becomes a command line an argument can extend. */
      readonly command: string;
      readonly args: readonly string[];
      readonly env: Readonly<Record<string, string>>;
    }
  | {
      readonly kind: 'http';
      readonly url: string;
      readonly headers: Readonly<Record<string, string>>;
    };

export interface McpServerSpec {
  /** Namespaces this server's tools, so two servers may offer the same name. */
  readonly id: string;
  readonly label: string;
  readonly transport: McpTransport;
  /**
   * Only these tool names, when set. A server that offers forty tools is not
   * the same decision as the three an operator wants a run to have, and without
   * this the only way to attach one narrowly is not to attach it.
   */
  readonly tools: readonly string[] | null;
}
