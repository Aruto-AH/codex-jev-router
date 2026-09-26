import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import {
  AUTO_MODEL,
  addAutoModel,
  normalizeCatalog,
} from "./catalog.mjs";
import { routeTurn } from "./router-policy.mjs";
import { routeGptTurn } from "./gpt-policy.mjs";

const API_BASE_URL = "https://api.openai.com/v1";
const CHATGPT_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const MAX_REQUEST_BODY_BYTES = 64 * 1024 * 1024;
const debug = (...values) => {
  if (process.env.JEV_CODEX_DEBUG === "1") console.error("[codex-jev]", ...values);
};

const FALLBACK_CANDIDATES = normalizeCatalog({
  models: [
    { slug: "gpt-6-luna", supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max"], default_reasoning_level: "medium", supported_in_api: true },
    { slug: "gpt-6-sol", supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"], default_reasoning_level: "medium", supported_in_api: true },
  ],
});

const textOf = (content) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item?.type === "text" || item?.type === "input_text")
    .map((item) => item.text)
    .filter(Boolean)
    .join("\n");
};

const cleanPrompt = (text) =>
  text
    .replace(/<system[-_]reminder>[\s\S]*?<\/system[-_]reminder>/gi, "")
    .replace(/<current_datetime>[\s\S]*?<\/current_datetime>/gi, "")
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, "")
    .trim();

const isAuxiliaryPrompt = (prompt) => /^Generate a concise, single-line task title\b/i.test(prompt);

/** Return the fresh user turn, or null when the request is a tool continuation. */
export function newTurnPrompt(body) {
  if (!Array.isArray(body?.input)) return null;
  if (!body.input.some((item) => item?.type === "additional_tools")) return null;
  for (const item of [...body.input].reverse()) {
    if (item?.type === "function_call_output" || item?.type === "custom_tool_call_output") return null;
    if (item?.role !== "user") continue;
    const prompt = cleanPrompt(textOf(item.content));
    if (prompt && !isAuxiliaryPrompt(prompt)) return prompt;
  }
  return null;
}

export function conversationKey(body) {
  const stable =
    body?.prompt_cache_key ??
    body?.client_metadata?.["x-codex-turn-metadata"] ??
    `${body?.instructions ?? ""}|${JSON.stringify(body?.input ?? [])}`;
  return createHash("sha1").update(String(stable)).digest("hex").slice(0, 16);
}

function turnFingerprint(body) {
  const index = body?.input?.findLastIndex((item) => item?.role === "user") ?? -1;
  if (index < 0) return null;
  return createHash("sha1").update(JSON.stringify(body.input.slice(0, index + 1))).digest("hex");
}

const headerValue = (value) => (Array.isArray(value) ? value.join(", ") : value);

function forwardedHeaders(headers) {
  const output = {};
  for (const [name, value] of Object.entries(headers)) {
    if (["host", "content-length", "connection"].includes(name.toLowerCase())) continue;
    const normalized = headerValue(value);
    if (normalized !== undefined) output[name] = normalized;
  }
  return output;
}

const targetURL = (baseURL, requestURL) =>
  `${String(baseURL).replace(/\/$/, "")}${requestURL || "/"}`;

const writeResponseHeaders = (response, target) => {
  for (const [name, value] of response.headers) {
    if (["content-length", "transfer-encoding", "content-encoding", "connection"].includes(name)) continue;
    target.setHeader(name, value);
  }
};

export function decisionEvent(route) {
  const confidence = route.confidence == null ? "" : `, confidence ${Number(route.confidence).toFixed(2)}`;
  const gptLabel = route.reason === "gpt-unavailable" ? "Router fallback" : "Router recommendation";
  const text = route.backend === "gpt" ? (route.shadow
    ? `Router recommendation: ${route.model ?? "unavailable"} / ${route.effort ?? "unavailable"}\nActual request unchanged: ${route.actualModel ?? "unspecified"} / ${route.actualEffort ?? "unspecified"}\nBackend: gpt`
    : `${gptLabel}: ${route.model} / ${route.effort}${confidence}\nBackend: gpt`) : route.shadow
    ? `🔹 [Jev] Jev shadow recommendation: ${route.model ?? "unavailable"} / ${route.effort ?? "unavailable"}\nActual request unchanged: ${route.actualModel ?? "unspecified"} / ${route.actualEffort ?? "unspecified"}`
    : `🔹 [Jev] routed this turn to ${route.model} (${route.effort} reasoning${confidence}).`;
  const id = `${route.backend === "gpt" ? "router" : "jev"}-${randomUUID()}`;
  const item = {
    type: "message",
    role: "assistant",
    id,
    phase: "commentary",
    content: [{ type: "output_text", text }],
  };
  const events = [
    { type: "response.output_item.added", item: { ...item, content: [] } },
    { type: "response.output_text.delta", item_id: id, delta: text },
    { type: "response.output_item.done", item },
  ];
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

class RequestTooLargeError extends Error {}

function readRequestBody(request, maxBytes) {
  if (Number(request.headers["content-length"]) > maxBytes) {
    request.pause();
    return Promise.reject(new RequestTooLargeError());
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    const cleanup = () => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onAborted);
    };
    const onData = (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        request.pause();
        cleanup();
        reject(new RequestTooLargeError());
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks, bytes)); };
    const onError = (error) => { cleanup(); reject(error); };
    const onAborted = () => { cleanup(); reject(new Error("Request aborted")); };
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("aborted", onAborted);
  });
}

