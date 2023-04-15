import { config } from "../../../config";
import { logQueue } from "../../../prompt-logging";
import { ProxyResHandlerWithBody } from ".";

const COMPLETE_ENDPOINT = "/v1/chat/completions";

/** If prompt logging is enabled, enqueues the prompt for logging. */
export const logPrompt: ProxyResHandlerWithBody = async (
  _proxyRes,
  req,
  _res,
  responseBody
) => {
  if (!config.promptLogging) {
    return;
  }
  if (typeof responseBody !== "object") {
    throw new Error("Expected body to be an object");
  }

  // Only log prompts if we're making a request to a completion endpoint
  if (!req.originalUrl.endsWith(COMPLETE_ENDPOINT)) {
    return;
  }

  const model = req.body.model;
  const promptFlattened = flattenMessages(req.body.messages);
  const response = getResponseForModel({ model, body: responseBody });

  logQueue.enqueue({
    model,
    endpoint: req.api,
    promptRaw: JSON.stringify(req.body.messages),
    promptFlattened,
    response,
  });
};

type OaiMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

const flattenMessages = (messages: OaiMessage[]): string => {
  return messages.map((m) => `${m.role}: ${m.content}`).join("\n");
};

const getResponseForModel = ({
  model,
  body,
}: {
  model: string;
  body: Record<string, any>;
}) => {
  if (model.startsWith("claude")) {
    // TODO: confirm if there is supposed to be a leading space
    return body.completion.trim();
  } else {
    return body.choices[0].message.content;
  }
};