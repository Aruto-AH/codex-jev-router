import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { MAX_REQUEST_BODY_BYTES, startCodexProxy } from "../src/proxy.mjs";

const testLimit = 1024;
const baseBody = JSON.stringify({
  model: "jev-router", prompt_cache_key: "body-limit",
  input: [{ type: "additional_tools", tools: [] }, { role: "user", content: "Read a file" }],
  reasoning: { effort: "medium" },
});
const paddedBody = (bytes) => baseBody + " ".repeat(bytes - Buffer.byteLength(baseBody));

async function withProxy(run) {
  const received = [];
  let classifierCalls = 0;
  let upstreamCalls = 0;
  const upstream = http.createServer(async (request, response) => {
    upstreamCalls++;
    if (request.url === "/v1/models") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ models: [
        { slug: "gpt-6-luna", supported_reasoning_levels: ["medium"] },
        { slug: "gpt-6-sol", supported_reasoning_levels: ["high"] },
      ] }));
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.setHeader("content-type", "text/event-stream");
    response.end('event: response.created\ndata: {"type":"response.created"}\n\n');
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const proxy = await startCodexProxy({ maxRequestBodyBytes: testLimit,
    upstreamBaseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
    route: async () => {
      classifierCalls++;
      return { model: "gpt-6-luna", effort: "medium", confidence: 0.9, reason: "Read" };
    } });
  const url = `http://127.0.0.1:${proxy.port}/responses`;
  try {
    await run({ url, received, proxy,
      counts: () => ({ classifierCalls, upstreamCalls }) });
  } finally {
    await proxy.close();
    await new Promise((resolve) => upstream.close(resolve));
  }
}

async function post(url, body) {
  return fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
}

function postWithoutFinishing(url, { contentLength, chunk }) {
  return new Promise((resolve, reject) => {
    const headers = { "content-type": "application/json" };
    if (contentLength !== undefined) headers["content-length"] = contentLength;
    const request = http.request(url, { method: "POST", headers }, (response) => {
      const chunks = [];
      response.on("data", (part) => chunks.push(part));
      response.on("end", () => {
        clearTimeout(timeout);
        resolve({ status: response.statusCode, headers: response.headers,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")), socketClosed });
      });
    });
    const socketClosed = new Promise((closed) => {
      request.on("socket", (socket) => socket.once("close", closed));
    });
    const timeout = setTimeout(() => {
      request.destroy();
      reject(new Error("Oversized request did not receive an early response"));
    }, 2000);
    request.on("error", (error) => { clearTimeout(timeout); reject(error); });
    request.flushHeaders();
    if (chunk !== undefined) request.write(chunk);
  });
}

async function assertTooLarge(response) {
  assert.equal(response.status, 413);
  assert.equal(response.body.error.type, "request_too_large");
  assert.equal(response.body.error.message, "Request body exceeds the router limit.");
  assert.equal(response.headers.connection, "close");
  if (response.socketClosed) {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Oversized request socket stayed open")), 2000);
      response.socketClosed.then(() => { clearTimeout(timeout); resolve(); });
    });
  }
}

test("default request limit is 64 MiB and an ordinary request succeeds", async () => {
  assert.equal(MAX_REQUEST_BODY_BYTES, 64 * 1024 * 1024);
  await withProxy(async ({ url, received, counts }) => {
    const response = await post(url, baseBody);
    assert.equal(response.status, 200);
    assert.equal(received[0].model, "gpt-6-luna");
    assert.deepEqual(counts(), { classifierCalls: 1, upstreamCalls: 2 });
  });
});

test("Content-Length above the limit gets 413 before any body arrives", async () => {
  await withProxy(async ({ url, received, proxy, counts }) => {
    await assertTooLarge(await postWithoutFinishing(url, { contentLength: testLimit + 1 }));
    assert.deepEqual(counts(), { classifierCalls: 0, upstreamCalls: 0 });
    assert.equal(received.length, 0);
    assert.equal(proxy.getLastAppliedRoute(), null);
    const next = await post(url, baseBody);
    assert.equal(next.status, 200);
    assert.deepEqual(counts(), { classifierCalls: 1, upstreamCalls: 2 });
    assert.equal(received[0].model, "gpt-6-luna");
  });
});

test("chunked request without Content-Length gets 413 before it ends", async () => {
  await withProxy(async ({ url, proxy, counts }) => {
    await assertTooLarge(await postWithoutFinishing(url, { chunk: paddedBody(testLimit + 1) }));
    assert.deepEqual(counts(), { classifierCalls: 0, upstreamCalls: 0 });
    assert.equal(proxy.getLastAppliedRoute(), null);
  });
});

test("UTF-8 multibyte body is limited by bytes, not characters", async () => {
  const japaneseBody = JSON.stringify({ model: "jev-router", input: [
    { type: "additional_tools", tools: [] },
    { role: "user", content: "あ".repeat(350) },
  ] });
  assert.ok(japaneseBody.length < testLimit);
  assert.ok(Buffer.byteLength(japaneseBody) > testLimit);
  await withProxy(async ({ url, counts }) => {
    await assertTooLarge(await postWithoutFinishing(url, { chunk: japaneseBody }));
    assert.deepEqual(counts(), { classifierCalls: 0, upstreamCalls: 0 });
  });
});

test("exact limit is accepted and limit plus one byte is rejected", async () => {
  await withProxy(async ({ url, counts }) => {
    assert.equal((await post(url, paddedBody(testLimit))).status, 200);
    const before = counts();
    const rejected = await post(url, paddedBody(testLimit + 1));
    await assertTooLarge({ status: rejected.status, headers: Object.fromEntries(rejected.headers),
      body: await rejected.json() });
    assert.deepEqual(counts(), before);
  });
});
