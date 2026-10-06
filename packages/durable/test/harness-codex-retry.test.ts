import { fauxAssistantMessage, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { defineTool, LiveDoc, MemoryStorage, ToolResultEntry } from "@earendil-works/pi-durable";
import { expect, it, vi } from "vitest";
import { allEntries, chatSetup, openChat, textOf } from "./chat-support.ts";
import { addTool } from "./harness-support.ts";
import { context } from "./session-support.ts";

const reconnectError = fauxAssistantMessage([], {
	stopReason: "error",
	errorMessage:
		"Codex error: The experimental native turn lane could not verify the authenticated WebSocket context. Open a new WebSocket connection and retry.",
});

it("retries a Codex reconnect error within the same submission without repeating completed tools", async () => {
	const setup = chatSetup();
	const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "recorded once" }] }));
	addTool(
		setup.registry,
		defineTool({ name: "record", description: "Record once", parameters: Type.Object({}), execute }),
	);
	setup.settings.retry = { enabled: true, maxRetries: 1, baseDelayMs: 1 };
	setup.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("record", {}, { id: "call_1" }), { stopReason: "toolUse" }),
		reconnectError,
		fauxAssistantMessage("recovered"),
	]);
	const { harness, root } = await openChat(new MemoryStorage(), setup);
	try {
		const submission = await root.submit({ type: "input", content: "Record once, then answer" }, context);
		expect(await submission.wait(context)).toMatchObject({ status: "done" });
		const entries = await allEntries(root);
		expect(entries.filter((entry) => entry.kind === "pi.user")).toHaveLength(1);
		expect(entries.filter((entry) => ToolResultEntry.is(entry))).toHaveLength(1);
		expect(textOf(entries.at(-1)?.model?.[0])).toBe("recovered");
		expect(execute).toHaveBeenCalledOnce();
		expect(setup.faux.state.callCount).toBe(3);
		expect(await harness.snapshot(LiveDoc, root.id, context)).toEqual({});
	} finally {
		await harness.close(context);
	}
});

it.each([
	{ enabled: false, maxRetries: 3, expectedCalls: 1 },
	{ enabled: true, maxRetries: 1, expectedCalls: 2 },
])("respects the retry policy for repeated Codex reconnect errors: %j", async ({ expectedCalls, ...retry }) => {
	const setup = chatSetup();
	setup.settings.retry = { ...retry, baseDelayMs: 1 };
	setup.faux.setResponses([reconnectError, reconnectError, fauxAssistantMessage("never")]);
	const { harness, root } = await openChat(new MemoryStorage(), setup);
	try {
		expect(await (await root.submit({ type: "input", content: "hi" }, context)).wait(context)).toMatchObject({
			status: "unanswered",
			reason: "model_error",
			detail: reconnectError.errorMessage,
		});
		expect(setup.faux.state.callCount).toBe(expectedCalls);
	} finally {
		await harness.close(context);
	}
});
