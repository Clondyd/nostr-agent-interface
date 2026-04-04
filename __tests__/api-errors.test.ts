import { test, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { describeNetwork } from "./support/network-suite.js";

const API_HOST = "127.0.0.1";
const TEST_API_KEY = "test-api-key";
type ApiPortConfig = {
  API_PORT: number;
  SECURED_API_PORT: number;
  RATE_LIMITED_API_PORT: number;
  RATE_LIMITED_ROTATING_KEY_API_PORT: number;
  RATE_LIMITED_SPOOFED_PROXY_API_PORT: number;
  BODY_LIMITED_API_PORT: number;
  API_BASE_URL: string;
  SECURED_API_BASE_URL: string;
  RATE_LIMITED_API_BASE_URL: string;
  RATE_LIMITED_ROTATING_KEY_API_BASE_URL: string;
  RATE_LIMITED_SPOOFED_PROXY_API_BASE_URL: string;
  BODY_LIMITED_API_BASE_URL: string;
};

let cachedApiPorts: ApiPortConfig | null = null;

function makeApiPortConfig(ports: number[]): ApiPortConfig {
  const [
    API_PORT,
    SECURED_API_PORT,
    RATE_LIMITED_API_PORT,
    RATE_LIMITED_ROTATING_KEY_API_PORT,
    RATE_LIMITED_SPOOFED_PROXY_API_PORT,
    BODY_LIMITED_API_PORT,
  ] = ports;

  return {
    API_PORT,
    SECURED_API_PORT,
    RATE_LIMITED_API_PORT,
    RATE_LIMITED_ROTATING_KEY_API_PORT,
    RATE_LIMITED_SPOOFED_PROXY_API_PORT,
    BODY_LIMITED_API_PORT,
    API_BASE_URL: `http://${API_HOST}:${API_PORT}`,
    SECURED_API_BASE_URL: `http://${API_HOST}:${SECURED_API_PORT}`,
    RATE_LIMITED_API_BASE_URL: `http://${API_HOST}:${RATE_LIMITED_API_PORT}`,
    RATE_LIMITED_ROTATING_KEY_API_BASE_URL: `http://${API_HOST}:${RATE_LIMITED_ROTATING_KEY_API_PORT}`,
    RATE_LIMITED_SPOOFED_PROXY_API_BASE_URL: `http://${API_HOST}:${RATE_LIMITED_SPOOFED_PROXY_API_PORT}`,
    BODY_LIMITED_API_BASE_URL: `http://${API_HOST}:${BODY_LIMITED_API_PORT}`,
  };
}

function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, API_HOST, () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address !== "string" && typeof address.port === "number") {
          resolve(address.port);
          return;
        }
        reject(new Error("Could not resolve ephemeral port"));
      });
    });
  });
}

async function findDistinctAvailablePorts(count: number): Promise<number[]> {
  const ports = new Set<number>();

  while (ports.size < count) {
    ports.add(await findAvailablePort());
  }

  return [...ports];
}

async function getApiPortConfig(): Promise<ApiPortConfig> {
  if (!cachedApiPorts) {
    cachedApiPorts = makeApiPortConfig(await findDistinctAvailablePorts(6));
  }
  return cachedApiPorts;
}

const {
  API_PORT,
  SECURED_API_PORT,
  RATE_LIMITED_API_PORT,
  RATE_LIMITED_ROTATING_KEY_API_PORT,
  RATE_LIMITED_SPOOFED_PROXY_API_PORT,
  BODY_LIMITED_API_PORT,
  API_BASE_URL,
  SECURED_API_BASE_URL,
  RATE_LIMITED_API_BASE_URL,
  RATE_LIMITED_ROTATING_KEY_API_BASE_URL,
  RATE_LIMITED_SPOOFED_PROXY_API_BASE_URL,
  BODY_LIMITED_API_BASE_URL,
} = await getApiPortConfig();

type StartedApi = {
  process: ChildProcess;
  getLogs: () => string;
};

