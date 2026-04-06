function createCanonicalState(workflow = null) {
  return {
    workflow,
    focus: {
      jobId: null,
      customerId: null,
      customerName: null,
    },
    collected: {},
    pending: null,
    options: [],
  };
}

function normaliseConversationState(currentState) {
  const workflow = currentState?.workflow || null;
  const raw = currentState?.state || {};
  const canonical = createCanonicalState(workflow);

  if (!currentState) return canonical;

  if (raw.focus || raw.collected || raw.pending || raw.options) {
    return {
      workflow,
      focus: {
        ...canonical.focus,
        ...(raw.focus || {}),
      },
      collected: {
        ...(raw.collected || {}),
      },
      pending: raw.pending || null,
      options: Array.isArray(raw.options) ? raw.options : [],
    };
  }

  const collected = { ...raw };
  delete collected.focus;
  delete collected.pending;
  delete collected.options;

  return {
    workflow,
    focus: {
      ...canonical.focus,
      jobId: raw.jobId || null,
      customerId: raw.customerId || null,
      customerName: raw.customerName || null,
    },
    collected,
    pending: raw.pending || null,
    options: Array.isArray(raw.options) ? raw.options : [],
  };
}

module.exports = {
  createCanonicalState,
  normaliseConversationState,
};
