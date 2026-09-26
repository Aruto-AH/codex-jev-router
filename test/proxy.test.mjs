import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startCodexProxy } from "../src/proxy.mjs";
import { AUTO_MODEL } from "../src/catalog.mjs";

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}

test("serves a Jev model entry and rewrites model plus effort while preserving streaming", async () => {
  const received = [];
  const upstream = http.createServer(async (request, response) => {
    if (request.url === "/v1/models") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        models: [
          {
            slug: "gpt-6-luna",
            supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }],
            default_reasoning_level: "medium",
          },
          {
            slug: "gpt-6-sol",
            supported_reasoning_levels: [{ effort: "medium" }, { effort: "high" }, { effort: "max" }],
            default_reasoning_level: "medium",
          },
        ],
      }));
      return;
    }

    received.push(await readJson(request));
    response.setHeader("content-type", "application/octet-stream");
    response.end('event: response.created\ndata: {"type":"response.created"}\n\n');
  });
  const upstreamBase = await listen(upstream);
  const proxy = await startCodexProxy({
    upstreamBaseUrl: `${upstreamBase}/v1`,
    route: async () => ({
      choice: "gpt-6-sol",
      confidence: 0.95,
      metrics: { reasoningRequired: 0.95 },
    }),
  });

  try {
    const firstResponse = await fetch(`http://127.0.0.1:${proxy.port}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: AUTO_MODEL,
        prompt_cache_key: "thread-1",
        input: [
          { type: "additional_tools", tools: [] },
          { role: "user", content: [{ type: "input_text", text: "Implement the authentication flow" }] },
        ],
        reasoning: { effort: "medium" },
      }),
    });
    const firstText = await firstResponse.text();
    assert.equal(received[0].model, "gpt-6-sol");
    assert.equal(received[0].reasoning.effort, "max");
    assert.match(firstText, /🔹 \[Jev\] routed this turn/);
    assert.match(firstText, /\[Jev\] routed this turn to gpt-6-sol/);
    assert.match(firstText, /response\.created/);
    assert.ok(firstText.indexOf("response.created") < firstText.indexOf("[Jev]"));

    const modelsResponse = await fetch(`http://127.0.0.1:${proxy.port}/models`);
    const catalog = await modelsResponse.json();
    assert.equal(catalog.models[0].slug, AUTO_MODEL);

    await fetch(`http://127.0.0.1:${proxy.port}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: AUTO_MODEL,
        prompt_cache_key: "thread-1",
        input: [
          { type: "additional_tools", tools: [] },
          { role: "user", content: [{ type: "input_text", text: "Implement the authentication flow" }] },
          { type: "function_call_output", output: "tool result" },
        ],
        reasoning: { effort: "low" },
      }),
    });
    assert.equal(received[1].model, "gpt-6-sol");
    assert.equal(received[1].reasoning.effort, "max");
  } finally {
    await proxy.close();
    await close(upstream);
  }
});

const turnBody = (key, input = [{ type: "additional_tools", tools: [] }, { role: "user", content: "Route this turn" }]) => ({
  model: AUTO_MODEL, prompt_cache_key: key, input, reasoning: { effort: "low" },
});

async function withProxy({ catalog, route, routeTimeoutMs = 3000, autoEffort = true, shadow }, run) {
  const received = [];
  const upstream = http.createServer(async (request, response) => {
    if (request.url === "/v1/models") {
      if (catalog === null) { response.writeHead(503); response.end(); return; }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ models: catalog.map(([slug, levels]) => ({
        slug, supported_reasoning_levels: levels.map((effort) => ({ effort })),
        default_reasoning_level: levels[0],
      })) }));
      return;
    }
    received.push({ body: await readJson(request), auth: request.headers.authorization });
    response.setHeader("content-type", "text/event-stream");
    response.end('event: response.created\ndata: {"type":"response.created"}\n\n');
  });
  const base = await listen(upstream);
  const proxy = await startCodexProxy({ upstreamBaseUrl: `${base}/v1`, route, routeTimeoutMs, autoEffort, shadow });
  const send = async (body) => fetch(`http://127.0.0.1:${proxy.port}/responses`, {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fake-test-token" },
    body: JSON.stringify(body),
  });
  try { await run({ proxy, received, send }); }
  finally { await proxy.close(); await close(upstream); }
}

