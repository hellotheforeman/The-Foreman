function decideContextPolicy({ messageType, suggestedWorkflow, state, raw }) {
  const text = (raw || '').trim().toLowerCase();
  const hasPronounReference = /\b(this|that|it|her|him|the other one)\b/i.test(text);
  const hasExplicitNewAction = /\b(new job|quote|schedule|book|invoice|paid|chase|follow up|archive|delete|remove|done)\b/i.test(text);

  if (!state) {
    return {
      reuseFocus: false,
      reuseWorkflow: false,
      resetState: false,
    };
  }

  if (messageType === 'social') {
    return {
      reuseFocus: false,
      reuseWorkflow: false,
      resetState: false,
    };
  }

  if (messageType === 'overview_query') {
    return {
      reuseFocus: false,
      reuseWorkflow: false,
      resetState: false,
    };
  }

  if (messageType === 'selection') {
    return {
      reuseFocus: true,
      reuseWorkflow: true,
      resetState: false,
    };
  }

  if (messageType === 'follow_up_answer') {
    return {
      reuseFocus: true,
      reuseWorkflow: true,
      resetState: false,
    };
  }

  if (messageType === 'entity_query') {
    return {
      reuseFocus: true,
      reuseWorkflow: false,
      resetState: false,
    };
  }

  if (messageType === 'action_request') {
    if (hasPronounReference) {
      return {
        reuseFocus: true,
        reuseWorkflow: false,
        resetState: false,
      };
    }

    if (hasExplicitNewAction) {
      return {
        reuseFocus: false,
        reuseWorkflow: false,
        resetState: false,
      };
    }
  }

  return {
    reuseFocus: false,
    reuseWorkflow: false,
    resetState: false,
  };
}

module.exports = { decideContextPolicy };
