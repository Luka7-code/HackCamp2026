"use strict";

const { createStore: createPredictiveStore } = require("../predictive/store");
const { createProcurementStore } = require("./store");
const { createGeminiClient } = require("./gemini");
const { createEmailClient } = require("./email");
const { createProcurementOrchestrator } = require("./orchestrator");

function createProcurementServices({ query, config }) {
  const store = createProcurementStore(query);
  const predictiveStore = createPredictiveStore(query);
  const gemini = createGeminiClient(config);
  const email = createEmailClient(config);
  const orchestrator = createProcurementOrchestrator({
    store,
    predictiveStore,
    config,
    gemini,
    email,
  });

  return { store, predictiveStore, gemini, email, orchestrator, config };
}

module.exports = { createProcurementServices };
