import { randomUUID } from "node:crypto";

/** Use ClewdR's native Messages route: its OpenAI SSE mapper drops stop/error events. */
export function toBridgeRequest(request: Record<string, unknown>): Record<string, unknown> {
  const messages = request.messages as Array<{ role: string; content: string }>;
  const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
  return { model: request.model, messages: messages.filter((message) => message.role !== "system"),
    ...(system ? { system } : {}), stream: request.stream === true,
    max_tokens: request.max_tokens ?? request.max_completion_tokens ?? 4096,
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.top_p !== undefined ? { top_p: request.top_p } : {}),
    ...(request.stop !== undefined ? { stop_sequences: typeof request.stop === "string" ? [request.stop] : request.stop } : {}),
  };
}

const finishReason = (reason: unknown) => reason === "max_tokens" || reason === "model_context_window_exceeded" ? "length"
  : reason === "refusal" ? "content_filter" : "stop";

export async function fromBridgeResponse(response: Response, model: string, streaming: boolean): Promise<Response> {
  if (!streaming) {
    const data = await response.json();
    if (!Array.isArray(data.content) || data.type === "error") throw new Error("Invalid Claude App response");
    return Response.json({ id: data.id ?? `chatcmpl-${randomUUID()}`, object: "chat.completion", model,
      choices: [{ index: 0, message: { role: "assistant", content: data.content.filter((part: { type: string }) => part.type === "text")
        .map((part: { text: string }) => part.text).join("") }, finish_reason: finishReason(data.stop_reason) }],
      ...(data.usage ? { usage: { prompt_tokens: data.usage.input_tokens ?? 0, completion_tokens: data.usage.output_tokens ?? 0,
        total_tokens: (data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0) } } : {}) });
  }
  if (!response.body) throw new Error("Missing Claude App stream");
  const reader = response.body.getReader();
  const encoder = new TextEncoder(), decoder = new TextDecoder();
  const id = `chatcmpl-${randomUUID()}`;
  let input = "", eof = false, stopped = false, reason = "stop";
  const event = (delta: unknown, finish_reason: string | null = null) => encoder.encode(`data: ${JSON.stringify({ id,
    object: "chat.completion.chunk", model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  return new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (true) {
          let boundary = input.indexOf("\n");
          if (boundary < 0 && !eof) {
            const next = await reader.read(); eof = next.done;
            input += decoder.decode(next.value, { stream: !eof });
            if (input.length > 8 * 1024 * 1024) throw new Error();
            boundary = input.indexOf("\n");
          }
          if (boundary < 0 && eof && !input) {
            if (!stopped) throw new Error();
            controller.enqueue(event({}, reason));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close(); reader.releaseLock(); return;
          }
          if (boundary < 0 && !eof) continue;
          const line = boundary < 0 ? input : input.slice(0, boundary);
          input = boundary < 0 ? "" : input.slice(boundary + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim(); if (!payload) continue;
          const data = JSON.parse(payload);
          if (data.type === "error" || data.error) throw new Error();
          if (data.type === "message_delta" && data.delta?.stop_reason) reason = finishReason(data.delta.stop_reason);
          if (data.type === "message_stop") {
            stopped = true;
            // ClewdR finalizes the upstream request and returns usage at EOF.
            // Cancelling on message_stop can leave the website generation in flight
            // while the client starts its next tool turn.
            continue;
          }
          if (stopped) continue;
          if (data.type === "content_block_delta" && data.delta?.type === "text_delta") {
            controller.enqueue(event({ content: data.delta.text })); return;
          }
          if (data.type === "content_block_delta" && data.delta?.type === "thinking_delta") {
            controller.enqueue(event({ reasoning_content: data.delta.thinking })); return;
          }
        }
      } catch {
        await reader.cancel().catch(() => undefined);
        controller.error(new Error("Claude App upstream stream invalid or interrupted"));
      }
    },
    async cancel(reason) { await reader.cancel(reason); },
  }), { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
}
