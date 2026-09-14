import { createProviderRegistry, type LanguageModel } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';
import { google } from '@ai-sdk/google';
import { createLlmResolver, type Resolver } from '@ete/core';

const registry = createProviderRegistry({ anthropic, openai, google });
type ProviderId = 'anthropic' | 'openai' | 'google';
const ENV_KEYS: Record<ProviderId, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
};

export type LlmConfig = { provider: string; model: string };

function assertProvider(provider: string): asserts provider is ProviderId {
  if (!(provider in ENV_KEYS)) {
    throw new Error(`Unknown LLM provider "${provider}". Supported: ${Object.keys(ENV_KEYS).join(', ')}`);
  }
}

export function envKeyFor(provider: string): string {
  assertProvider(provider);
  return ENV_KEYS[provider];
}

export function createModel(cfg: LlmConfig): Exclude<LanguageModel, string> {
  assertProvider(cfg.provider);
  return registry.languageModel(`${cfg.provider}:${cfg.model}`);
}

/**
 * A resolver that only touches the provider (and only checks for the API key)
 * on first use, so fully cached runs need no key at all.
 */
export function createLazyResolver(cfg: LlmConfig): Resolver {
  let inner: Resolver | undefined;
  return {
    async resolve(input) {
      if (!inner) {
        const key = envKeyFor(cfg.provider);
        if (!process.env[key]) {
          throw new Error(`Missing ${key}: needed to resolve or heal step "${input.step.text}". Set it in the environment.`);
        }
        inner = createLlmResolver({ model: createModel(cfg) });
      }
      return inner.resolve(input);
    },
  };
}
