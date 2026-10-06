import { afterEach, expect, it, vi } from "vitest";
import {
	closeOpenAICodexWebSocketSessions,
	getOpenAICodexWebSocketDebugStats,
	resetOpenAICodexWebSocketDebugStats,
	stream,
} from "../src/api/openai-codex-responses.ts";
import type { Model } from "../src/types.ts";
import { retryAssistantCall } from "../src/utils/retry.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

afterEach(() => {
	closeOpenAICodexWebSocketSessions();
	resetOpenAICodexWebSocketDebugStats();
	vi.unstubAllGlobals();
});

it.each(["websocket", "websocket-cached"] as const)(
	"retries Codex reconnect guidance on a fresh %s connection with full context",
	async (transport) => {
		const sockets: MockWebSocket[] = [];
		const requests: { input: unknown[]; previous_response_id?: string }[] = [];
		const errorMessage =
			"The experimental native turn lane could not verify the authenticated WebSocket context. Open a new WebSocket connection and retry.";
		class MockWebSocket extends EventTarget {
			static OPEN = 1;
			readyState = MockWebSocket.OPEN;
			close = vi.fn(() => {
				this.readyState = 3;
			});

			constructor() {
				super();
				sockets.push(this);
				queueMicrotask(() => this.dispatchEvent(new Event("open")));
			}

			send(data: string): void {
				requests.push(JSON.parse(data));
				const event =
					requests.length === 2
						? { type: "error", message: errorMessage }
						: {
								type: "response.completed",
								response: {
									id: `resp_${requests.length}`,
									status: "completed",
									usage: { input_tokens: 5, output_tokens: 0, total_tokens: 5 },
								},
							};
				queueMicrotask(() => {
					this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(event) }));
				});
			}
		}
		vi.stubGlobal("WebSocket", MockWebSocket);
		const fetchMock = vi.fn(() => {
			throw new Error("Unexpected SSE fallback");
		});
		vi.stubGlobal("fetch", fetchMock);
		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};
		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		).toString("base64");
		const options = { apiKey: `aaa.${payload}.bbb`, sessionId: `reconnect-${transport}`, transport };
		const firstContext = normalizeContext({ messages: [{ role: "user", content: "First turn", timestamp: 1 }] });
		const first = await stream(model, firstContext, options).result();
		expect(first.stopReason).toBe("stop");
		const nextContext = normalizeContext({
			messages: [...firstContext.messages, first, { role: "user", content: "Next turn", timestamp: 2 }],
		});
		const onRetryScheduled = vi.fn(() => {
			expect(sockets[0]!.close).toHaveBeenCalledOnce();
		});
		const result = await retryAssistantCall(
			() => stream(model, nextContext, options).result(),
			{ enabled: true, maxRetries: 1, baseDelayMs: 0 },
			undefined,
			{ onRetryScheduled },
		);

		expect(result.stopReason).toBe("stop");
		expect(onRetryScheduled).toHaveBeenCalledExactlyOnceWith(1, 1, 0, `Codex error: ${errorMessage}`);
		expect(sockets).toHaveLength(2);
		expect(requests).toHaveLength(3);
		expect(requests[1]!.previous_response_id).toBe(transport === "websocket-cached" ? "resp_1" : undefined);
		expect(requests[2]!.previous_response_id).toBeUndefined();
		expect(requests[2]!.input).toEqual([
			{ role: "user", content: [{ type: "input_text", text: "First turn" }] },
			{ role: "user", content: [{ type: "input_text", text: "Next turn" }] },
		]);
		expect(getOpenAICodexWebSocketDebugStats(options.sessionId)).toMatchObject({
			connectionsCreated: 2,
			connectionsReused: 1,
			sseFallbacks: 0,
		});
		expect(fetchMock).not.toHaveBeenCalled();
	},
);
