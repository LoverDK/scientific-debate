export const DEFAULT_DEBATE_RUN_MODEL_ID = "nvidia/nemotron-3.5-super-vl:free";
export const FREE_MODEL_ROUTING = {
  allow_fallbacks: false,
  max_price: { prompt: 0, completion: 0, request: 0, image: 0, audio: 0 },
};
export const FREE_MODEL_RATE_LIMIT =
  "OpenRouter rate-limited the selected free model (429). Wait for capacity or choose another free model with the project maintainer.";