const both = [
  ["gpt-6-luna", ["low", "medium"]],
  ["gpt-6-sol", ["medium", "high", "max"]],
  ["gpt-5.6-sol", ["medium"]],
  ["gpt-6-astra", ["high"]],
];

for (const [name, catalog, expected] of [
  ["both", both, ["gpt-6-luna", "gpt-6-sol"]],
  ["Luna only", [both[0], both[2]], ["gpt-6-luna"]],
  ["Sol only", [both[1], both[3]], ["gpt-6-sol"]],
  ["fetch failure", null, ["gpt-6-luna", "gpt-6-sol"]],
]) {
  test(`uses ${name} routing candidates and native supported effort`, async () => {
    let offered;
    await withProxy({ catalog, route: async ({ models }) => {
      offered = models.map((model) => model.id);
      return { choice: expected[0], metrics: { reasoningRequired: 0.95 } };
    } }, async ({ received, send }) => {
      const response = await send(turnBody(`catalog-${name}`));
      assert.equal(response.status, 200);
      assert.deepEqual(offered, expected);
      assert.equal(received[0].body.model, expected[0]);
      assert.equal(received[0].auth, "Bearer fake-test-token");
      assert.equal(received[0].body.reasoning.effort, name === "fetch failure" ? "max" :
        name === "Luna only" || name === "both" ? "medium" : "max");
    });
  });
}

test("a successful native catalog with no allowed models fails explicitly", async () => {
  let called = false;
  await withProxy({ catalog: [both[2], both[3]], route: async () => { called = true; } }, async ({ received, send }) => {
    const response = await send(turnBody("no-candidates"));
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.type, "routing_unavailable");
    assert.equal(received.length, 0);
    assert.equal(called, false);
  });
});

for (const [name, failingRoute] of [
  ["null", async () => null],
  ["throw", async () => { throw new Error("Jev failed"); }],
  ["timeout", async () => new Promise(() => {})],
  ["unknown model", async () => ({ choice: "gpt-6-astra", metrics: { reasoningRequired: 0.9 } })],
  ["malformed answer", async () => ({ choice: "gpt-6-luna" })],
]) {
  test(`Jev ${name} keeps the prior model and effort`, async () => {
    let calls = 0;
    await withProxy({ catalog: both, routeTimeoutMs: 20, route: (input) => {
      calls++;
      return calls === 1
        ? { choice: "gpt-6-luna", metrics: { reasoningRequired: 0.1 } }
        : failingRoute(input);
    } }, async ({ received, send }) => {
      assert.equal((await send(turnBody(`prior-${name}`))).status, 200);
      assert.equal((await send(turnBody(`prior-${name}`))).status, 200);
      assert.deepEqual(received.map(({ body }) => [body.model, body.reasoning.effort]), [
        ["gpt-6-luna", "low"], ["gpt-6-luna", "low"],
      ]);
    });
  });
}

test("first turn with unavailable Jev resolves to native Sol, then Luna when Sol is absent", async () => {
  for (const [catalog, expected, effort] of [[both, "gpt-6-sol", "medium"], [[both[0]], "gpt-6-luna", "low"]]) {
    await withProxy({ catalog, route: async () => null }, async ({ received, send }) => {
      assert.equal((await send(turnBody(`first-${expected}`))).status, 200);
      assert.equal(received[0].body.model, expected);
      assert.equal(received[0].body.reasoning.effort, effort);
    });
  }
});

test("first turn with failed catalog and unavailable Jev resolves to static GPT-6 Sol", async () => {
  await withProxy({ catalog: null, route: async () => null }, async ({ received, send }) => {
    assert.equal((await send(turnBody("first-static"))).status, 200);
    assert.equal(received[0].body.model, "gpt-6-sol");
    assert.equal(received[0].body.reasoning.effort, "low");
  });
});