async function waitForApiReady(
  apiBaseUrl: string,
  getProc: () => ChildProcess | undefined,
  getLogs: () => string,
  timeoutMs = 15000,
): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const apiProcess = getProc();
    if (apiProcess && apiProcess.exitCode !== null) {
      throw new Error(`API process exited early with code ${apiProcess.exitCode}. Logs:\n${getLogs()}`);
    }

    try {
      const response = await fetch(`${apiBaseUrl}/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // retry until timeout
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`API did not become ready within ${timeoutMs}ms. Logs:\n${getLogs()}`);
}

function startApiProcess(port: number, env: NodeJS.ProcessEnv = process.env): StartedApi {
  const entrypoint = path.resolve(process.cwd(), "app/index.ts");
  const apiProcess = spawn(
    process.execPath,
    [entrypoint, "api", "--host", API_HOST, "--port", String(port)],
    {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let apiLogs = "";
  apiProcess.stdout?.setEncoding("utf8");
  apiProcess.stderr?.setEncoding("utf8");
  apiProcess.stdout?.on("data", (chunk) => {
    apiLogs += chunk;
  });
  apiProcess.stderr?.on("data", (chunk) => {
    apiLogs += chunk;
  });

  return {
    process: apiProcess,
    getLogs: () => apiLogs,
  };
}

async function stopApiProcess(apiProcess: ChildProcess | undefined): Promise<void> {
  if (!apiProcess) return;

  if (apiProcess.exitCode === null) {
    apiProcess.kill("SIGTERM");
  }

  await new Promise((resolve) => {
    const forceKillTimer = setTimeout(() => {
      if (apiProcess.exitCode === null) {
        apiProcess.kill("SIGKILL");
      }
      resolve(undefined);
    }, 1500);

    apiProcess.once("exit", () => {
      clearTimeout(forceKillTimer);
      resolve(undefined);
    });
  });
}

describeNetwork("API error envelope", () => {
  let apiProcess: ChildProcess | undefined;
  let getLogs = () => "";

  beforeAll(async () => {
    const started = startApiProcess(API_PORT);
    apiProcess = started.process;
    getLogs = started.getLogs;

    await waitForApiReady(API_BASE_URL, () => apiProcess, getLogs);
  });

  afterAll(async () => {
    await stopApiProcess(apiProcess);
    apiProcess = undefined;
  });

  test("404 responses use standardized error payload", async () => {
    const response = await fetch(`${API_BASE_URL}/does-not-exist`);
    const body = await response.json();
    const requestId = response.headers.get("x-request-id");

    expect(response.status).toBe(404);
    expect(typeof requestId).toBe("string");
    expect(body?.error?.code).toBe("not_found");
    expect(typeof body?.error?.message).toBe("string");
    expect(body?.error?.requestId).toBe(requestId);
    expect(Array.isArray(body?.error?.details?.endpoints)).toBe(true);
  });

  test("v1 routes are backward-compatible", async () => {
    const legacyToolsRes = await fetch(`${API_BASE_URL}/tools`);
    const v1ToolsRes = await fetch(`${API_BASE_URL}/v1/tools`);
    const legacyTools = await legacyToolsRes.json();
    const v1Tools = await v1ToolsRes.json();

    expect(legacyToolsRes.status).toBe(200);
    expect(v1ToolsRes.status).toBe(200);

    const legacyNames = (legacyTools?.tools ?? []).map((tool: any) => tool.name).sort();
    const v1Names = (v1Tools?.tools ?? []).map((tool: any) => tool.name).sort();
    expect(v1Names).toEqual(legacyNames);

    const v1CallRes = await fetch(`${API_BASE_URL}/v1/tools/getProfile`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ pubkey: "invalid_pubkey" }),
    });
    const v1CallBody = await v1CallRes.json();

    expect(v1CallRes.status).toBe(200);
    expect(Array.isArray(v1CallBody?.content)).toBe(true);
  });

  test("invalid JSON returns invalid_json error code", async () => {
    const response = await fetch(`${API_BASE_URL}/tools/getProfile`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: "{invalid_json",
    });

    const body = await response.json();
    const requestId = response.headers.get("x-request-id");

    expect(response.status).toBe(400);
    expect(body?.error?.code).toBe("invalid_json");
    expect(body?.error?.requestId).toBe(requestId);
    expect(typeof body?.error?.details).toBe("string");
  });
});

describeNetwork("API optional key auth", () => {
  let apiProcess: ChildProcess | undefined;
  let getLogs = () => "";

  beforeAll(async () => {
    const started = startApiProcess(SECURED_API_PORT, {
      ...process.env,
      NOSTR_AGENT_API_KEY: TEST_API_KEY,
    });
    apiProcess = started.process;
    getLogs = started.getLogs;

    await waitForApiReady(SECURED_API_BASE_URL, () => apiProcess, getLogs);
  });

  afterAll(async () => {
    await stopApiProcess(apiProcess);
    apiProcess = undefined;
  });

  test("health remains public and indicates auth mode", async () => {
    const response = await fetch(`${SECURED_API_BASE_URL}/health`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body?.status).toBe("ok");
    expect(body?.authRequired).toBe(true);
  });

  test("tools list requires API key when configured", async () => {
    const response = await fetch(`${SECURED_API_BASE_URL}/tools`);
    const body = await response.json();
    const requestId = response.headers.get("x-request-id");

    expect(response.status).toBe(401);
    expect(body?.error?.code).toBe("unauthorized");
    expect(body?.error?.requestId).toBe(requestId);
  });

  test("v1 tools list also requires API key when configured", async () => {
    const response = await fetch(`${SECURED_API_BASE_URL}/v1/tools`);
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body?.error?.code).toBe("unauthorized");
  });

  test("tools list accepts x-api-key header", async () => {
    const response = await fetch(`${SECURED_API_BASE_URL}/tools`, {
      headers: {
        "x-api-key": TEST_API_KEY,
      },
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(Array.isArray(body?.tools)).toBe(true);
  });

  test("tool call accepts bearer auth header", async () => {
    const response = await fetch(`${SECURED_API_BASE_URL}/tools/getProfile`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TEST_API_KEY}`,
      },
      body: JSON.stringify({ pubkey: "invalid_pubkey" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(Array.isArray(body?.content)).toBe(true);
  });
});

