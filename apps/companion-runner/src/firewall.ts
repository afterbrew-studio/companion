import { execFile, spawn } from 'node:child_process';
import { platform } from 'node:os';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/**
 * `companion-runner open-firewall` — open the agent port on this machine's
 * host firewall so a remote Companion can connect. Also attempted (non-fatal)
 * by `companion-runner setup`. Elevation is delegated to sudo interactively;
 * on failure the exact manual command is printed instead of guessing further.
 *
 * Covers the common host firewalls only: ufw / firewalld on Linux, the
 * per-app application firewall on macOS, netsh on Windows. Cloud security
 * groups and network firewalls can't be opened from inside the box.
 */
export async function openFirewall(port: number): Promise<number> {
  switch (platform()) {
    case 'darwin':
      return openMac();
    case 'linux':
      return openLinux(port);
    case 'win32':
      return openWindows(port);
    default:
      process.stdout.write(`no firewall support for platform "${platform()}" — open TCP ${port} manually.\n`);
      return 0;
  }
}

/** macOS's application firewall is per-app: allow the node binary running us. */
async function openMac(): Promise<number> {
  const SFW = '/usr/libexec/ApplicationFirewall/socketfilterfw';
  const state = await execFileP(SFW, ['--getglobalstate']).catch(() => null);
  if (!state || /disabled/i.test(state.stdout)) {
    process.stdout.write('macOS application firewall is off — nothing to open.\n');
    return 0;
  }
  process.stdout.write(`macOS application firewall is on — allowing incoming connections for ${process.execPath}…\n`);
  const added = await run(sudo([SFW, '--add', process.execPath]));
  const unblocked = await run(sudo([SFW, '--unblockapp', process.execPath]));
  if (added === 0 && unblocked === 0) {
    process.stdout.write('done — node is allowed through the application firewall.\n');
    return 0;
  }
  process.stdout.write(
    `could not update the firewall. Run manually:\n` +
      `  sudo ${SFW} --add "${process.execPath}"\n` +
      `  sudo ${SFW} --unblockapp "${process.execPath}"\n`,
  );
  return 1;
}

async function openLinux(port: number): Promise<number> {
  if (await has('ufw')) {
    process.stdout.write(`opening TCP ${port} with ufw…\n`);
    const code = await run(sudo(['ufw', 'allow', `${port}/tcp`, 'comment', 'companion-runner']));
    if (code === 0) {
      process.stdout.write(`done — TCP ${port} is allowed (rule applies once ufw is enabled).\n`);
      return 0;
    }
    process.stdout.write(`ufw failed. Run manually:\n  sudo ufw allow ${port}/tcp comment 'companion-runner'\n`);
    return 1;
  }
  if (await has('firewall-cmd')) {
    process.stdout.write(`opening TCP ${port} with firewalld…\n`);
    const added = await run(sudo(['firewall-cmd', '--permanent', `--add-port=${port}/tcp`]));
    const reloaded = added === 0 ? await run(sudo(['firewall-cmd', '--reload'])) : 1;
    if (added === 0 && reloaded === 0) {
      process.stdout.write(`done — TCP ${port} is open.\n`);
      return 0;
    }
    process.stdout.write(
      `firewalld failed. Run manually:\n` +
        `  sudo firewall-cmd --permanent --add-port=${port}/tcp && sudo firewall-cmd --reload\n`,
    );
    return 1;
  }
  process.stdout.write(
    `no ufw or firewalld found — most likely there is no host firewall to open.\n` +
      `If you manage iptables/nftables directly, allow inbound TCP ${port}.\n`,
  );
  return 0;
}

async function openWindows(port: number): Promise<number> {
  process.stdout.write(`opening TCP ${port} in Windows Defender Firewall…\n`);
  const code = await run([
    'netsh',
    'advfirewall',
    'firewall',
    'add',
    'rule',
    'name=companion-runner',
    'dir=in',
    'action=allow',
    'protocol=TCP',
    `localport=${port}`,
  ]);
  if (code === 0) {
    process.stdout.write(`done — TCP ${port} is open.\n`);
    return 0;
  }
  process.stdout.write(
    `netsh failed (an elevated shell is required). Run as Administrator:\n` +
      `  netsh advfirewall firewall add rule name=companion-runner dir=in action=allow protocol=TCP localport=${port}\n`,
  );
  return 1;
}

/** Prefix with sudo unless already root — lets sudo prompt on the inherited tty. */
function sudo(cmd: string[]): string[] {
  return process.getuid?.() === 0 ? cmd : ['sudo', ...cmd];
}

function run([cmd, ...args]: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd!, args, { stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

async function has(cmd: string): Promise<boolean> {
  try {
    await execFileP('which', [cmd]);
    return true;
  } catch {
    return false;
  }
}
