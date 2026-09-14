// JD spend proxy handler tests cover the upstream spend scaling contract.
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getRuntimeConfig } = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", () => ({
  getRuntimeConfig,
}));

import { handleJdSpendRequest } from "./handler.js";

type CapturedResponse = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
};

function createRequest(url: string): IncomingMessage {
  return { method: "GET", url } as unknown as IncomingMessage;
}

function createResponse() {
  const captured: CapturedResponse = {
    statusCode: 200,
    headers: {},
    body: "",
  };
  const res = {
    get statusCode() {
      return captured.statusCode;
    },
    set statusCode(value: number) {
      captured.statusCode = value;
    },
    setHeader(name: string, value: string) {
      captured.headers[name.toLowerCase()] = value;
    },
    end(chunk: string) {
      captured.body = chunk;
    },
  } as unknown as ServerResponse;
  return { captured, res };
}

function mockJdProviderConfig(): void {
  getRuntimeConfig.mockReturnValue({
    models: {
      providers: {
        "jd-llm": {
          apiKey: "jd-key",
          baseUrl: "https://gcs.example.com/v1",
        },
      },
    },
  } as never);
}

function mockUpstreamSpend(spend: unknown, keyInfo?: { balance: number }, status = 200): void {
  const json: Record<string, unknown> = { spend };
  if (keyInfo !== undefined) {
    json["key"] = keyInfo;
  }
  const fetchMock = vi.fn().mockResolvedValue({
    status,
    ok: status >= 200 && status < 300,
    json: async () => json,
  } as unknown as Response);
  vi.stubGlobal("fetch", fetchMock);
}

async function invoke(url: string) {
  const { captured, res } = createResponse();
  await handleJdSpendRequest(createRequest(url), res);
  return captured;
}

describe("jd spend proxy handler", () => {
  beforeEach(() => {
    getRuntimeConfig.mockReset();
    mockJdProviderConfig();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("scales an 8-decimal upstream spend without float tail error", async () => {
    mockUpstreamSpend(0.163944);

    const captured = await invoke("/api/v1/jd/spend/chatcmpl-cceaa009-a263-9020-9bd7-b1d9261c7994");

    expect(captured.statusCode).toBe(200);
    expect(JSON.parse(captured.body)).toEqual({ ok: true, spend: 163.94, balance: null });
    expect(captured.body).toContain('"spend":163.94');
  });

  it("preserves all 8 upstream fractional digits across the ×1000 scale", async () => {
    mockUpstreamSpend(0.12345678);

    const captured = await invoke("/api/v1/jd/spend/chatcmpl-abc");

    expect(JSON.parse(captured.body)).toEqual({ ok: true, spend: 123.46, balance: null });
  });

  it("keeps whole-number spend values exact after scaling", async () => {
    mockUpstreamSpend(1);

    const captured = await invoke("/api/v1/jd/spend/chatcmpl-abc");

    expect(JSON.parse(captured.body)).toEqual({ ok: true, spend: 1000, balance: null });
  });

  it("returns balance directly from upstream key.balance, scaled ×1000", async () => {
    // 上游已返回最终 balance，直接取用并 ×1000：1.920226 × 1000 = 1920.23
    mockUpstreamSpend(0.21847, { balance: 1.920226 });

    const captured = await invoke("/api/v1/jd/spend/chatcmpl-abc");

    expect(captured.statusCode).toBe(200);
    expect(JSON.parse(captured.body)).toEqual({ ok: true, spend: 218.47, balance: 1920.23 });
  });

  it("returns balance as null when upstream key.balance is absent", async () => {
    mockUpstreamSpend(0.1, {});

    const captured = await invoke("/api/v1/jd/spend/chatcmpl-abc");

    expect(JSON.parse(captured.body)).toMatchObject({ ok: true, balance: null });
  });

  it("overrides the first-call balance with the second-call (extra fetch) value", async () => {
    // 第一次 fetch：上游 balance 还没把当次消费累加进来（"上一轮"旧值）
    // 第二次 fetch（同 URL，等价于"前端额外请求一次"）：balance 已是扣费后的实时值
    const json: Record<string, unknown> = { spend: 0.21847, key: { balance: 100.0 } };
    const updatedJson: Record<string, unknown> = { spend: 0.21847, key: { balance: 95.78153 } };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: async () => json,
      } as unknown as Response)
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: async () => updatedJson,
      } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    const captured = await invoke("/api/v1/jd/spend/chatcmpl-abc");

    expect(captured.statusCode).toBe(200);
    expect(JSON.parse(captured.body)).toEqual({ ok: true, spend: 218.47, balance: 95781.53 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
