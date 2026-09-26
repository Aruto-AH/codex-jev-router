import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startCodexProxy } from "../src/proxy.mjs";
import { AUTO_MODEL } from "../src/catalog.mjs";
import { requiresSol, routeGptTurn } from "../src/gpt-policy.mjs";

const catalog = [
  { slug: "gpt-6-luna", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }], default_reasoning_level: "medium" },
  { slug: "gpt-6-sol", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "max" }], default_reasoning_level: "medium" },
];
const body = (key, prompt, model = AUTO_MODEL) => ({ model, prompt_cache_key: key,
  input: [{ type: "additional_tools", tools: [] }, { role: "user", content: prompt }],
  reasoning: { effort: "high" } });

async function fixture({ nativeCatalog = catalog, catalogStatus = 200, ...options }, run) {
  const received = [];
  const upstream = http.createServer(async (req, res) => {
    if (req.url === "/v1/models") {
      if (catalogStatus !== 200) { res.writeHead(catalogStatus); res.end(); return; }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ models: nativeCatalog }));
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.setHeader("content-type", "text/event-stream");
    res.end('event: response.created\ndata: {"type":"response.created"}\n\n');
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const proxy = await startCodexProxy({ upstreamBaseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, ...options });
  const send = async (request) => fetch(`http://127.0.0.1:${proxy.port}/responses`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request),
  });
  try { await run({ send, received, proxy }); }
  finally {
    await proxy.close();
    await new Promise((resolve) => upstream.close(resolve));
  }
}

test("GPT backend is default; explicit Jev backend retains Jev decisions", async () => {
  await fixture({ route: async () => ({ model: "gpt-6-luna", effort: "medium", confidence: 0.9, reason: "Simple" }) },
    async ({ send, received }) => {
      const response = await send(body("default", "Read one file"));
      assert.equal(received[0].model, "gpt-6-luna");
      assert.match(await response.text(), /Backend: gpt/);
    });
  await fixture({ backend: "jev", route: async () => ({ choice: "gpt-6-sol", metrics: { reasoningRequired: 0.9 } }) },
    async ({ send, received }) => {
      const response = await send(body("jev", "Design a system"));
      assert.equal(received[0].model, "gpt-6-sol");
      assert.match(await response.text(), /\[Jev\]/);
    });
});

