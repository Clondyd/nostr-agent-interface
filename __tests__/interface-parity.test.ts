import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import path from "node:path";
import { startApiServer } from "../app/api.js";
import { createManagedMcpClient } from "../app/mcp-client.js";

type InvokeRequestOptions = {
  method?: string;
  path: string;
  headers?: Record<string, string | string[]>;
  bodyChunks?: string[];
};

type InvokeResponse = {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
  rawBody: string;
};

type TransportResult = {
  statusCode: number;
  body: unknown;
};

async function resolveNodeCommand(): Promise<string> {
  return (await Bun.which("node")) ?? process.execPath;
}

async function resolveBuiltOrSourceEntry(): Promise<string> {
  const built = path.resolve(process.cwd(), "build/app/index.js");
  if (await Bun.file(built).exists()) {
    return built;
  }

  return path.resolve(process.cwd(), "app/index.ts");
}

/**
 * Starts the API harness by spawning the real API process and issuing real
 * HTTP requests. Exercises the actual request handling layer in app/api.ts.
 */
async function startApiHarness() {
  mock.restore();
  try {
    const handle = await startApiServer({
      host: "127.0.0.1",
      port: 0,
      auditLogEnabled: false,
    });
    const baseUrl = `http://${handle.host}:${handle.port}`;

    return {
      invoke: async (options: InvokeRequestOptions): Promise<InvokeResponse> => {
        const method = options.method ?? "GET";
        const url = `${baseUrl}${options.path}`;
        const requestHeaders: Record<string, string> = {
          connection: "close",
        };
        if (options.headers) {
          for (const [key, value] of Object.entries(options.headers)) {
            requestHeaders[key] = Array.isArray(value) ? value[0] : String(value);
          }
        }
        const body = options.bodyChunks?.join("") ?? undefined;

        const res = await fetch(url, {
          method,
          headers: Object.keys(requestHeaders).length > 0 ? requestHeaders : undefined,
          body: method === "POST" && body !== undefined ? body : undefined,
        });

        const rawBody = await res.text();
        type ParseFailure = { __jsonParseError: string; __raw: string };
        let parsedBody: unknown = null;
        let parseFailure: ParseFailure | null = null;
        if (rawBody.trim()) {
          try {
            parsedBody = JSON.parse(rawBody);
          } catch (error) {
            parseFailure = {
              __jsonParseError: error instanceof Error ? error.message : String(error),
              __raw: rawBody,
            };
            parsedBody = parseFailure;
            console.error("Failed to parse API JSON response:", parseFailure.__jsonParseError, parseFailure.__raw);
          }
        }

        const responseHeaders: Record<string, string> = {};
        res.headers.forEach((value, key) => {
          responseHeaders[key.toLowerCase()] = value;
        });

        return {
          statusCode: res.status,
          headers: responseHeaders,
          body: parsedBody,
          rawBody,
        };
      },

      shutdown: async () => {
        await handle.shutdown();
      },
    };
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "EPERM") {
      console.warn("Skipping API parity harness: network bind not permitted in this environment");
      return null;
    }
    throw error;
  }
}

type McpHarness = {
  listTools: () => Promise<TransportResult>;
  callTool: (toolName: string, args: Record<string, unknown>) => Promise<TransportResult>;
  close: () => Promise<void>;
};

async function startMcpHarness(): Promise<McpHarness> {
  mock.restore();
  const nodeCommand = await resolveNodeCommand();
  const mcpEntry = await resolveBuiltOrSourceEntry();
  const serverProcess = {
    command: nodeCommand,
    args: [mcpEntry, "mcp"],
    cwd: process.cwd(),
    stderr: "pipe" as const,
  };

  const managed = await createManagedMcpClient(serverProcess, {
    stderrWriter: () => {},
  });

  return {
    listTools: async () => {
      const body = await managed.client.listTools();
      return { statusCode: 200, body };
    },
    callTool: async (toolName: string, args: Record<string, unknown>) => {
      try {
        const body = await managed.client.callTool({ name: toolName, arguments: args });
        return { statusCode: 200, body };
      } catch (error) {
        const errorBody = (() => {
          if (error && typeof error === "object" && "body" in error) {
            return (error as { body?: unknown }).body;
          }
          if (error instanceof Error) {
            return error.message;
          }
          return String(error);
        })();

        return {
          statusCode: 500,
          body: {
            isError: true,
            content: [{ type: "text", text: String(errorBody) }],
          },
        };
      }
    },
    close: async () => managed.close(),
  };
}

