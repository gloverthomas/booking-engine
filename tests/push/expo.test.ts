import { describe, expect, test, vi } from "vitest";
import { EXPO_PUSH_URL, createExpoSender, isExpoToken, type PushMessage } from "@/server/push/expo";

const msg = (n: number): PushMessage => ({
  to: `ExponentPushToken[t${n}]`,
  title: "New booking",
  body: "Sam · Cut",
  data: { bookingId: `b${n}` },
});

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("isExpoToken", () => {
  test.each(["ExponentPushToken[abc-123]", "ExpoPushToken[xyz]"])("accepts %s", (t) =>
    expect(isExpoToken(t)).toBe(true),
  );
  test.each([
    "",
    "abc",
    "ExponentPushToken[]",
    "ExponentPushToken[a b]",
    "fcm:APA91b",
    "ExponentPushToken[a]x",
  ])("rejects %j", (t) => expect(isExpoToken(t)).toBe(false));
});

describe("createExpoSender", () => {
  test("posts the messages with sound and priority, and maps the tickets", async () => {
    const fetchMock = vi.fn(async () =>
      reply({
        data: [
          { status: "ok", id: "1" },
          { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } },
        ],
      }),
    );
    const sender = createExpoSender({ fetch: fetchMock as unknown as typeof fetch });
    const tickets = await sender.send([msg(1), msg(2)]);

    expect(tickets).toEqual([
      { status: "ok" },
      { status: "error", message: "gone", error: "DeviceNotRegistered" },
    ]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(EXPO_PUSH_URL);
    const sent = JSON.parse(String(init.body));
    expect(sent[0]).toMatchObject({
      to: "ExponentPushToken[t1]",
      sound: "default",
      priority: "high",
      data: { bookingId: "b1" },
    });
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  test("sends the access token when one is configured", async () => {
    const fetchMock = vi.fn(async () => reply({ data: [{ status: "ok" }] }));
    await createExpoSender({
      accessToken: "secret",
      fetch: fetchMock as unknown as typeof fetch,
    }).send([msg(1)]);
    const init = fetchMock.mock.calls[0][1] as unknown as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret");
  });

  test("splits more than 100 messages into batches and keeps their order", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const batch = JSON.parse(String(init.body)) as unknown[];
      return reply({ data: batch.map(() => ({ status: "ok" })) });
    });
    const tickets = await createExpoSender({ fetch: fetchMock as unknown as typeof fetch }).send(
      Array.from({ length: 250 }, (_, i) => msg(i)),
    );
    expect(tickets).toHaveLength(250);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(fetchMock.mock.calls[2][1].body))).toHaveLength(50);
  });

  test("an unreachable or unhappy service throws, so the job is retried", async () => {
    const down = createExpoSender({
      fetch: (async () => reply({}, 503)) as unknown as typeof fetch,
    });
    await expect(down.send([msg(1)])).rejects.toThrow("503");
    const wrongCount = createExpoSender({
      fetch: (async () => reply({ data: [] })) as unknown as typeof fetch,
    });
    await expect(wrongCount.send([msg(1)])).rejects.toThrow("unexpected number");
    const offline = createExpoSender({
      fetch: (async () => {
        throw new TypeError("offline");
      }) as unknown as typeof fetch,
    });
    await expect(offline.send([msg(1)])).rejects.toThrow("offline");
  });

  test("no messages means no request", async () => {
    const fetchMock = vi.fn();
    expect(
      await createExpoSender({ fetch: fetchMock as unknown as typeof fetch }).send([]),
    ).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