test("GPT upstream ignores inherited Jev endpoint overrides", async () => {
  const prior = [process.env.JEV_CODEX_API_BASE_URL, process.env.JEV_CODEX_CHATGPT_BASE_URL];
  process.env.JEV_CODEX_API_BASE_URL = "https://example.invalid/api";
  process.env.JEV_CODEX_CHATGPT_BASE_URL = "https://example.invalid/chatgpt";
  const urls = [];
  const proxy = await startCodexProxy({ backend: "gpt", fetchImpl: async (url) => {
    urls.push(url);
    return new Response(JSON.stringify({ models: catalog }), { status: 200, headers: { "content-type": "application/json" } });
  } });
  try {
    await fetch(`http://127.0.0.1:${proxy.port}/models`, { headers: { "chatgpt-account-id": "fake" } });
    assert.deepEqual(urls, ["https://chatgpt.com/backend-api/codex/models"]);
  } finally {
    await proxy.close();
    for (const [name, value] of [["JEV_CODEX_API_BASE_URL", prior[0]], ["JEV_CODEX_CHATGPT_BASE_URL", prior[1]]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

test("GPT effort ignores the Jev-only auto-effort setting", async () => {
  const prior = process.env.JEV_CODEX_AUTO_EFFORT;
  process.env.JEV_CODEX_AUTO_EFFORT = "0";
  try {
    await fixture({ route: async () => ({ model: "gpt-6-luna", effort: "medium", confidence: 0.9, reason: "Read" }) },
      async ({ send, received }) => {
        await send(body("jev-effort-env", "Read a file"));
        assert.equal(received[0].reasoning.effort, "medium");
      });
  } finally {
    if (prior === undefined) delete process.env.JEV_CODEX_AUTO_EFFORT;
    else process.env.JEV_CODEX_AUTO_EFFORT = prior;
  }
});

test("bounded and read tasks select Luna; architecture, debugging, and security floor select Sol", async () => {
  const cases = [
    ["Read package.json and summarize it", "gpt-6-luna"],
    ["Implement a small bounded change to one parser with direct checks", "gpt-6-luna"],
    ["Design the new architecture for authentication", "gpt-6-sol"],
    ["Debug an intermittent failure with unknown cause", "gpt-6-sol"],
    ["Implement security-sensitive authorization checks", "gpt-6-sol"],
  ];
  assert.equal(requiresSol("Explain the word security"), false);
  assert.equal(requiresSol("Read the architecture document"), false);
  assert.equal(requiresSol("Fix a typo in security documentation"), false);
  await fixture({ route: async () => ({ model: "gpt-6-luna", effort: "low", confidence: 0.95, reason: "Simple" }) },
    async ({ send, received }) => {
      for (let i = 0; i < cases.length; i++) await send(body(`policy-${i}`, cases[i][0]));
      assert.deepEqual(received.map((item) => item.model), cases.map((item) => item[1]));
      assert.deepEqual(received.map((item) => item.reasoning.effort), ["low", "low", "high", "high", "high"]);
    });
});

test("low confidence raises to Sol and unsupported effort normalizes to native catalog", async () => {
  await fixture({ route: async () => ({ model: "gpt-6-luna", effort: "max", confidence: 0.4, reason: "Uncertain" }) },
    async ({ send, received }) => {
      await send(body("low-confidence", "Read a file"));
      assert.equal(received[0].model, "gpt-6-sol");
      assert.equal(received[0].reasoning.effort, "max");
    });
  await fixture({ route: async () => ({ model: "gpt-6-luna", effort: "max", confidence: 0.9, reason: "Bounded" }) },
    async ({ send, received }) => {
      await send(body("normalize", "Make a small wording change"));
      assert.equal(received[0].model, "gpt-6-luna");
      assert.equal(received[0].reasoning.effort, "medium");
    });
});

test("GPT fail-open preserves prior route for errors and uses Sol on first virtual turn", async () => {
  for (const failure of [null, { model: "gpt-6-astra", effort: "high", confidence: 0.9 },
    { model: "gpt-6-luna", effort: "ultra", confidence: 0.9 }]) {
    let calls = 0;
    await fixture({ route: async () => ++calls === 1 ?
      { model: "gpt-6-luna", effort: "medium", confidence: 0.9, reason: "Small" } : failure },
    async ({ send, received }) => {
      await send(body("prior", "Read a file"));
      await send(body("prior", "New task"));
      assert.deepEqual(received.map((item) => [item.model, item.reasoning.effort]),
        [["gpt-6-luna", "medium"], ["gpt-6-luna", "medium"]]);
    });
  }
  await fixture({ route: async () => null }, async ({ send, received }) => {
    const response = await send(body("initial-fail", "Read a file"));
    assert.equal(received[0].model, "gpt-6-sol");
    assert.match(await response.text(), /Router fallback: gpt-6-sol/);
  });
});

test("GPT timeout and process failure fail open", async () => {
  for (const route of [async () => new Promise(() => {}), async () => { throw new Error("spawn failed"); }]) {
    await fixture({ route, routeTimeoutMs: 15 }, async ({ send, received }) => {
      const response = await send(body("failure", "Read a file"));
      assert.equal(response.status, 200);
      assert.equal(received[0].model, "gpt-6-sol");
    });
  }
});

test("tool continuation reuses the chosen GPT route; a new user prompt reroutes once", async () => {
  let calls = 0;
  await fixture({ route: async () => {
    calls++;
    return { model: calls === 1 ? "gpt-6-luna" : "gpt-6-sol", effort: "medium", confidence: 0.9, reason: "Task" };
  } }, async ({ send, received }) => {
    const first = body("thread", "Read a file");
    await send(first);
    await send(first); // retry of the same user-turn request
    await send({ ...first, input: [...first.input, { type: "function_call_output", output: "done" }] });
    await send(body("thread", "Implement a new architecture"));
    assert.equal(calls, 2);
    assert.deepEqual(received.map((item) => item.model), ["gpt-6-luna", "gpt-6-luna", "gpt-6-luna", "gpt-6-sol"]);
  });
});

test("concurrent retries of one GPT user turn share one classifier run", async () => {
  let calls = 0;
  await fixture({ route: async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { model: "gpt-6-luna", effort: "medium", confidence: 0.9, reason: "Read" };
  } }, async ({ send, received }) => {
    const request = body("concurrent", "Read a file");
    const responses = await Promise.all([send(request), send(request)]);
    assert.deepEqual(responses.map((response) => response.status), [200, 200]);
    assert.equal(calls, 1);
    assert.deepEqual(received.map((item) => item.model), ["gpt-6-luna", "gpt-6-luna"]);
    await send(request);
    assert.equal(calls, 1);
    assert.equal(received[2].model, "gpt-6-luna");
  });
});

test("retries and multiple tool continuations reuse one settled classifier route", async () => {
  let calls = 0;
  await fixture({ route: async () => {
    calls++;
    return { model: "gpt-6-luna", effort: "medium", confidence: 0.9, reason: "Read" };
  } }, async ({ send, received }) => {
    const first = body("many-continuations", "Read a file");
    await send(first);
    await send(first);
    for (const output of ["one", "two", "three"]) {
      const response = await send({ ...first, input: [...first.input,
        { type: "function_call_output", output }] });
      assert.match(await response.text(), /Router recommendation: gpt-6-luna/);
    }
    assert.equal(calls, 1);
    assert.deepEqual(received.map((item) => item.model), Array(5).fill("gpt-6-luna"));
  });
});

test("applied route metadata follows Luna and Sol without extra classification", async () => {
  for (const [model, effort] of [["gpt-6-luna", "medium"], ["gpt-6-sol", "high"]]) {
    let calls = 0;
    await fixture({ route: async () => {
      calls++;
      return { model, effort, confidence: 0.9, reason: "Read" };
    } }, async ({ send, received, proxy }) => {
      const first = body(`applied-${model}`, "Read a file");
      await send(first);
      await send(first);
      await send({ ...first, input: [...first.input,
        { type: "function_call_output", output: "done" }] });
      assert.equal(calls, 1);
      assert.deepEqual(proxy.getLastAppliedRoute(), { model, effort });
      assert.deepEqual(received.map((item) => [item.model, item.reasoning.effort]),
        Array(3).fill(null).map(() => [model, effort]));
    });
  }
});

test("timeout settles fallback once and ignores a late classifier result", async () => {
  let calls = 0;
  let resolveLate;
  await fixture({ routeTimeoutMs: 10, route: () => {
    calls++;
    return new Promise((resolve) => { resolveLate = resolve; });
  } }, async ({ send, received }) => {
    const first = body("timeout-retry", "Read a file");
    await send(first);
    await send(first);
    await send({ ...first, input: [...first.input, { type: "function_call_output", output: "done" }] });
    resolveLate({ model: "gpt-6-luna", effort: "low", confidence: 0.9, reason: "Late" });
    await Promise.resolve();
    await send(first);
    assert.equal(calls, 1);
    assert.deepEqual(received.map((item) => item.model), Array(4).fill("gpt-6-sol"));
  });
});

test("an older turn finishing late cannot overwrite the newer turn route", async () => {
  let resolveOld;
  let oldStarted;
  const started = new Promise((resolve) => { oldStarted = resolve; });
  let calls = 0;
  await fixture({ route: ({ prompt }) => {
    calls++;
    if (prompt === "Old task") {
      oldStarted();
      return new Promise((resolve) => { resolveOld = resolve; });
    }
    return { model: "gpt-6-sol", effort: "high", confidence: 0.9, reason: "New" };
  } }, async ({ send, received }) => {
    const old = body("out-of-order", "Old task");
    const newer = body("out-of-order", "New task");
    const oldResponse = send(old);
    await started;
    await send(newer);
    resolveOld({ model: "gpt-6-luna", effort: "low", confidence: 0.9, reason: "Old" });
    await oldResponse;
    await send(newer);
    await send({ ...newer, input: [...newer.input, { type: "function_call_output", output: "done" }] });
    assert.equal(calls, 2);
    assert.deepEqual(received.map((item) => item.model),
      ["gpt-6-sol", "gpt-6-luna", "gpt-6-sol", "gpt-6-sol"]);
  });
});

test("native supported_in_api=false models are excluded from GPT routing", async () => {
  let calls = 0;
  const nativeCatalog = [{ ...catalog[0], supported_in_api: false }, catalog[1]];
  await fixture({ nativeCatalog, route: ({ models }) => {
    calls++;
    assert.deepEqual(models.map((model) => model.id), ["gpt-6-sol"]);
    return { model: "gpt-6-sol", effort: "high", confidence: 0.9, reason: "Only choice" };
  } }, async ({ send, received }) => {
    await send(body("unsupported-luna", "Read a file"));
    assert.equal(calls, 1);
    assert.equal(received[0].model, "gpt-6-sol");
  });
});

test("successful native catalog with no supported GPT candidates returns 503", async () => {
  let calls = 0;
  await fixture({ nativeCatalog: catalog.map((model) => ({ ...model, supported_in_api: false })),
    route: async () => { calls++; } }, async ({ send, received }) => {
    const response = await send(body("none-supported", "Read a file"));
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.type, "routing_unavailable");
    assert.equal(calls, 0);
    assert.equal(received.length, 0);
  });
});

test("failed native catalog keeps static GPT-6 Luna and Sol fallback", async () => {
  await fixture({ catalogStatus: 503, route: ({ models }) => {
    assert.deepEqual(models.map((model) => model.id), ["gpt-6-luna", "gpt-6-sol"]);
    return { model: "gpt-6-luna", effort: "low", confidence: 0.9, reason: "Read" };
  } }, async ({ send, received }) => {
    assert.equal((await send(body("catalog-failure", "Read a file"))).status, 200);
    assert.equal(received[0].model, "gpt-6-luna");
  });
});

test("GPT Shadow Mode leaves actual request unchanged and shows recommendation", async () => {
  await fixture({ shadow: true, route: async () => ({ model: "gpt-6-luna", effort: "medium", confidence: 0.9, reason: "Small" }) },
    async ({ send, received, proxy }) => {
      const original = body("shadow", "Read a file", "gpt-6-sol");
      const response = await send(original);
      assert.deepEqual(received[0], original);
      const text = await response.text();
      assert.match(text, /Router recommendation: gpt-6-luna \/ medium/);
      assert.match(text, /Actual request unchanged: gpt-6-sol \/ high/);
      assert.match(text, /Backend: gpt/);
      assert.deepEqual(proxy.getLastAppliedRoute(), { model: "gpt-6-sol", effort: "high" });
    });
});

test("repeated Shadow recommendation events do not rerun the classifier", async () => {
  let calls = 0;
  await fixture({ shadow: true, route: async () => {
    calls++;
    return { model: "gpt-6-luna", effort: "medium", confidence: 0.9, reason: "Read" };
  } }, async ({ send, received }) => {
    const first = body("shadow-continuations", "Read a file", "gpt-6-sol");
    const requests = [first, first, ...["one", "two", "three"].map((output) => ({
      ...first, input: [...first.input, { type: "function_call_output", output }],
    }))];
    for (const request of requests) {
      const response = await send(request);
      assert.match(await response.text(), /Router recommendation: gpt-6-luna/);
    }
    assert.equal(calls, 1);
    assert.deepEqual(received, requests);
  });
});

test("CODEX_ROUTER_SHADOW enables GPT Shadow Mode by environment", async () => {
  const prior = process.env.CODEX_ROUTER_SHADOW;
  process.env.CODEX_ROUTER_SHADOW = "1";
  try {
    await fixture({ route: async () => ({ model: "gpt-6-luna", effort: "low", confidence: 0.9, reason: "Read" }) },
      async ({ send, received }) => {
        const original = body("shadow-env-gpt", "Read a file", "gpt-6-sol");
        const response = await send(original);
        assert.deepEqual(received[0], original);
        assert.match(await response.text(), /Backend: gpt/);
      });
  } finally {
    if (prior === undefined) delete process.env.CODEX_ROUTER_SHADOW;
    else process.env.CODEX_ROUTER_SHADOW = prior;
  }
});

test("explicit real model bypasses GPT classification and rewrite", async () => {
  let calls = 0;
  await fixture({ route: async () => { calls++; return null; } }, async ({ send, received }) => {
    const original = body("explicit", "Design architecture", "gpt-6-sol");
    await send(original);
    assert.equal(calls, 0);
    assert.deepEqual(received[0], original);
  });
});

test("recursion guard prevents classification in a proxy already entered by classifier", async () => {
  const prior = process.env.CODEX_ROUTER_CLASSIFIER;
  process.env.CODEX_ROUTER_CLASSIFIER = "1";
  try {
    let calls = 0;
    await fixture({ route: async () => { calls++; return null; } }, async ({ send, received }) => {
      await send(body("guard", "Read a file"));
      assert.equal(calls, 0);
      assert.equal(received[0].model, "gpt-6-sol");
    });
  } finally {
    if (prior === undefined) delete process.env.CODEX_ROUTER_CLASSIFIER;
    else process.env.CODEX_ROUTER_CLASSIFIER = prior;
  }
});
