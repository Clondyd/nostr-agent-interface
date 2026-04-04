import { describe, expect, mock, test } from "bun:test";

type ToolRuntimeModule = typeof import("../app/tool-runtime.js");

async function loadToolRuntimeModule(): Promise<ToolRuntimeModule> {
  mock.restore();
  return import(`../app/tool-runtime.js?real=${Date.now()}-${Math.random()}`) as Promise<ToolRuntimeModule>;
}

function extractTextPayload(result: { content?: unknown[] }) {
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .filter((block) => typeof block === "object" && block !== null)
    .filter((block) => (block as { type?: string }).type === "text")
    .map((block) => (block as { text?: unknown }).text)
    .filter((value): value is string => typeof value === "string")
    .join("");

  return text;
}

describe("in-process tool runtime", () => {
  test("returns the unified tool catalog from direct registration", async () => {
    const { createInProcessToolRuntime } = await loadToolRuntimeModule();
    const runtime = await createInProcessToolRuntime();

    try {
      const listResponse = await runtime.listTools();

      expect(Array.isArray(listResponse.tools)).toBe(true);
      const names = listResponse.tools
        .map((tool) => tool?.name)
        .filter((name): name is string => typeof name === "string");

      expect(names.length).toBeGreaterThan(20);
      expect(new Set(names).size).toBe(names.length);
      expect(names).toContain("convertNip19");
      expect(names).toContain("createKeypair");
      expect(names).toContain("postNote");
      expect(names).toContain("getProfile");
      expect(listResponse.tools.every((tool) => typeof tool.name === "string")).toBe(true);
    } finally {
      await runtime.close();
    }
  });

  test("dispatches valid tool calls directly and returns MCP-like payload", async () => {
    const { createInProcessToolRuntime } = await loadToolRuntimeModule();
    const runtime = await createInProcessToolRuntime();

    try {
      const keypairResult = await runtime.callTool("createKeypair", {});
      expect(Array.isArray(keypairResult.content)).toBe(true);
      expect(keypairResult.isError).toBe(false);
      expect(extractTextPayload(keypairResult)).toContain("New Nostr keypair generated:");

      const conversionFailure = await runtime.callTool("convertNip19", {
        input: "definitely-not-a-valid-nip19-value",
        targetType: "hex",
      });
      expect(Array.isArray(conversionFailure.content)).toBe(true);
      expect(conversionFailure.isError).toBe(false);
      expect(extractTextPayload(conversionFailure)).toContain("Conversion failed:");
    } finally {
      await runtime.close();
    }
  });

  test("returns validation errors for malformed tool arguments", async () => {
    const { createInProcessToolRuntime } = await loadToolRuntimeModule();
    const runtime = await createInProcessToolRuntime();

    try {
      const malformed = await runtime.callTool("convertNip19", { input: 12345, targetType: "hex" });
      expect(malformed.isError).toBe(true);
      expect(Array.isArray(malformed.content)).toBe(true);
      expect(extractTextPayload(malformed)).toContain("Invalid arguments");
      expect(extractTextPayload(malformed).toLowerCase()).toContain("invalid");
    } finally {
      await runtime.close();
    }
  });

  test("returns structured error for unknown tool names", async () => {
    const { createInProcessToolRuntime } = await loadToolRuntimeModule();
    const runtime = await createInProcessToolRuntime();

    try {
      const result = await runtime.callTool("does-not-exist", {});

      expect(result.isError).toBe(true);
      expect(Array.isArray(result.content)).toBe(true);
      expect(extractTextPayload(result)).toContain("Unknown tool: does-not-exist");
    } finally {
      await runtime.close();
    }
  });

  test("allows repeated close without side effects", async () => {
    const { createInProcessToolRuntime } = await loadToolRuntimeModule();
    const runtime = await createInProcessToolRuntime();
    await runtime.close();
    await runtime.close();
    await runtime.close();
  });
});
