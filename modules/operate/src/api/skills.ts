import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '@companion/services';
import type { SkillFile } from '../contract/index.js';

/**
 * Repo-scoped skill editor. Skills are plain Markdown files under the
 * Companion moxxy home's `skills/` dir — moxxy's user-scope skill discovery
 * ($MOXXY_HOME/skills) picks them up automatically for every Companion run.
 */
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export class Skills {
  private dir(): string {
    const dir = join(paths.moxxyHome(), 'skills');
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  list(): SkillFile[] {
    const dir = this.dir();
    return readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => {
        const file = join(dir, f);
        return {
          name: f.replace(/\.md$/, ''),
          content: readFileSync(file, 'utf8'),
          updatedAt: statSync(file).mtimeMs,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): SkillFile | null {
    this.assertName(name);
    try {
      const file = join(this.dir(), `${name}.md`);
      return { name, content: readFileSync(file, 'utf8'), updatedAt: statSync(file).mtimeMs };
    } catch {
      return null;
    }
  }

  save(name: string, content: string): SkillFile {
    this.assertName(name);
    const file = join(this.dir(), `${name}.md`);
    writeFileSync(file, ensureFrontmatter(name, content));
    return { name, content: readFileSync(file, 'utf8'), updatedAt: Date.now() };
  }

  remove(name: string): void {
    this.assertName(name);
    rmSync(join(this.dir(), `${name}.md`), { force: true });
  }

  private assertName(name: string): void {
    if (!NAME_RE.test(name)) throw new Error('skill name must be lowercase-kebab (a-z, 0-9, -)');
  }
}

/** moxxy skills need frontmatter; add a minimal block when the author omits it. */
function ensureFrontmatter(name: string, content: string): string {
  if (content.trimStart().startsWith('---')) return content;
  return `---\nname: ${name}\ndescription: ${name} (Companion skill)\n---\n\n${content}`;
}
