import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export type AgentName = 'claude' | 'codex';
export type AgentRunner = (o: { prompt: string; cwd: string; onLine: (line: string) => void }) => Promise<{ ok: boolean; error?: string }>;

const exec = promisify(execFile);

export async function detectAgents(): Promise<AgentName[]> {
  const found: AgentName[] = [];
  for (const name of ['claude', 'codex'] as const) {
    try { await exec(process.platform === 'win32' ? 'where' : 'which', [name]); found.push(name); } catch { /* not installed */ }
  }
  return found;
}

/** Turns Claude Code's stream-json lines into readable progress lines. */
export function summariseClaudeEvent(raw: string): string | undefined {
  let ev: Record<string, unknown>;
  try { ev = JSON.parse(raw); } catch { return raw.trim() || undefined; }
  const type = ev.type as string;
  if (type === 'assistant') {
    const msg = ev.message as { content?: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }> } | undefined;
    const parts = (msg?.content ?? []).map((c) => {
      if (c.type === 'text' && c.text) return c.text.trim();
      if (c.type === 'tool_use') return `⚙ ${c.name}${c.input && typeof c.input.command === 'string' ? `: ${c.input.command}` : c.input && typeof c.input.file_path === 'string' ? `: ${c.input.file_path}` : ''}`;
      return '';
    }).filter(Boolean);
    return parts.join('\n') || undefined;
  }
  if (type === 'result') return (ev.is_error ? '✗ ' : '✓ ') + String(ev.result ?? '').trim();
  return undefined;
}

/**
 * Runs the local Claude Code CLI headlessly with the user's own auth. Tools are limited to what a
 * recording/map-editing task needs; nothing here holds credentials.
 */
export const claudeRunner: AgentRunner = ({ prompt, cwd, onLine }) =>
  new Promise((resolve) => {
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--allowedTools', 'Bash(ete *)', 'Bash(cd *)', 'Read', 'Edit', 'Write', 'Glob', 'Grep'];
    const child = spawn('claude', args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '', err = '', isError = false;
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (/"type":"result"/.test(line) && /"is_error":true/.test(line)) isError = true;
        const s = summariseClaudeEvent(line);
        if (s) onLine(s);
      }
    });
    child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    child.on('error', (e) => resolve({ ok: false, error: e.message }));
    child.on('close', (code) => resolve({ ok: code === 0 && !isError, error: code === 0 ? undefined : err.trim() || `claude exited with ${code}` }));
  });

export const codexRunner: AgentRunner = ({ prompt, cwd, onLine }) =>
  new Promise((resolve) => {
    const child = spawn('codex', ['exec', '--full-auto', '-C', cwd, prompt], { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    const emit = (d: Buffer) => d.toString().split('\n').filter((l) => l.trim()).forEach((l) => onLine(l));
    child.stdout.on('data', emit);
    child.stderr.on('data', (d: Buffer) => { err += d.toString(); emit(d); });
    child.on('error', (e) => resolve({ ok: false, error: e.message }));
    child.on('close', (code) => resolve({ ok: code === 0, error: code === 0 ? undefined : err.trim() || `codex exited with ${code}` }));
  });

export function runnerFor(name: AgentName): AgentRunner {
  return name === 'codex' ? codexRunner : claudeRunner;
}
