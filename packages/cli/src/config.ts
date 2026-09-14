import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { z } from 'zod';

export const ConfigSchema = z.object({
  url: z.string().url({ message: 'url must be a full URL, e.g. http://localhost:3000' }),
  start: z.string().min(1).optional(),
  readyTimeout: z.number().int().positive().default(60000),
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
