import type {
  SDKMessage,
  SDKAssistantMessage,
  SDKSystemMessage,
  SDKResultMessage,
  SDKResultError,
  SDKTaskStartedMessage,
  SDKTaskNotificationMessage,
} from "@anthropic-ai/claude-agent-sdk";

export type {
  SDKAssistantMessage,
  SDKSystemMessage,
  SDKResultMessage,
  SDKResultError,
  SDKTaskStartedMessage,
  SDKTaskNotificationMessage,
};

export function isAssistantMessage(msg: SDKMessage): msg is SDKAssistantMessage {
  return msg.type === "assistant";
}

export function isSystemInit(msg: SDKMessage): msg is SDKSystemMessage {
  return msg.type === "system" && (msg as SDKSystemMessage).subtype === "init";
}

export function isTaskStarted(msg: SDKMessage): msg is SDKTaskStartedMessage {
  return msg.type === "system" && (msg as { subtype?: string }).subtype === "task_started";
}

export function isTaskNotification(msg: SDKMessage): msg is SDKTaskNotificationMessage {
  return msg.type === "system" && (msg as { subtype?: string }).subtype === "task_notification";
}

export function isResult(msg: SDKMessage): msg is SDKResultMessage {
  return msg.type === "result";
}

export function isResultError(msg: SDKMessage): msg is SDKResultError {
  return msg.type === "result" && (msg as SDKResultMessage).is_error === true;
}
