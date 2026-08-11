import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

export interface RegularTextFileOptions {
  /** Refuse a larger file before allocating or decoding it. */
  readonly maxBytes?: number;
  /** Apply owner-only permissions to the opened inode, not to a re-resolved path. */
  readonly mode?: number;
}

/**
 * Read one regular file through a no-follow descriptor.
 *
 * A check-then-read sequence can be swapped for a symlink between lstat and
 * readFile. Opening first, validating that descriptor and reading exactly the
 * size that was approved keeps path replacement outside the operation.
 */
export function readRegularTextFile(
  file: string,
  { maxBytes = 1024 * 1024, mode }: RegularTextFileOptions = {},
): string {
  const fd = openSync(file, constants.O_RDONLY | NO_FOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`refusing non-regular file: ${file}`);
    if (stat.size > maxBytes) throw new Error(`${file} exceeds ${maxBytes} bytes`);
    if (mode !== undefined) fchmodSync(fd, mode);
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    return bytes.subarray(0, offset).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * Replace a private text file without ever opening its existing target.
 *
 * The random, exclusive sibling is complete and mode 0600 before rename makes
 * it visible. Replacing a symlink therefore replaces the link itself instead
 * of following it, and a crash cannot leave a half-written credential.
 */
export function writePrivateTextFile(file: string, text: string): void {
  const parent = dirname(file);
  const temp = join(parent, `.${basename(file)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
  try {
    writeFileSync(temp, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}
