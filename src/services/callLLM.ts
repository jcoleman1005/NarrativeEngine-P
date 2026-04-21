// ─── Shared non-streaming LLM call utility ────────────────────────────────────
// All non-streaming /chat/completions calls go through here so they share
// the same rate-limit queue (llmQueue) and retry logic.
//
// Priority guide:
//   'high'   — context recommender (pre-turn; story AI depends on it)
//   'normal' — story AI streaming wrapper (llmService.ts uses the queue directly)
//   'low'    — all post-turn background tasks (inventory, profile, importance, save)

import type { ProviderConfig, EndpointConfig } from '../types';
import { getQueueForEndpoint, type LLMCallPriority } from './llmRequestQueue';
import { getChatUrl, buildChatHeaders, buildChatBody, extractContent } from '../utils/llmApiHelper';

const MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 300;

export type { LLMCallPriority };

export async function callLLM(
    provider: ProviderConfig | EndpointConfig,
    prompt: string,
    options?: {
        temperature?: number;
        maxTokens?: number;
        signal?: AbortSignal;
        priority?: LLMCallPriority;
    }
): Promise<string> {
    const url = getChatUrl(provider);
    const headers = buildChatHeaders(provider);
    const body = buildChatBody(provider, [{ role: 'user', content: prompt }], {
        stream: false,
        temperature: options?.temperature,
        max_tokens: options?.maxTokens,
    });

    const priority = options?.priority ?? 'normal';
    const queue = getQueueForEndpoint(provider.endpoint);

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        await queue.acquireSlot(priority);

        let res: Response;
        try {
            res = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                signal: options?.signal,
            });
        } catch (e) {
            queue.releaseSlot();
            throw e;
        }

        const retryable = res.status === 429 || res.status === 503 || res.status === 529;
        if (!retryable) {
            queue.releaseSlot();
            if (!res.ok) {
                const errBody = await res.text();
                throw new Error(`LLM API error ${res.status}: ${errBody}`);
            }
            const data = await res.json();
            return extractContent(data, provider);
        }

        // ── 429 / 503 / 529 handling ────────────────────────────────────────
        queue.onRateLimitHit();
        queue.releaseSlot();

        if (attempt === MAX_RETRIES) {
            const errBody = await res.text();
            throw new Error(`LLM API error ${res.status} (retries exhausted): ${errBody}`);
        }

        const retryAfter = res.headers.get('Retry-After');
        const delay = retryAfter
            ? parseFloat(retryAfter) * 1000
            : DEFAULT_RETRY_DELAY_MS;

        console.warn(
            `[LLMQueue] ${res.status} (attempt ${attempt + 1}/${MAX_RETRIES + 1}, priority=${priority}). ` +
            `Waiting ${delay}ms then re-queuing for next open slot...`
        );
        await new Promise(resolve => setTimeout(resolve, delay));
    }

    throw new Error('[LLMQueue] Unreachable');
}