const isResponsesPath = (pathname) => /\/responses$/.test(pathname);
const isModelsPath = (pathname) => /\/models$/.test(pathname);

export async function startCodexProxy({
  host = "127.0.0.1",
  port = 0,
  upstreamBaseUrl,
  backend = process.env.ROUTER_BACKEND ?? "gpt",
  apiBaseUrl = backend === "jev" ? process.env.JEV_CODEX_API_BASE_URL ?? API_BASE_URL : API_BASE_URL,
  chatgptBaseUrl = backend === "jev" ? process.env.JEV_CODEX_CHATGPT_BASE_URL ?? CHATGPT_BASE_URL : CHATGPT_BASE_URL,
  route = async () => null,
  autoEffort = backend === "jev" ? process.env.JEV_CODEX_AUTO_EFFORT !== "0" : true,
  shadow = process.env.CODEX_ROUTER_SHADOW === "1" ||
    (process.env.CODEX_ROUTER_SHADOW === undefined && process.env.JEV_CODEX_SHADOW === "1"),
  routeTimeoutMs = backend === "gpt" ? 45000 : 3000,
  maxRequestBodyBytes = MAX_REQUEST_BODY_BYTES,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required");
  if (!Number.isSafeInteger(maxRequestBodyBytes) || maxRequestBodyBytes < 1) {
    throw new Error("A positive request body limit is required");
  }
  if (!["gpt", "jev"].includes(backend)) throw new Error(`Unknown router backend: ${backend}`);
  const applyRoute = backend === "gpt" ? routeGptTurn : routeTurn;

  const states = new Map();
  const gptStates = new Map();
  let lastAppliedRoute = null;
  let candidates = FALLBACK_CANDIDATES;
  let catalogLoaded = false;
  let catalogPromise;

  const upstreamFor = (headers) => upstreamBaseUrl ?? (
    headers["chatgpt-account-id"] ? chatgptBaseUrl : apiBaseUrl
  );

  const loadCatalog = async (headers) => {
    if (catalogLoaded) return;
    catalogPromise ??= (async () => {
      try {
        const catalogResponse = await fetchImpl(targetURL(upstreamFor(headers), "/models"), {
          method: "GET",
          headers: forwardedHeaders(headers),
        });
        if (!catalogResponse.ok) return;
        const catalog = await catalogResponse.json();
        debug("catalog raw", JSON.stringify((catalog.models ?? catalog.data ?? []).map((model) => ({
          id: model.slug ?? model.id,
          supported_in_api: model.supported_in_api,
        }))));
        const normalized = normalizeCatalog(catalog);
        candidates = normalized;
        catalogLoaded = true;
        debug("catalog", candidates.map((candidate) => candidate.id).join(","));
      } catch {
        // The static catalog remains available as a fail-open fallback.
        debug("catalog unavailable; using fallback candidates");
      } finally {
        catalogPromise = undefined;
      }
    })();
    await catalogPromise;
  };

  const decide = async ({ prompt, input, currentModel, models = candidates }) => {
    if (process.env.CODEX_ROUTER_CLASSIFIER === "1") return null;
    const contextTokens = Math.round(JSON.stringify(input ?? []).length / 4);
    const controller = new AbortController();
    let timeout;
    try {
      return await Promise.race([
        route({ prompt, currentModel, contextTokens, models, signal: controller.signal }),
        new Promise((_, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(new Error(`${backend} routing timed out`));
          }, routeTimeoutMs);
        }),
      ]);
    } catch (error) {
      if (!shadow) debug(`${backend} unavailable`, error.message);
      return null;
    } finally {
      clearTimeout(timeout);
    }
  };

  const gptTurn = async (key, fingerprint, prompt, body) => {
    let state = gptStates.get(key);
    if (!state) {
      state = { generation: 0, currentRoute: null, turns: new Map() };
      gptStates.set(key, state);
    }
    let turn = state.turns.get(fingerprint);
    if (turn) return turn.pending ?? turn.settledRoute;
    if (!prompt) return null;

    const generation = ++state.generation;
    const models = [...candidates];
    const previous = state.currentRoute;
    const initialModel = models.find((model) => model.tier === "strong")?.id ?? models[0]?.id;
    const currentModel = shadow && models.some((model) => model.id === body.model)
      ? body.model : previous?.model ?? initialModel;
    turn = { pending: null, settledRoute: null, recommendation: null, generation };
    state.turns.set(fingerprint, turn);
    turn.pending = (async () => {
      const decision = models.length ? await decide({
        prompt, input: body.input, currentModel, models,
      }) : null;
      const proposed = models.length ? routeGptTurn({
        prompt, currentModel, candidates: models, decision, autoEffort,
        incomingEffort: body.reasoning?.effort ?? "medium",
      }) : null;
      const valid = proposed?.reason === "gpt" || proposed?.reason === "gpt-floor";
      turn.recommendation = valid ? proposed : null;
      turn.settledRoute = { ...(valid ? proposed : previous ?? proposed), backend,
        turnFingerprint: fingerprint };
      if (state.generation === turn.generation && !shadow) state.currentRoute = turn.settledRoute;
      turn.pending = null;
      return turn.settledRoute;
    })();
    return turn.pending;
  };

  const server = createServer((request, response) => {
    void (async () => {
      const requestURL = request.url ?? "/";
      const pathname = new URL(requestURL, "http://codex-router.local").pathname;
      const input = await readRequestBody(request, maxRequestBodyBytes);
      let body;
      let routing;

      if (request.method === "POST" && isResponsesPath(pathname) && input.length) {
        try {
          body = JSON.parse(input.toString());
        } catch {
          body = null;
        }
      }

      if (shadow && body?.model === AUTO_MODEL) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { type: "shadow_virtual_model", message: "Shadow Mode requires a real model; jev-router cannot be forwarded upstream." } }));
        return;
      }

      if (shadow && body && backend === "gpt") {
        const key = conversationKey(body);
        const prompt = newTurnPrompt(body);
        const fingerprint = turnFingerprint(body);
        if (prompt && !gptStates.get(key)?.turns.has(fingerprint)) await loadCatalog(request.headers);
        const turnRoute = await gptTurn(key, fingerprint, prompt, body);
        if (turnRoute) {
          const recommendation = gptStates.get(key).turns.get(fingerprint)?.recommendation;
          routing = { shadow: true, backend, model: recommendation?.model ?? null,
            effort: recommendation?.effort ?? null, actualModel: body.model,
            actualEffort: body.reasoning?.effort };
        }
      } else if (shadow && body) {
        const key = conversationKey(body);
        const prompt = newTurnPrompt(body);
        let saved = states.get(key);
        if (prompt) {
          await loadCatalog(request.headers);
          const currentModel = candidates.some((candidate) => candidate.id === body.model)
            ? body.model
            : saved?.recommendation?.model ?? candidates.find((candidate) => candidate.tier === "strong")?.id ?? candidates[0]?.id;
          const decision = candidates.length
            ? await decide({ prompt, input: body.input, currentModel })
            : null;
          const proposed = candidates.length ? applyRoute({
            prompt,
            currentModel,
            candidates,
            decision,
            autoEffort,
            incomingEffort: body.reasoning?.effort ?? "medium",
          }) : null;
          saved = { recommendation: proposed?.reason === "jev" ? proposed : null,
            turnFingerprint: turnFingerprint(body) };
          states.set(key, saved);
        }
        if (saved) {
          routing = {
            shadow: true,
            backend,
            model: saved.recommendation?.model ?? null,
            effort: saved.recommendation?.effort ?? null,
            actualModel: body.model,
            actualEffort: body.reasoning?.effort,
          };
        }
      } else if (body?.model === AUTO_MODEL) {
        await loadCatalog(request.headers);
        if (candidates.length === 0) {
          response.writeHead(503, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { type: "routing_unavailable", message: "The native model catalog has no GPT-6 Luna or Sol routing candidates." } }));
          return;
        }
        const key = conversationKey(body);
        const prompt = newTurnPrompt(body);
        if (backend === "gpt") {
          routing = await gptTurn(key, turnFingerprint(body), prompt, body);
          if (!routing) {
            const state = gptStates.get(key);
            const initialModel = candidates.find((candidate) => candidate.tier === "strong")?.id ?? candidates[0].id;
            routing = state?.currentRoute ?? { ...routeGptTurn({ currentModel: initialModel,
              candidates, decision: null, autoEffort: false,
              incomingEffort: body.reasoning?.effort ?? "medium" }), backend };
          }
        } else {
          const previous = states.get(key);
          const initialModel = candidates.find((candidate) => candidate.tier === "strong")?.id ?? candidates[0].id;
          const currentModel = previous?.model ?? initialModel;
          const incomingEffort = body.reasoning?.effort ?? "medium";
          if (prompt) {
            const decision = await decide({ prompt, input: body.input, currentModel });
            const proposed = applyRoute({ currentModel, candidates, decision, autoEffort, incomingEffort });
            routing = proposed?.reason === backend ? proposed : previous ?? proposed;
            routing = { ...routing, backend, turnFingerprint: turnFingerprint(body) };
            states.set(key, routing);
          } else if (previous) {
            routing = previous;
          } else {
            routing = { ...applyRoute({ currentModel, candidates, decision: null,
              autoEffort: false, incomingEffort }), backend };
          }
        }

        body.model = routing.model;
        if (routing.effort) {
          body.reasoning = { ...(body.reasoning ?? {}), effort: routing.effort };
        }
        debug("route", pathname, routing.model, routing.effort, routing.reason);
      }

      const selectedUpstream = upstreamFor(request.headers);
      const upstreamResponse = await fetchImpl(targetURL(selectedUpstream, requestURL), {
        method: request.method,
        headers: forwardedHeaders(request.headers),
        ...(input.length && !["GET", "HEAD"].includes(request.method)
          ? { body: body && !shadow ? JSON.stringify(body) : input }
          : {}),
      });
      if (routing && upstreamResponse.ok && isResponsesPath(pathname)) {
        lastAppliedRoute = { model: body.model, effort: body.reasoning?.effort ?? null };
      }
      debug("upstream", pathname, upstreamResponse.status, body?.model ?? "passthrough");

      if (isModelsPath(pathname) && upstreamResponse.ok) {
        const catalog = await upstreamResponse.json();
        debug("catalog raw", JSON.stringify((catalog.models ?? catalog.data ?? []).map((model) => ({
          id: model.slug ?? model.id,
          supported_in_api: model.supported_in_api,
        }))));
        candidates = normalizeCatalog(catalog);
        const augmented = shadow ? catalog : addAutoModel(catalog, backend);
        catalogLoaded = true;
        const payload = Buffer.from(JSON.stringify(augmented));
        response.statusCode = upstreamResponse.status;
        writeResponseHeaders(upstreamResponse, response);
        response.removeHeader("content-length");
        response.setHeader("content-length", payload.length);
        response.end(payload);
        return;
      }

      response.statusCode = upstreamResponse.status;
      writeResponseHeaders(upstreamResponse, response);
      const contentType = upstreamResponse.headers.get("content-type") ?? "";
      debug(
        "response",
        pathname,
        upstreamResponse.status,
        contentType || "<none>",
        routing ? `${routing.model}/${routing.effort}` : "passthrough",
      );
      if (routing && upstreamResponse.ok && upstreamResponse.body) {
        response.removeHeader("content-length");
        const upstreamStream = Readable.fromWeb(upstreamResponse.body);
        let pending = "";
        let inspected = false;

        upstreamStream.on("data", (chunk) => {
          if (inspected) {
            response.write(chunk);
            return;
          }

          pending += chunk.toString();
          const separator = pending.match(/\r?\n\r?\n/);
          if (!separator) return;

          const firstEnd = separator.index + separator[0].length;
          const first = pending.slice(0, firstEnd);
          const isSSE = /^(?:event|data):/m.test(first);
          response.write(first);
          if (isSSE) response.write(decisionEvent(routing));
          debug("decision display", isSSE ? "inject" : "skip");
          response.write(pending.slice(firstEnd));
          pending = "";
          inspected = true;
        });
        upstreamStream.on("end", () => {
          if (!inspected) debug("decision display", "skip-no-frame");
          if (!inspected && pending) response.write(pending);
          response.end();
        });
        upstreamStream.on("error", (error) => response.destroy(error));
        return;
      }
      if (upstreamResponse.body) {
        Readable.fromWeb(upstreamResponse.body).pipe(response);
      } else {
        response.end();
      }
    })().catch((error) => {
      if (error instanceof RequestTooLargeError) {
        const ignoreRequestError = () => {};
        request.on("error", ignoreRequestError);
        request.once("close", () => request.off("error", ignoreRequestError));
        if (response.destroyed) { request.destroy(); return; }
        response.writeHead(413, { "content-type": "application/json", connection: "close" });
        response.once("close", () => request.destroy());
        response.end(JSON.stringify({ error: {
          type: "request_too_large", message: "Request body exceeds the router limit.",
        } }));
        return;
      }
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { type: "proxy_error", message: error.message } }));
    });
  });

  await new Promise((resolve) => server.listen(port, host, resolve));
  const address = server.address();
  return {
    host,
    port: address.port,
    getLastAppliedRoute: () => lastAppliedRoute && { ...lastAppliedRoute },
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}