function isErrorResult(response: unknown): boolean {
  return (response as { isError?: unknown }).isError === true;
}

function getContent(response: unknown): unknown[] {
  if (response && typeof response === "object" && Array.isArray((response as { content?: unknown[] }).content)) {
    return (response as { content?: unknown[] }).content ?? [];
  }
  return [];
}

function toTextPayload(response: unknown): string[] {
  const content = getContent(response);
  return content
    .map((entry) => (entry as { text?: unknown }).text)
    .filter((text): text is string => typeof text === "string");
}

function normalizeCreateKeypairOutput(text: string): string {
  return text
    .replace(/[0-9a-f]{64}/gi, "<hex>")
    .replace(/nsec1[0-9a-z]+/gi, "<nsec>")
    .replace(/npub1[0-9a-z]+/gi, "<npub>");
}

function getToolNames(response: unknown): string[] {
  if (!response || typeof response !== "object") {
    return [];
  }

  const tools = (response as { tools?: unknown[] }).tools;
  if (!Array.isArray(tools)) {
    return [];
  }

  return tools
    .map((tool) => (tool as { name?: unknown }).name)
    .filter((name): name is string => typeof name === "string")
    .sort();
}

function parseJsonOutput<T>(output: string): T {
  return JSON.parse(output);
}

async function runCliJson(args: string[]): Promise<TransportResult> {
  const cliEntry = await resolveBuiltOrSourceEntry();
  const command = await resolveNodeCommand();
  const proc = Bun.spawn({
    cmd: [command, cliEntry, "cli", ...args, "--json"],
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      NOSTR_JSON_ONLY: "true",
    },
  });

  const [stdout, stderrOutput] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const exitCode = await proc.exited;
  const trimmedOutput = stdout.trim();

  if (!trimmedOutput) {
    if (exitCode !== 0 && stderrOutput.trim()) {
      throw new Error(stderrOutput.trim());
    }

    throw new Error("Expected JSON output from CLI process, but output was empty");
  }

  const parsed = parseJsonOutput(trimmedOutput);
  return { statusCode: exitCode, body: parsed };
}

