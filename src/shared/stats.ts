import { ModelFamily } from "./models";

// technically slightly underestimates, because completion tokens cost more
// than prompt tokens but we don't track those separately right now
export function getTokenCostUsd(model: ModelFamily, tokens: number) {
  let cost = 0;
  switch (model) {
    case "gpt4-32k":
      cost = 0.00006;
      break;
    case "gpt4":
      cost = 0.00003;
      break;
    case "turbo":
      cost = 0.0000015;
      break;
    case "aws-claude":
    case "claude":
      cost = 0.00001102;
      break;
  }
  return cost * Math.max(0, tokens);
}

export function prettyTokens(tokens: number): string {
  const absTokens = Math.abs(tokens);
  if (absTokens < 1000) {
    return tokens.toString();
  } else if (absTokens < 1000000) {
    return (tokens / 1000).toFixed(1) + "k";
  } else if (absTokens < 1000000000) {
    return (tokens / 1000000).toFixed(2) + "m";
  } else {
    return (tokens / 1000000000).toFixed(2) + "b";
  }
}