describeNetwork("API rate limiting", () => {
  let apiProcess: ChildProcess | undefined;
  let getLogs = () => "";

  beforeAll(async () => {
    const started = startApiProcess(RATE_LIMITED_API_PORT, {
      ...process.env,
      NOSTR_AGENT_API_RATE_LIMIT_MAX: "2",
      NOSTR_AGENT_API_RATE_LIMIT_WINDOW_MS: "60000",
    });
    apiProcess = started.process;
    getLogs = started.getLogs;

    await waitForApiReady(RATE_LIMITED_API_BASE_URL, () => apiProcess, getLogs);
  });

  afterAll(async () => {
    await stopApiProcess(apiProcess);
    apiProcess = undefined;
  });

  test("returns 429 and rate-limit metadata after limit is reached", async () => {
    const first = await fetch(`${RATE_LIMITED_API_BASE_URL}/tools`);
    const second = await fetch(`${RATE_LIMITED_API_BASE_URL}/tools`);
    const third = await fetch(`${RATE_LIMITED_API_BASE_URL}/tools`);
    const body = await third.json();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    expect(third.status).toBe(429);
    expect(body?.error?.code).toBe("rate_limited");
    expect(typeof body?.error?.details?.retryAfterMs).toBe("number");
    expect(third.headers.get("retry-after")).toBeTruthy();
    expect(third.headers.get("x-ratelimit-limit")).toBe("2");
    expect(third.headers.get("x-ratelimit-remaining")).toBe("0");
    expect(third.headers.get("x-ratelimit-reset")).toBeTruthy();
  });
});

