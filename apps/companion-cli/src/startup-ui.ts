const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[38;5;42m';
const BLUE = '\x1b[38;5;75m';

export interface StartupUiOptions {
  readonly url: string;
  readonly home: string;
  readonly desk: boolean;
  readonly background: boolean;
  readonly verbose: boolean;
  readonly logFile: string;
  readonly color: boolean;
}

function tone(text: string, code: string, enabled: boolean): string {
  return enabled ? `${code}${text}${RESET}` : text;
}

/** A stable, compact launch card. Daemon logs never need to compete with it. */
export function renderStartup(options: StartupUiOptions): string {
  const product = options.desk ? 'Companion Desk' : 'Companion';
  const logs = options.background
    ? options.logFile
    : options.verbose
      ? 'live (--verbose)'
      : 'quiet while starting · use --verbose';
  return [
    '',
    `  ${tone(product, BOLD, options.color)}`,
    `  ${tone('────────────────────────────────────────', DIM, options.color)}`,
    '',
    `  ${tone('◌', DIM, options.color)}  ${tone('Starting', BOLD, options.color)}`,
    `     ${tone(options.url, BLUE, options.color)}`,
    '',
    `     ${tone('Data', DIM, options.color)}      ${options.home}`,
    `     ${tone('Mode', DIM, options.color)}      ${options.background ? 'background' : 'foreground'}`,
    `     ${tone('Logs', DIM, options.color)}      ${logs}`,
    '',
  ].join('\n');
}

export function renderReady(url: string, foreground: boolean, color: boolean): string {
  const lines = [
    `  ${tone('●', GREEN, color)}  ${tone('Ready', BOLD, color)}`,
    `     ${tone(url, BLUE, color)}`,
  ];
  if (foreground) lines.push(`     ${tone('Press Ctrl+C to stop.', DIM, color)}`);
  return `${lines.join('\n')}\n\n`;
}

export function renderAlreadyRunning(url: string, pid: number, color: boolean): string {
  return [
    '',
    `  ${tone('●', GREEN, color)}  ${tone('Companion is already running', BOLD, color)}`,
    `     ${tone(url, BLUE, color)}`,
    '',
    `     ${tone('Process', DIM, color)}   ${pid}`,
    `     ${tone('Stop', DIM, color)}      npx @moxxy/companion stop`,
    '',
  ].join('\n');
}
