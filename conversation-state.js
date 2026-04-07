const db = require('./db');

function normaliseConversationState(state) {
  if (!state) return null;
  return {
    workflow: state.workflow,
    focus: state.focus || {},
    collected: state.collected || {},
    pending: state.pending || null,
    options: state.options || [],
    updated_at: state.updated_at || null,
  };
}

async function getConversationState(businessId) {
  const state = await db.getConversationState(businessId);
  return normaliseConversationState(state);
}

async function setConversationState(businessId, state) {
  const normalised = normaliseConversationState(state);
  if (!normalised || !normalised.workflow) {
    throw new Error('Conversation state requires a workflow');
  }
  await db.setConversationState(businessId, normalised);
}

async function clearConversationState(businessId) {
  await db.clearConversationState(businessId);
}

module.exports = {
  normaliseConversationState,
  getConversationState,
  setConversationState,
  clearConversationState,
};
