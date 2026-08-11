export const MIN_NODE_MAJOR = 24;

/** Fail before loading the application bundle, which itself requires Node 24. */
export function assertSupportedNode(version = process.versions.node): void {
  const first = version.split('.', 1)[0];
  const major = first ? Number(first) : Number.NaN;
  if (Number.isInteger(major) && major >= MIN_NODE_MAJOR) return;
  throw new Error(
    `Companion requires Node.js ${MIN_NODE_MAJOR} or newer; this process is ${version}. ` +
      'Install a supported Node.js release and retry.',
  );
}
