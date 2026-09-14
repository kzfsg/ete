import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { z } from 'zod';

export const ConfigSchema = z.object({
  url: z.string().url({ message: 'url must be a full URL, e.g. http://localhost:3000' }),
  start: z.string().min(1).optional(),
  readyTimeout: z.number().int().positive().default(60000),
  llm: z
    .object({
      provider: z.string().min(1).default('anthropic'),
      model: z.string().min(1).default('claude-opus-5'),
    })
    .default({ provider: 'anthropic', model: 'claude-opus-5' }),
  heal: z
    .object({
      maxPerRun: z.number().int().min(0).default(5),
      maxPerStep: z.number().int().min(0).default(2),
    })
    .default({ maxPerRun: 5, maxPerStep: 2 }),
});
export type Config = z.infer<typeof ConfigSchema>;

export function parseConfig(yamlText: string): Config {
  const raw = YAML.parse(yamlText) ?? {};
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`Invalid ete.yaml: ${issues}`);
  }
  return result.data;
}

export async function loadConfig(path: string): Promise<Config> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Config file not found: ${path}. Run \`ete init\` to create one.`);
    }
    throw err;
  }
  return parseConfig(text);
}
