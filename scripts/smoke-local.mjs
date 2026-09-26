import assert from "node:assert/strict";
import http from "node:http";
import { startCodexProxy } from "../src/proxy.mjs";

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

  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  assert.equal(body.model, "gpt-6-sol");
  assert.equal(body.reasoning.effort, "high");
  response.setHeader("content-type", "text/event-stream");
  response.end('event: response.created\ndata: {"type":"response.created"}\n\n');
});

await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const upstreamAddress = upstream.address();
const proxy = await startCodexProxy({
  upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
  route: async ({ models }) => {
    assert.deepEqual(models.map((model) => model.id), ["gpt-6-luna", "gpt-6-sol"]);
    return { choice: "gpt-6-sol", confidence: 0.9, metrics: { reasoningRequired: 0.75 } };
  },
});

try {
  const response = await fetch(`http://127.0.0.1:${proxy.port}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "jev-router",
      prompt_cache_key: "smoke",
      input: [
        { type: "additional_tools", tools: [] },
        { role: "user", content: [{ type: "input_text", text: "Run the local smoke test" }] },
      ],
      reasoning: { effort: "medium" },
    }),
  });
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.match(text, /\[Jev\] routed this turn to gpt-6-sol/);
  console.log("local bridge smoke passed");
} finally {
  await proxy.close();
  await new Promise((resolve, reject) => upstream.close((error) => (error ? reject(error) : resolve())));
}