test("failed catalog uses Codex 0.155.1 fallback capabilities for requested efforts", async () => {
  let offered;
  await withProxy({ catalog: null, autoEffort: false, route: async ({ prompt, models }) => {
    offered = models;
    return { choice: prompt.split(" ")[0] };
  } }, async ({ received, send }) => {
    for (const [model, effort] of [
      ["gpt-6-luna", "xhigh"], ["gpt-6-luna", "max"],
      ["gpt-6-sol", "xhigh"], ["gpt-6-sol", "max"], ["gpt-6-sol", "ultra"],
    ]) {
      const body = turnBody(`static-${model}-${effort}`);
      body.input[1].content = `${model} ${effort}`;
      body.reasoning.effort = effort;
      assert.equal((await send(body)).status, 200);
      assert.deepEqual([received.at(-1).body.model, received.at(-1).body.reasoning.effort], [model, effort]);
    }
    assert.deepEqual(offered, [
      { id: "gpt-6-luna", tier: "fast", supportedEfforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium" },
      { id: "gpt-6-sol", tier: "strong", supportedEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultEffort: "medium" },
    ]);
  });
});

test("successful native capabilities override the static fallback", async () => {
  await withProxy({ catalog: [["gpt-6-sol", ["medium"]]], autoEffort: false,
    route: async ({ models }) => {
      assert.deepEqual(models[0].supportedEfforts, ["medium"]);
      return { choice: "gpt-6-sol" };
    },
  }, async ({ received, send }) => {
    const body = turnBody("native-over-static");
    body.reasoning.effort = "ultra";
    assert.equal((await send(body)).status, 200);
    assert.equal(received[0].body.reasoning.effort, "medium");
  });
});

test("automatic routing still selects low, medium, high, or max with full fallback capabilities", async () => {
  await withProxy({ catalog: null, route: async ({ prompt }) => ({
    choice: prompt.split(" ")[0], metrics: { reasoningRequired: Number(prompt.split(" ")[1]) },
  }) }, async ({ received, send }) => {
    for (const model of ["gpt-6-luna", "gpt-6-sol"]) {
      for (const [score, effort] of [[0.1, "low"], [0.4, "medium"], [0.7, "high"], [1, "max"]]) {
        const body = turnBody(`auto-${model}-${score}`);
        body.input[1].content = `${model} ${score}`;
        assert.equal((await send(body)).status, 200);
        assert.deepEqual([received.at(-1).body.model, received.at(-1).body.reasoning.effort], [model, effort]);
      }
    }
  });
});

test("explicit model passes through without routing", async () => {
  await withProxy({ catalog: both, route: async () => { throw new Error("must not route"); } }, async ({ received, send }) => {
    const response = await send({ ...turnBody("explicit"), model: "gpt-5.6-sol" });
    assert.equal(response.status, 200);
    assert.equal(received[0].body.model, "gpt-5.6-sol");
    assert.equal(received[0].body.reasoning.effort, "low");
  });
});

test("Shadow Mode recommends a candidate while preserving the actual request and continuation", async () => {
  let calls = 0;
  await withProxy({ catalog: both, shadow: true, route: async ({ models }) => {
    calls++;
    assert.deepEqual(models.map((model) => model.id), ["gpt-6-luna", "gpt-6-sol"]);
    return { choice: "gpt-6-luna", metrics: { reasoningRequired: 0.95 } };
  } }, async ({ proxy, received, send }) => {
    const original = { ...turnBody("shadow-thread"), model: "gpt-6-sol", reasoning: { effort: "high" } };
    const response = await send(original);
    assert.equal(response.status, 200);
    const commentary = await response.text();
    assert.deepEqual(received[0].body, original);
    assert.match(commentary, /Jev shadow recommendation: gpt-6-luna \/ medium/);
    assert.match(commentary, /Actual request unchanged: gpt-6-sol \/ high/);
    assert.doesNotMatch(commentary, /Route this turn|fake-test-token/);

    const continuation = {
      ...original,
      input: [...original.input, { type: "function_call_output", output: "tool result" }],
      reasoning: { effort: "low" },
    };
    const continued = await send(continuation);
    assert.equal(continued.status, 200);
    assert.deepEqual(received[1].body, continuation);
    assert.match(await continued.text(), /Jev shadow recommendation: gpt-6-luna \/ medium/);
    assert.equal(calls, 1);

    const models = await (await fetch(`http://127.0.0.1:${proxy.port}/models`)).json();
    assert.equal(models.models.some((model) => model.slug === AUTO_MODEL), false);
  });
});

test("JEV_CODEX_SHADOW=1 enables non-mutating proxy routing", async () => {
  const previous = process.env.JEV_CODEX_SHADOW;
  process.env.JEV_CODEX_SHADOW = "1";
  try {
    await withProxy({ catalog: both, route: async () => ({
      choice: "gpt-6-luna", metrics: { reasoningRequired: 0.1 },
    }) }, async ({ received, send }) => {
      const body = { ...turnBody("shadow-env"), model: "gpt-6-sol", reasoning: { effort: "high" } };
      assert.equal((await send(body)).status, 200);
      assert.deepEqual(received[0].body, body);
    });
  } finally {
    if (previous === undefined) delete process.env.JEV_CODEX_SHADOW;
    else process.env.JEV_CODEX_SHADOW = previous;
  }
});

test("JEV_CODEX_SHADOW=0 keeps normal model and effort rewriting", async () => {
  const previous = process.env.JEV_CODEX_SHADOW;
  process.env.JEV_CODEX_SHADOW = "0";
  try {
    await withProxy({ catalog: both, route: async () => ({
      choice: "gpt-6-sol", metrics: { reasoningRequired: 0.95 },
    }) }, async ({ received, send }) => {
      assert.equal((await send(turnBody("shadow-off"))).status, 200);
      assert.deepEqual([received[0].body.model, received[0].body.reasoning.effort], ["gpt-6-sol", "max"]);
    });
  } finally {
    if (previous === undefined) delete process.env.JEV_CODEX_SHADOW;
    else process.env.JEV_CODEX_SHADOW = previous;
  }
});

test("Shadow Mode preserves absent effort and explicit real models", async () => {
  await withProxy({ catalog: both, shadow: true, route: async () => ({
    choice: "gpt-6-sol", metrics: { reasoningRequired: 0.95 },
  }) }, async ({ received, send }) => {
    for (const [index, reasoning] of [[0, undefined], [1, {}]]) {
      const body = { ...turnBody(`shadow-no-effort-${index}`), model: "gpt-6-astra" };
      if (reasoning) body.reasoning = reasoning;
      else delete body.reasoning;
      const response = await send(body);
      assert.equal(response.status, 200);
      assert.deepEqual(received[index].body, body);
      assert.match(await response.text(), /Actual request unchanged: gpt-6-astra \/ unspecified/);
    }
  });
});

for (const [name, failingRoute] of [
  ["timeout", async () => new Promise(() => {})],
  ["communication failure", async () => Promise.reject(new Error("network failure"))],
  ["throw", () => { throw new Error("Jev failed"); }],
  ["null", async () => null],
  ["malformed answer", async () => ({ choice: "gpt-6-luna" })],
  ["candidate outside catalog", async () => ({ choice: "gpt-6-astra", metrics: { reasoningRequired: 0.9 } })],
]) {
  test(`Shadow Mode forwards unchanged when Jev returns ${name}`, async () => {
    await withProxy({ catalog: both, shadow: true, routeTimeoutMs: 20, route: failingRoute }, async ({ received, send }) => {
      const body = { ...turnBody(`shadow-failure-${name}`), model: "gpt-6-sol", reasoning: { effort: "high" } };
      const response = await send(body);
      assert.equal(response.status, 200);
      assert.deepEqual(received[0].body, body);
      assert.match(await response.text(), /Jev shadow recommendation: unavailable \/ unavailable/);
    });
  });
}

test("Shadow Mode forwards unchanged when the native catalog has no routing candidates", async () => {
  let called = false;
  await withProxy({ catalog: [both[2], both[3]], shadow: true, route: async () => { called = true; } }, async ({ received, send }) => {
    const body = { ...turnBody("shadow-no-candidates"), model: "gpt-6-astra" };
    const response = await send(body);
    assert.equal(response.status, 200);
    assert.deepEqual(received[0].body, body);
    assert.equal(called, false);
  });
});

test("Shadow Mode rejects the virtual model before forwarding upstream", async () => {
  await withProxy({ catalog: both, shadow: true, route: async () => { throw new Error("must not route"); } }, async ({ received, send }) => {
    const response = await send(turnBody("shadow-virtual"));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.type, "shadow_virtual_model");
    assert.equal(received.length, 0);
  });
});
