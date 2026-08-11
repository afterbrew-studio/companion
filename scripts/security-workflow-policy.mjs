import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const workflowDir = join(root, '.github', 'workflows');
const errors = [];
let actionCount = 0;

for (const path of await workflowFiles(workflowDir)) {
  const source = await readFile(path, 'utf8');
  const name = relative(root, path);

  if (!/^permissions:\s*(?:$|\{\}|read-all\s*$)/m.test(source)) {
    errors.push(`${name}: declare top-level permissions explicitly`);
  }
  if (/^\s{0,2}pull_request_target\s*:/m.test(source)) {
    errors.push(`${name}: pull_request_target is forbidden; it exposes a privileged token to PR-controlled workflows`);
  }

  for (const [index, line] of source.split('\n').entries()) {
    const match = line.match(/^\s*(?:-\s*)?uses:\s*["']?([^\s"'#]+)["']?/);
    if (!match) continue;
    const spec = match[1];
    if (!spec || spec.startsWith('./')) continue;
    actionCount += 1;

    if (spec.startsWith('docker://')) {
      if (!/@sha256:[a-f0-9]{64}$/.test(spec)) {
        errors.push(`${name}:${index + 1}: pin Docker actions by sha256 digest (${spec})`);
      }
      continue;
    }

    const separator = spec.lastIndexOf('@');
    const revision = separator === -1 ? '' : spec.slice(separator + 1);
    if (!/^[a-f0-9]{40}$/.test(revision)) {
      errors.push(`${name}:${index + 1}: pin actions to a full commit SHA (${spec})`);
    }
  }
}

if (errors.length > 0) {
  process.stderr.write(`${errors.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`workflow policy: ${actionCount} action reference(s) pinned; explicit permissions present\n`);
}

async function workflowFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await workflowFiles(path)));
    else if (entry.isFile() && /\.ya?ml$/.test(entry.name)) files.push(path);
  }
  return files.sort();
}
