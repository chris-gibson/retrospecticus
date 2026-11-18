import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import nodemailer from "nodemailer";
import { openDb } from "../src/db/index.ts";
import { enqueueAlert, listAlerts } from "../src/db/alerts.ts";
import { createDispatcher } from "../src/notifiers/dispatcher.ts";
import { discordNotifier } from "../src/notifiers/discord.ts";
import { emailNotifier } from "../src/notifiers/email.ts";
import { buildNotifiers } from "../src/notifiers/registry.ts";
import type { Alert, Notifier } from "../src/notifiers/types.ts";

let logSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  logSpy.mockRestore();
});

const alert = (over: Partial<Alert> = {}): Alert => ({
  kind: "drift",
  severity: "breaking",
  title: "Shape changed",
  body: "details",
  dedupeKey: `k-${Math.random()}`,
  ...over,
});


describe("discord", () => {
  let posts: { content: string }[];
  let status: number;
  let server: ReturnType<typeof Bun.serve>;
  beforeEach(() => {
    posts = [];
    status = 204;
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        posts.push((await req.json()) as { content: string });
        return new Response(null, { status });
      },
    });
  });
  afterEach(() => server.stop(true));

  const make = () => discordNotifier({}, (name) => (name === "discord_webhook_url" ? `${server.url}hook` : undefined));

  test("posts one message for a single alert", async () => {
    await make().send([alert()]);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.content).toContain("Shape changed");
    expect(posts[0]!.content).toContain("details");
  });

  test("posts one digest message for several alerts", async () => {
    await make().send([alert({ title: "A" }), alert({ title: "B" })]);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.content).toContain("digest (2 alerts)");
    expect(posts[0]!.content).toContain("A");
    expect(posts[0]!.content).toContain("B");
  });

  test("truncates to 2000 characters", async () => {
    await make().send([alert({ body: "x".repeat(5000) })]);
    expect(posts[0]!.content).toHaveLength(2000);
    expect(posts[0]!.content.endsWith("…")).toBe(true);
  });

  test("a missing webhook secret fails the send, not the build, and names the secret", async () => {
    const notifier = discordNotifier({}, () => undefined);
    await expect(notifier.send([alert()])).rejects.toThrow(/secrets set discord_webhook_url/);
    expect(posts).toHaveLength(0);
  });

  test("throws on a non-2xx response", async () => {
    status = 500;
    await expect(make().send([alert()])).rejects.toThrow("500");
  });
});

describe("email", () => {
  const config = () => ({ from: "a@example.com", to: ["b@example.com", "c@example.com"] });
  const sendVia = async (alerts: Alert[]) => {
    const transport = nodemailer.createTransport({ jsonTransport: true });
    const sent: { from: string; to: string[]; subject: string; text: string }[] = [];
    const spy = {
      async sendMail(m: (typeof sent)[number]) {
        sent.push(m);
        return transport.sendMail(m);
      },
    };
    await emailNotifier(config(), () => "smtp://x", spy).send(alerts);
    return sent;
  };

  test("uses the alert title as subject for one alert", async () => {
    const [m] = await sendVia([alert()]);
    expect(m!.subject).toBe("Shape changed");
    expect(m!.from).toBe("a@example.com");
    expect(m!.to).toEqual(["b@example.com", "c@example.com"]);
    expect(m!.text).toContain("details");
  });

  test("without a transport a missing smtp_url secret fails the send, naming the secret", async () => {
    await expect(emailNotifier(config()).send([alert()])).rejects.toThrow(/secrets set smtp_url/);
  });

  test("sends a digest for several alerts", async () => {
    const [m] = await sendVia([alert({ title: "A" }), alert({ title: "B" })]);
    expect(m!.subject).toBe("Retrospecticus digest (2 alerts)");
    expect(m!.text).toContain("A");
    expect(m!.text).toContain("B");
  });
});

describe("registry", () => {
  test("always includes log", () => {
    expect(buildNotifiers({}).map((n) => n.name)).toEqual(["log"]);
  });

  test("rejects an unknown key, naming it", () => {
    expect(() => buildNotifiers({ pager: {} })).toThrow("pager");
  });

  test("rejects an invalid config, naming the key", () => {
    expect(() => buildNotifiers({ discord: { webhook_url_file: "/x" } })).toThrow("discord");
    expect(() => buildNotifiers({ email: { from: "a" } })).toThrow("email");
  });

  test("builds configured notifiers", () => {
    const names = buildNotifiers({ discord: {} }).map((n) => n.name);
    expect(names).toEqual(["log", "discord"]);
  });
});

