import { randomUUID } from "node:crypto";
import type { AgentEvent, StreamFn } from "@earendil-works/pi-agent-core";
import type { ActivitySpan, AttemptActivity } from "../shared/types.ts";

type EndStatus = Exclude<ActivitySpan["status"], "running">;

/** One station execution's real boundaries. Each concurrent tool owns its own span. */
export class StationActivity {
  private spans = new Map<string, ActivitySpan>();
  private request?: { id: string; wait: string; output?: string; model: string };
  private lastRequest?: string;
  private epoch = Date.now();
  private monotonic = performance.now();
  private emit?: (span: ActivitySpan) => void;

  constructor(emit?: (span: ActivitySpan) => void) { this.emit = emit; }
  private now() { return Math.round(this.epoch + performance.now() - this.monotonic); }
  private start(kind: ActivitySpan["kind"], fields: Partial<ActivitySpan> = {}, at = this.now()) {
    const span: ActivitySpan = { ...fields, id: randomUUID(), kind, source: kind === "tool" ? "tool-executor" : "model-stream", startedAt: at, status: "running" };
    this.spans.set(span.id, span); this.emit?.({ ...span });
    return span.id;
  }
  private end(id: string, status: EndStatus, at = this.now()) {
    const span = this.spans.get(id);
    if (!span || span.endedAt !== undefined) return;
    const ended = { ...span, endedAt: Math.max(span.startedAt, at), status };
    this.spans.set(id, ended); this.emit?.({ ...ended });
  }

  /** Starts after Pi has prepared messages/credentials, immediately at stream dispatch. */
  wrapStream(stream: StreamFn): StreamFn {
    return (model, context, options) => {
      this.endRequest("failed");
      const at = this.now(), id = this.start("model_request", { model: model.id }, at);
      const wait = this.start("first_token", { requestId: id, model: model.id }, at);
      this.request = { id, wait, model: model.id }; this.lastRequest = id;
      return stream(model, context, options);
    };
  }

  observe(event: AgentEvent) {
    const request = this.request;
    if (!request) return;
    if (event.type === "message_update") {
      const delta = event.assistantMessageEvent;
      if (!request.output && "delta" in delta && delta.delta && ["text_delta", "thinking_delta", "toolcall_delta"].includes(delta.type)) {
        const at = this.now(); this.end(request.wait, "completed", at);
        request.output = this.start("model_output", { requestId: request.id, model: request.model }, at);
      }
    } else if (event.type === "message_end" && event.message.role === "assistant") {
      const reason = event.message.stopReason;
      this.endRequest(reason === "aborted" ? "cancelled" : reason === "error" ? "failed" : "completed");
    }
  }

  private endRequest(status: EndStatus, at = this.now()) {
    if (!this.request) return;
    const { id, wait, output } = this.request;
    this.end(wait, status, at); if (output) this.end(output, status, at); this.end(id, status, at);
    this.request = undefined;
  }

  async tool<T>(name: string, execute: () => Promise<T>, signal?: AbortSignal, operation?: string): Promise<T> {
    const id = this.start("tool", { toolName: name, operation, requestId: this.lastRequest });
    let status: EndStatus = "failed";
    try {
      const result = await execute();
      const outcome = result as { isError?: boolean; details?: { ok?: boolean } };
      status = outcome?.isError || outcome?.details?.ok === false ? "failed" : "completed";
      return result;
    } finally { this.end(id, signal?.aborted ? "cancelled" : status); }
  }

  close(status: EndStatus) {
    const at = this.now(); this.endRequest(status, at);
    for (const span of this.spans.values()) if (span.endedAt === undefined) this.end(span.id, status, at);
  }

  snapshot(): AttemptActivity {
    const spans = [...this.spans.values()].map(span => ({ ...span }));
    return { version: 1, modelTiming: spans.some(span => span.kind === "model_request") ? "observed" : "unavailable", spans };
  }

  duration(kind: ActivitySpan["kind"]) {
    return [...this.spans.values()].filter(span => span.kind === kind && span.endedAt !== undefined).reduce((ms, span) => ms + span.endedAt! - span.startedAt, 0);
  }

  count(kind: ActivitySpan["kind"]) { return [...this.spans.values()].filter(span => span.kind === kind).length; }
}