describeNetwork("API rate limiting without auth", () => {
  let apiProcess: ChildProcess | undefined;
  let getLogs = () => "";

  beforeAll(async () => {
    const started = startApiProcess(RATE_LIMITED_ROTATING_KEY_API_PORT, {
      ...process.env,
      NOSTR_AGENT_API_RATE_LIMIT_MAX: "2",
      NOSTR_AGENT_API_RATE_LIMIT_WINDOW_MS: "60000",
    });
    apiProcess = started.process;
    getLogs = started.getLogs;

    await waitForApiReady(RATE_LIMITED_ROTATING_KEY_API_BASE_URL, () => apiProcess, getLogs);
  });

  afterAll(async () => {
    await stopApiProcess(apiProcess);
    apiProcess = undefined;
  });

  test("cannot bypass limits by rotating x-api-key when auth is disabled", async () => {
    const first = await fetch(`${RATE_LIMITED_ROTATING_KEY_API_BASE_URL}/tools`, {
      headers: { "x-api-key": "key-a" },
    });
    const second = await fetch(`${RATE_LIMITED_ROTATING_KEY_API_BASE_URL}/tools`, {
      headers: { "x-api-key": "key-b" },
    });
    const third = await fetch(`${RATE_LIMITED_ROTATING_KEY_API_BASE_URL}/tools`, {
      headers: { "x-api-key": "key-c" },
    });
    const body = await third.json();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
    expect(body?.error?.code).toBe("rate_limited");
  });
});

describeNetwork("API rate limiting ignores spoofed proxy headers by default", () => {
  let apiProcess: ChildProcess | undefined;
  let getLogs = () => "";

  beforeAll(async () => {
    const started = startApiProcess(RATE_LIMITED_SPOOFED_PROXY_API_PORT, {
      ...process.env,
      NOSTR_AGENT_API_RATE_LIMIT_MAX: "2",
      NOSTR_AGENT_API_RATE_LIMIT_WINDOW_MS: "60000",
    });
    apiProcess = started.process;
    getLogs = started.getLogs;

    await waitForApiReady(RATE_LIMITED_SPOOFED_PROXY_API_BASE_URL, () => apiProcess, getLogs);
  });

  afterAll(async () => {
    await stopApiProcess(apiProcess);
    apiProcess = undefined;
  });

  test("cannot bypass limits by rotating x-forwarded-for when trust proxy is disabled", async () => {
    const first = await fetch(`${RATE_LIMITED_SPOOFED_PROXY_API_BASE_URL}/tools`, {
      headers: { "x-forwarded-for": "198.51.100.1" },
    });
    const second = await fetch(`${RATE_LIMITED_SPOOFED_PROXY_API_BASE_URL}/tools`, {
      headers: { "x-forwarded-for": "198.51.100.2" },
    });
    const third = await fetch(`${RATE_LIMITED_SPOOFED_PROXY_API_BASE_URL}/tools`, {
      headers: { "x-forwarded-for": "198.51.100.3" },
    });
    const body = await third.json();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
    expect(body?.error?.code).toBe("rate_limited");
  });
});

describeNetwork("API request body size limits", () => {
  let apiProcess: ChildProcess | undefined;
  let getLogs = () => "";

  beforeAll(async () => {
    const started = startApiProcess(BODY_LIMITED_API_PORT, {
      ...process.env,
      NOSTR_AGENT_API_RATE_LIMIT_MAX: "0",
      NOSTR_AGENT_API_MAX_BODY_BYTES: "64",
    });
    apiProcess = started.process;
    getLogs = started.getLogs;

    await waitForApiReady(BODY_LIMITED_API_BASE_URL, () => apiProcess, getLogs);
  });

  afterAll(async () => {
    await stopApiProcess(apiProcess);
    apiProcess = undefined;
  });

  test("returns 413 when request body exceeds configured max size", async () => {
    const oversizedBody = JSON.stringify({ pubkey: `npub${"x".repeat(256)}` });
    const response = await fetch(`${BODY_LIMITED_API_BASE_URL}/tools/getProfile`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: oversizedBody,
    });
    const body = await response.json();

    expect(response.status).toBe(413);
    expect(body?.error?.code).toBe("payload_too_large");
    expect(body?.error?.details?.maxBodyBytes).toBe(64);
  });
});
