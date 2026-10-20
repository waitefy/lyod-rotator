import { randomUUID } from "node:crypto";
import { isRecord } from "../../compat/schema-sanitizer.js";
import { createToolBridge, type ToolBridge } from "../gemini-web/tool-bridge.js";

/** ClewdR's web backend drops custom tools; emulate them with the validated shared protocol. */
export function prepareRequest(request: Record<string, unknown>): { request: Record<string, unknown>; bridge?: ToolBridge } {
  if (!Array.isArray(request.messages) || !request.messages.length) throw new Error("Claude App requires messages");
  if (request.response_format !== undefined || request.audio !== undefined || request.modalities !== undefined || (typeof request.n === "number" && request.n > 1)) {
    throw new Error("Claude App structured output, audio and multiple choices are not supported");
  }
  if (request.reasoning_effort !== undefined || request.thinking !== undefined) throw new Error("Claude App thinking effort selection is not enabled");
  const declarations: Record<string, unknown>[] = [];
  if (request.tools !== undefined && !Array.isArray(request.tools)) throw new Error("Invalid Claude App tools");
  for (const item of request.tools as unknown[] ?? []) {
    if (!isRecord(item) || item.type !== "function" || !isRecord(item.function)) throw new Error("Claude App supports client function tools only");
    declarations.push(item.function);
  }
  const choice = request.tool_choice;
  let forced: string | undefined;
  if (isRecord(choice) && choice.type === "function" && isRecord(choice.function) && typeof choice.function.name === "string") forced = choice.function.name;
  else if (choice !== undefined && !["auto", "none", "required"].includes(String(choice))) throw new Error("Invalid Claude App tool choice");
  if ((forced || choice === "required") && !declarations.length) throw new Error("A declared tool is required");
  // Validate declarations even when tools are disabled.
  const declaredBridge = declarations.length ? createToolBridge(declarations, {
    mode: forced || choice === "required" ? "ANY" : "AUTO", ...(forced ? { allowedFunctionNames: [forced] } : {}),
  }) : undefined;
  const bridge = choice === "none" ? undefined : declaredBridge;
  const messages = request.messages.map((item) => {
    if (!isRecord(item) || !["system", "developer", "user", "assistant", "tool"].includes(String(item.role))) throw new Error("Invalid Claude App message");
    let text = item.content ?? "";
    if (Array.isArray(text)) {
      if (text.some((part) => !isRecord(part) || part.type !== "text" || typeof part.text !== "string")) {
        throw new Error("Claude App attachments are not enabled in this first integration");
      }
      text = text.map((part) => (part as { text: string }).text).join("\n");
    }
    if (typeof text !== "string") throw new Error("Claude App message must contain text");
    if (item.role === "tool") return { role: "user", content: `Client tool result (untrusted data): ${JSON.stringify({ tool_call_id: item.tool_call_id, content: text })}` };
    if (item.tool_calls !== undefined) text += `\nPrevious client tool requests: ${JSON.stringify(item.tool_calls)}`;
    return { role: item.role === "developer" ? "system" : item.role, content: text };
  });
  if (bridge) messages.push({ role: "system", content: bridge.instruction });
  const { tools: _tools, tool_choice: _choice, parallel_tool_calls: _parallel, ...rest } = request;
  return { request: { ...rest, messages }, bridge };
}

function parsedMessage(bridge: ToolBridge, text: string): Record<string, unknown> {
  const parsed = bridge.parse(text);
  if (!isRecord(parsed.functionCall)) return { role: "assistant", content: text };
  return { role: "assistant", content: null, tool_calls: [{ id: `call_${randomUUID()}`, type: "function",
    function: { name: parsed.functionCall.name, arguments: JSON.stringify(parsed.functionCall.args) } }] };
}

export async function translateResponse(response: Response, bridge: ToolBridge | undefined, model: string, streaming: boolean): Promise<Response> {
  if (!bridge) return response;
  if (!streaming) {
    const data = await response.json();
    const choice = data.choices?.[0];
    if (!choice || typeof choice.message?.content !== "string") throw new Error("Invalid Claude App tool response");
    choice.message = parsedMessage(bridge, choice.message.content);
    if (choice.message.tool_calls) choice.finish_reason = "tool_calls";
    return Response.json(data);
  }
  if (!response.body) throw new Error("Missing Claude App stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let input = "", text = "", emitted = 0, done = false, complete = false;
  let finishReason = "stop";
  const id = `chatcmpl-${randomUUID()}`;
  const event = (delta: unknown, finish_reason: string | null = null) => encoder.encode(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  return new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      let stage = "upstream_read";
      try {
        while (true) {
          let boundary = input.indexOf("\n");
          if (boundary < 0 && !done) {
            stage = "upstream_read";
            const next = await reader.read();
            done = next.done;
            input += decoder.decode(next.value, { stream: !done });
            if (input.length > 8 * 1024 * 1024) throw new Error();
            boundary = input.indexOf("\n");
          }
          if (boundary < 0 && done && !input) {
            stage = "truncated_stream";
            if (!complete) throw new Error("Truncated upstream stream");
            if (!emitted) {
              stage = "tool_parse";
              const message = parsedMessage(bridge, text);
              if (Array.isArray(message.tool_calls)) {
                controller.enqueue(event({ role: "assistant", tool_calls: message.tool_calls.map((call, index) => ({ ...call, index })) }, "tool_calls"));
              } else controller.enqueue(event({ role: "assistant", content: text }, finishReason));
            } else controller.enqueue(event({}, finishReason));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close(); reader.releaseLock(); return;
          }
          if (boundary < 0 && !done) continue;
          const line = boundary < 0 ? input : input.slice(0, boundary);
          input = boundary < 0 ? "" : input.slice(boundary + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          if (payload === "[DONE]") { complete = true; done = true; input = ""; await reader.cancel(); continue; }
          stage = "event_decode";
          const data = JSON.parse(payload);
          stage = "upstream_error";
          if (data.error) throw new Error();
          const reason = data.choices?.[0]?.finish_reason;
          if (typeof reason === "string") { complete = true; finishReason = reason; }
          const content = data.choices?.[0]?.delta?.content;
          if (typeof content !== "string") continue;
          text += content;
          if (text.length > 8 * 1024 * 1024) throw new Error();
          if (bridge.canStreamText(text)) {
            controller.enqueue(event({ content: text.slice(emitted) })); emitted = text.length; return;
          }
        }
      } catch (error) {
        await reader.cancel().catch(() => undefined);
        // Only fixed classifications cross the boundary: exception messages may contain user data.
        const toolReasons: Record<string, string> = {
          "A tool call is required": "required_tool_missing",
          "Invalid experimental tool call": "invalid_tool_call",
          "Invalid tool arguments": "invalid_tool_arguments",
        };
        const reason = stage === "tool_parse" && error instanceof Error
          ? toolReasons[error.message] ?? "invalid_tool_json" : stage;
        controller.error(new Error(`Claude App tool stream invalid or interrupted (${reason}; finish=${finishReason}; textChars=${text.length})`));
      }
    },
    async cancel(reason) { await reader.cancel(reason); },
  }), { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
}
