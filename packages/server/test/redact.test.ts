import { describe, expect, test } from "bun:test";
import { REDACTED, redact } from "../src/redact.ts";

function expectRedacted(input: string, secret: string, keep: string[]) {
  const out = redact(input);
  expect(out).not.toContain(secret);
  expect(out).toContain(REDACTED);
  for (const text of keep) expect(out).toContain(text);
}

describe("redact patterns", () => {
  test("sk- keys, including Anthropic style", () => {
    const openai = "sk-FAKEFAKEFAKEFAKEFAKE1234";
    const anthropic = "sk-ant-api03-FAKEFAKEFAKEFAKE_fake-key0000";
    expectRedacted(`use ${openai} for the call`, openai, ["use ", " for the call"]);
    expectRedacted(`key is ${anthropic}.`, anthropic, ["key is "]);
  });

  test("GitHub tokens", () => {
    for (const prefix of ["ghp_", "gho_", "ghs_", "ghu_"]) {
      const token = `${prefix}FAKEFAKEFAKEFAKEFAKE12345678`;
      expectRedacted(`clone with ${token} now`, token, ["clone with ", " now"]);
    }
    const pat = "github_pat_FAKEFAKEFAKEFAKE_FAKEFAKEFAKE0000";
    expectRedacted(`pat ${pat} end`, pat, ["pat ", " end"]);
  });

  test("AWS access key ids", () => {
    for (const id of ["AKIAFAKEFAKEFAKE1234", "ASIAFAKEFAKEFAKE1234"]) {
      expectRedacted(`aws id ${id} in config`, id, ["aws id ", " in config"]);
    }
  });

  test("JWTs", () => {
    const jwt = "eyJhbGciOiJGQUtFIn0.eyJzdWIiOiJmYWtlIn0.ZmFrZXNpZ25hdHVyZQ";
    expectRedacted(`token was ${jwt} ok`, jwt, ["token was ", " ok"]);
  });

  test("PEM blocks", () => {
    const body = "FAKEKEYBODYFAKEKEYBODY0000";
    const pem = `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
    expectRedacted(`before\n${pem}\nafter`, body, ["before\n", "\nafter"]);
  });

  test("truncated private key", () => {
    const body = "FAKEKEYBODYFAKEKEYBODY0000";
    expectRedacted(`before\n-----BEGIN RSA PRIVATE KEY-----\n${body}\n${body}`, body, ["before\n"]);
  });

  test("Authorization header values", () => {
    expectRedacted("Authorization: Basic ZmFrZTpmYWtl\nHost: x", "ZmFrZTpmYWtl", ["Authorization: Basic", "Host: x"]);
    expectRedacted("curl -H 'Authorization: Bearer fake-token-value-0000' url", "fake-token-value-0000", [
      "curl -H 'Authorization: Bearer",
    ]);
  });

  test("Bearer tokens", () => {
    const token = "fakefakefakefakefake0000";
    expectRedacted(`header Bearer ${token} sent`, token, ["header Bearer ", " sent"]);
  });

  test("password, token, secret and api_key assignments with =", () => {
    expectRedacted("export PASSWORD=hunter2fake ok", "hunter2fake", ["export PASSWORD=", " ok"]);
    expectRedacted("token=abcfake123 next", "abcfake123", ["token=", " next"]);
    expectRedacted('client_secret = "fakesecretvalue" end', "fakesecretvalue", ["client_secret = ", " end"]);
    expectRedacted("api_key='fakekeyvalue1'", "fakekeyvalue1", ["api_key="]);
    expectRedacted("API-KEY=fakekeyvalue2 x", "fakekeyvalue2", [" x"]);
  });

  test("assignments with :", () => {
    expectRedacted("password: fakepassword123 done", "fakepassword123", ["password: ", " done"]);
    expectRedacted('{"api_key": "fakekeyvalue"}', "fakekeyvalue", ['{"api_key": ']);
    expectRedacted("secret: 'fake secret'", "fake secret", ["secret: "]);
    expectRedacted("token: fake-token-value-99, more", "fake-token-value-99", [", more"]);
  });

  test("--password flag form", () => {
    expectRedacted("mysql --password fakepass1 -u root", "fakepass1", ["mysql --password ", " -u root"]);
    expectRedacted("mysql --password=fakepass2 -u root", "fakepass2", ["mysql --password=", " -u root"]);
    expectRedacted("tool --api-key fakekey3 run", "fakekey3", [" run"]);
  });

  test("URL credentials", () => {
    expectRedacted("git clone https://user:fakepw123@example.com/repo.git", "fakepw123", [
      "https://",
      "@example.com/repo.git",
    ]);
    expectRedacted("postgres://admin:fakepw456@db:5432/app", "fakepw456", ["@db:5432/app"]);
  });
});

describe("redact leaves ordinary text alone", () => {
  const unchanged = [
    "the token: it expired",
    "commit 4b825dc642cb6eb9a060e54bf8d69288fbee4904 fixed it",
    "id 123e4567-e89b-12d3-a456-426614174000 here",
    "if (a == b) return a === b",
    "const f = (x) => x + 1; const token => 3",
    "see https://example.com/path?x=1 and user@example.com",
  ];
  for (const text of unchanged) {
    test(text, () => expect(redact(text)).toBe(text));
  }
});

describe("redact is idempotent", () => {
  test("second pass changes nothing", () => {
    const text = [
      "Authorization: Bearer fake-token-value-0000",
      "password=hunter2fake token: fakepassword123 --password fakepass1",
      "https://user:fakepw123@example.com sk-FAKEFAKEFAKEFAKEFAKE1234",
      "-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----",
    ].join("\n");
    const once = redact(text);
    expect(redact(once)).toBe(once);
  });
});
