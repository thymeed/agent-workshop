/**
 * Builders for hand-made Claude Code transcript lines (neutral names only). Used by the wire
 * unit tests and the bridge test. Every line is one JSON object, as on disk.
 */
"use strict";

const SESSION = "11111111-2222-4333-8444-555555555555";
const T0 = Date.parse("2026-01-02T03:04:05.000Z");
let tick = 0;
const stamp = () => new Date(T0 + 1000 * tick++).toISOString();

const line = (o) => JSON.stringify(o);

/** Assistant line from the parent. content = array of blocks. */
function assistant(content, opts = {}) {
  return line({
    type: "assistant",
    sessionId: opts.sessionId || SESSION,
    timestamp: stamp(),
    message: {
      id: opts.id || "msg_" + tick,
      model: opts.model || "claude-opus-5-5",
      content,
      usage: opts.usage || { input_tokens: 100, output_tokens: 50 }
    }
  });
}

const toolUse = (id, name, input) => ({ type: "tool_use", id, name, input });

/** The parent asks for a subagent. */
const agentCall = (id, subagentType, model, extra) =>
  toolUse(id, "Agent", { subagent_type: subagentType, ...(model ? { model } : {}), ...extra });

/** The Agent result that names the child. */
function agentResult(toolUseId, agentId, sessionId, resolvedModel) {
  return line({
    type: "user",
    sessionId: sessionId || SESSION,
    timestamp: stamp(),
    toolUseResult: { agentId, ...(resolvedModel ? { resolvedModel } : {}) },
    message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content: "ok" }] }
  });
}

/** A task-notification carried in a queue-operation line. */
function notification(toolUseId, taskId, status, sessionId) {
  return line({
    type: "queue-operation",
    sessionId: sessionId || SESSION,
    timestamp: stamp(),
    content:
      "<task-notification><task-id>" +
      taskId +
      "</task-id><tool-use-id>" +
      toolUseId +
      "</tool-use-id><status>" +
      status +
      "</status><usage><subagent_tokens>1234</subagent_tokens><tool_uses>7</tool_uses>" +
      "<duration_ms>4500</duration_ms></usage></task-notification>"
  });
}

/** A plain user turn from the parent (the text is never copied into a row). */
const userTurn = (text, sessionId) =>
  line({
    type: "user",
    sessionId: sessionId || SESSION,
    timestamp: stamp(),
    message: { role: "user", content: text }
  });

module.exports = {
  SESSION,
  assistant,
  toolUse,
  agentCall,
  agentResult,
  notification,
  userTurn,
  line
};