describe("Interface parity (CLI, API)", () => {
  let api: Awaited<ReturnType<typeof startApiHarness>> | null | undefined;
  let mcp: Awaited<ReturnType<typeof startMcpHarness>> | undefined;

  beforeAll(async () => {
    api = await startApiHarness();
    mcp = await startMcpHarness();
  });

  afterAll(async () => {
    await Promise.allSettled([api?.shutdown(), mcp?.close()]);
    mock.restore();
  });

  test("lists the same tool names", async () => {
    if (!api) return;
    if (!mcp) throw new Error("MCP harness not started");

    const cliTools = await runCliJson(["list-tools"]);
    const apiResponse = await api.invoke({ path: "/tools" });
    const mcpTools = await mcp.listTools();

    const cliNames = getToolNames(cliTools.body);
    const apiNames = getToolNames(apiResponse.body);
    const mcpNames = getToolNames(mcpTools.body);

    expect(cliTools.statusCode).toBe(0);
    expect(apiResponse.statusCode).toBe(200);
    expect(mcpTools.statusCode).toBe(200);
    expect(apiNames.length).toBeGreaterThan(0);
    expect(cliNames).toEqual(expect.arrayContaining(apiNames));
    expect(mcpNames).toEqual(expect.arrayContaining(cliNames));
  });

  test("tool call behavior matches for deterministic validation paths", async () => {
    if (!api) return;
    if (!mcp) throw new Error("MCP harness not started");

    const cases: Array<{
      toolName: string;
      args: Record<string, unknown>;
      useCallSubcommand?: boolean;
      compareMode?: "exact" | "loose" | "keypair" | "errorMessage";
    }> = [
      {
        toolName: "convertNip19",
        args: { input: "not-a-valid-value", targetType: "npub" },
        useCallSubcommand: true,
        compareMode: "errorMessage",
      },
      {
        toolName: "convertNip19",
        useCallSubcommand: true,
        args: {
          input:
            "7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e",
          targetType: "npub",
        },
        compareMode: "loose",
      },
      {
        toolName: "createKeypair",
        args: {},
        compareMode: "keypair",
      },
      {
        toolName: "postNote",
        args: { privateKey: "invalid", content: "test" },
        useCallSubcommand: true,
        compareMode: "exact",
      },
    ];

    for (const testCase of cases) {
      const cliArgs = testCase.useCallSubcommand
        ? ["call", testCase.toolName, JSON.stringify(testCase.args)]
        : [testCase.toolName, JSON.stringify(testCase.args)];

      const cliResult = await runCliJson(cliArgs);
      expect(cliResult.statusCode).toBe(0);
      const apiResponse = await api.invoke({
        method: "POST",
        path: `/tools/${testCase.toolName}`,
        headers: { "content-type": "application/json" },
        bodyChunks: [JSON.stringify(testCase.args)],
      });
      const mcpResult = await mcp.callTool(testCase.toolName, testCase.args);

      const cliContent = getContent(cliResult.body);
      const apiContent = getContent(apiResponse.body);
      const mcpContent = getContent(mcpResult.body);
      const cliIsError = isErrorResult(cliResult.body);
      const apiIsError = isErrorResult(apiResponse.body);
      const mcpIsError = isErrorResult(mcpResult.body);
      const cliText = toTextPayload(cliResult.body);
      const apiText = toTextPayload(apiResponse.body);
      const mcpText = toTextPayload(mcpResult.body);
      const compareMode = testCase.compareMode ?? "exact";

      expect(apiResponse.statusCode).toBe(200);
      expect(mcpResult.statusCode).toBe(200);
      if (compareMode === "keypair") {
        expect(cliText.length).toBeGreaterThan(0);
        expect(apiText.length).toBeGreaterThan(0);
        expect(mcpText.length).toBeGreaterThan(0);
        expect(normalizeCreateKeypairOutput(cliText[0])).toEqual(normalizeCreateKeypairOutput(apiText[0]));
        expect(normalizeCreateKeypairOutput(cliText[0])).toEqual(normalizeCreateKeypairOutput(mcpText[0]));
        expect(cliText[0]).toContain("New Nostr keypair generated:");
        expect(apiText[0]).toContain("New Nostr keypair generated:");
        expect(mcpText[0]).toContain("New Nostr keypair generated:");
      } else if (compareMode === "errorMessage") {
        const allText = [...cliText, ...apiText, ...mcpText].join(" ").toLowerCase();
        expect(allText).toBeTruthy();
        expect(allText).toMatch(/error|invalid|failed/);
      } else if (compareMode === "loose") {
        expect(cliText.length).toBeGreaterThan(0);
        expect(apiText.length).toBeGreaterThan(0);
        expect(mcpText.length).toBeGreaterThan(0);
      } else {
        expect(cliContent).toEqual(apiContent);
        expect(cliContent).toEqual(mcpContent);
      }
      expect(cliIsError).toBe(apiIsError);
      expect(cliIsError).toBe(mcpIsError);
      expect(Array.isArray(cliContent)).toBe(true);
      expect(Array.isArray(apiContent)).toBe(true);
      expect(Array.isArray(mcpContent)).toBe(true);
    }
  });
});