describe("dispatcher", () => {
  function recorder(name: string, fail = false) {
    const calls: Alert[][] = [];
    const notifier: Notifier = {
      name,
      async send(alerts) {
        calls.push(alerts);
        if (fail) throw new Error(`${name} down`);
      },
    };
    return { notifier, calls };
  }
  const opts = { digestHour: 8, retryDelaysMs: [1, 1] };

  test("sends breaking at once; info waits for the digest hour and goes once per day", async () => {
    const db = openDb(":memory:");
    const r = recorder("a");
    let now = new Date(2026, 0, 5, 3, 0);
    const d = createDispatcher({ db, notifiers: [r.notifier], now: () => now, ...opts });
    enqueueAlert(db, alert({ severity: "breaking", dedupeKey: "b" }));
    enqueueAlert(db, alert({ severity: "info", dedupeKey: "i1" }));
    await d.tick();
    expect(r.calls.map((c) => c.map((a) => a.dedupeKey))).toEqual([["b"]]);

    now = new Date(2026, 0, 5, 8, 0);
    await d.tick();
    expect(r.calls).toHaveLength(2);
    expect(r.calls[1]!.map((a) => a.dedupeKey)).toEqual(["i1"]);

    enqueueAlert(db, alert({ severity: "info", dedupeKey: "i2" }));
    now = new Date(2026, 0, 5, 8, 30);
    await d.tick();
    expect(r.calls).toHaveLength(2);

    now = new Date(2026, 0, 6, 8, 0);
    await d.tick();
    expect(r.calls).toHaveLength(3);
    expect(listAlerts(db).every((row) => row.sent_at !== null)).toBe(true);
  });

  test("a throwing adapter does not stop the others and the row is marked sent", async () => {
    const db = openDb(":memory:");
    const bad = recorder("bad", true);
    const good = recorder("good");
    const d = createDispatcher({ db, notifiers: [bad.notifier, good.notifier], ...opts });
    enqueueAlert(db, alert());
    await d.tick();
    expect(good.calls).toHaveLength(1);
    const [row] = listAlerts(db);
    expect(row!.sent_at).not.toBeNull();
    expect(row!.attempts).toBe(1);
  });

  test("when every adapter fails the row stays pending and attempts grows", async () => {
    const db = openDb(":memory:");
    const bad = recorder("bad", true);
    const d = createDispatcher({ db, notifiers: [bad.notifier], ...opts });
    enqueueAlert(db, alert());
    await d.tick();
    await d.tick();
    const [row] = listAlerts(db);
    expect(row!.sent_at).toBeNull();
    expect(row!.attempts).toBe(2);
  });

  test("retries a failing adapter with the configured delays", async () => {
    const db = openDb(":memory:");
    let calls = 0;
    const flaky: Notifier = {
      name: "flaky",
      async send() {
        if (++calls < 3) throw new Error("no");
      },
    };
    const d = createDispatcher({ db, notifiers: [flaky], ...opts });
    enqueueAlert(db, alert());
    await d.tick();
    expect(calls).toBe(3);
    expect(listAlerts(db)[0]!.sent_at).not.toBeNull();
  });

  test("sendTest reports per adapter and bypasses the outbox", async () => {
    const db = openDb(":memory:");
    const good = recorder("good");
    const bad = recorder("bad", true);
    const results = await createDispatcher({ db, notifiers: [good.notifier, bad.notifier], ...opts }).sendTest();
    expect(results).toEqual([
      { name: "good", ok: true },
      { name: "bad", ok: false, error: "bad down" },
    ]);
    expect(good.calls[0]![0]!.title).toBe("Retrospecticus test alert");
    expect(listAlerts(db)).toHaveLength(0);
  });

  test("start runs ticks and stop waits for them", async () => {
    const db = openDb(":memory:");
    const r = recorder("a");
    const d = createDispatcher({ db, notifiers: [r.notifier], intervalMs: 5, ...opts });
    enqueueAlert(db, alert());
    d.start();
    await Bun.sleep(40);
    await d.stop();
    expect(r.calls).toHaveLength(1);
  });
});
