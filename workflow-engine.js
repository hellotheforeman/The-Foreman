const { computeMissingFields, getWorkflow } = require('./workflow-definitions');
const { resolveSingleJobReference } = require('./entity-resolver');
const { normaliseConversationState } = require('./conversation-state');
const { parseLineItems } = require('./parser');

function workflowFromIntent(parsedIntent) {
  if (!parsedIntent?.intent) return null;
  const supported = new Set(['new_customer', 'new_job', 'quote', 'schedule']);
  return supported.has(parsedIntent.intent) ? parsedIntent.intent : null;
}

function mergeCollected(base = {}, parsedIntent = {}, raw = '') {
  const merged = { ...base };

  for (const key of ['name', 'phone', 'description', 'postcode', 'email', 'jobId', 'amount', 'items', 'lineItems', 'date', 'time']) {
    if (parsedIntent[key] !== undefined && parsedIntent[key] !== null && parsedIntent[key] !== '') {
      merged[key] = parsedIntent[key];
    }
  }

  if (base.__expecting === 'description' && raw && !parsedIntent.intent) {
    merged.description = raw.trim();
  }

  if (base.__expecting === 'postcode' && raw && !parsedIntent.intent) {
    merged.postcode = raw.trim().toUpperCase();
  }

  if (base.__expecting === 'email' && raw && !parsedIntent.intent) {
    merged.email = raw.trim().toLowerCase();
  }

  if (base.__expecting === 'amount') {
    if (parsedIntent.amount != null) {
      merged.amount = parsedIntent.amount;
    } else if (raw) {
      // Accept line items as an alternative to a single price: "service 250 | parts 45"
      const lineItems = parseLineItems(raw.trim());
      if (lineItems) {
        merged.amount = lineItems.reduce((sum, i) => sum + i.amount, 0);
        merged.items = raw.trim();
        merged.lineItems = lineItems;
      }
    }
  }

  if (base.__expecting === 'date' && parsedIntent.date) {
    merged.date = parsedIntent.date;
  }

  if (base.__expecting === 'time' && parsedIntent.time) {
    merged.time = parsedIntent.time;
  }

  delete merged.__expecting;
  return merged;
}

function buildPrompt(workflowName, field) {
  const workflow = getWorkflow(workflowName);
  if (!workflow) return 'I need a bit more information.';
  return workflow.prompts[field] || 'I need a bit more information.';
}

function formatOptions(jobs) {
  return jobs.slice(0, 5).map((job, index) => `${index + 1}. ${job.customer_name} — ${job.description}`).join('\n');
}

function parseSelection(raw) {
  const value = String(raw || '').trim();
  if (!/^\d+$/.test(value)) return null;
  const index = parseInt(value, 10);
  return Number.isInteger(index) && index > 0 ? index : null;
}

function isExplicitNewCommand(parsedIntent) {
  return parsedIntent?.kind === 'command' && workflowFromIntent(parsedIntent);
}

async function resolvePendingSelection({ business, currentState, raw }) {
  const normalised = normaliseConversationState(currentState);
  const choice = parseSelection(raw);
  if (!choice || !Array.isArray(normalised?.options) || !normalised.options[choice - 1]) {
    return null;
  }

  const selected = normalised.options[choice - 1];
  const collected = {
    ...(normalised.collected || {}),
    jobId: selected.id,
  };

  const missing = computeMissingFields(normalised.workflow, collected);
  if (missing.length) {
    return {
      type: 'prompt',
      workflow: normalised.workflow,
      state: {
        workflow: normalised.workflow,
        focus: {
          jobId: selected.id,
          customerName: selected.customer_name,
        },
        collected: {
          ...collected,
          __expecting: missing[0],
        },
        pending: { type: 'field', field: missing[0] },
        options: [],
      },
      message: buildPrompt(normalised.workflow, missing[0]),
    };
  }

  return {
    type: 'action',
    workflow: normalised.workflow,
    state: null,
    intent: {
      kind: 'command',
      intent: normalised.workflow,
      ...collected,
    },
  };
}

async function handlePendingField({ business, currentState, parsedIntent, raw, resolveJobReference = resolveSingleJobReference }) {
  const normalised = normaliseConversationState(currentState);
  const pendingField = normalised?.pending?.field;
  if (!pendingField) return null;

  if (pendingField === 'jobId') {
    const resolved = await resolveJobReference({
      businessId: business.id,
      parsedIntent,
      raw,
      state: normalised,
    });

    if (resolved.status === 'multiple') {
      return {
        type: 'prompt',
        workflow: normalised.workflow,
        state: {
          workflow: normalised.workflow,
          focus: normalised.focus || {},
          collected: normalised.collected || {},
          pending: { type: 'selection', field: 'jobId' },
          options: resolved.jobs.slice(0, 5),
        },
        message: `I found a few matches:\n${formatOptions(resolved.jobs)}\n\nReply with 1, 2 or 3.`,
      };
    }

    if (resolved.status === 'resolved') {
      const collected = {
        ...(normalised.collected || {}),
        jobId: resolved.job.id,
        items: (normalised.collected || {}).items || resolved.job.description,
      };
      const missing = computeMissingFields(normalised.workflow, collected);
      if (missing.length) {
        return {
          type: 'prompt',
          workflow: normalised.workflow,
          state: {
            workflow: normalised.workflow,
            focus: {
              jobId: resolved.job.id,
              customerName: resolved.job.customer_name || resolved.job.customer?.name || null,
            },
            collected: {
              ...collected,
              __expecting: missing[0],
            },
            pending: { type: 'field', field: missing[0] },
            options: [],
          },
          message: buildPrompt(normalised.workflow, missing[0]),
        };
      }

      return {
        type: 'action',
        workflow: normalised.workflow,
        state: null,
        intent: {
          kind: 'command',
          intent: normalised.workflow,
          ...collected,
        },
      };
    }

    return {
      type: 'prompt',
      workflow: normalised.workflow,
      state: {
        workflow: normalised.workflow,
        focus: normalised.focus || {},
        collected: {
          ...(normalised.collected || {}),
          __expecting: 'jobId',
        },
        pending: { type: 'field', field: 'jobId' },
        options: [],
      },
      message: buildPrompt(normalised.workflow, 'jobId'),
    };
  }

  const collected = mergeCollected(
    { ...(normalised.collected || {}), __expecting: pendingField },
    parsedIntent,
    raw
  );

  const missing = computeMissingFields(normalised.workflow, collected);
  if (missing.length) {
    return {
      type: 'prompt',
      workflow: normalised.workflow,
      state: {
        workflow: normalised.workflow,
        focus: normalised.focus || {},
        collected: {
          ...collected,
          __expecting: missing[0],
        },
        pending: { type: 'field', field: missing[0] },
        options: [],
      },
      message: buildPrompt(normalised.workflow, missing[0]),
    };
  }

  return {
    type: 'action',
    workflow: normalised.workflow,
    state: null,
    intent: {
      kind: 'command',
      intent: normalised.workflow,
      ...collected,
    },
  };
}

async function resolveJobIfNeeded({ business, workflow, parsedIntent, raw, currentState, collected, resolveJobReference = resolveSingleJobReference }) {
  if (!['quote', 'schedule'].includes(workflow)) {
    return { status: 'not_needed', collected };
  }

  if (collected.jobId) {
    return { status: 'resolved', collected };
  }

  const resolved = await resolveJobReference({
    businessId: business.id,
    parsedIntent,
    raw,
    state: currentState,
  });

  if (resolved.status === 'resolved') {
    return {
      status: 'resolved',
      collected: {
        ...collected,
        jobId: resolved.job.id,
        items: collected.items || resolved.job.description,
      },
      focus: {
        jobId: resolved.job.id,
        customerName: resolved.job.customer_name || resolved.job.customer?.name || null,
      },
    };
  }

  if (resolved.status === 'multiple') {
    return {
      status: 'multiple',
      jobs: resolved.jobs,
    };
  }

  return { status: 'missing' };
}

async function handleMessage({ business, raw, parsedIntent, currentState, resolveJobReference = resolveSingleJobReference }) {
  const normalised = normaliseConversationState(currentState);

  if (parsedIntent?.kind === 'continuation' && parsedIntent.intent === 'cancel' && normalised) {
    return {
      type: 'cancel',
      workflow: normalised.workflow,
      state: null,
      message: 'Okay — cancelled.',
    };
  }

  if (parsedIntent?.kind === 'query' && parsedIntent.intent === 'help' && normalised) {
    return {
      type: 'action',
      intent: parsedIntent,
      state: null,
      workflow: null,
      clearState: false,
    };
  }

  if (normalised && isExplicitNewCommand(parsedIntent)) {
    // Explicit new command overrides stale pending flow.
  } else {
    if (normalised?.pending?.type === 'selection') {
      const selection = await resolvePendingSelection({ business, currentState: normalised, raw });
      if (selection) return selection;
    }

    if (normalised?.pending?.type === 'field') {
      return handlePendingField({ business, currentState: normalised, parsedIntent, raw, resolveJobReference });
    }
  }

  const workflow = workflowFromIntent(parsedIntent);
  if (!workflow) {
    return {
      type: 'action',
      intent: parsedIntent,
      state: null,
      workflow: null,
    };
  }

  let collected = mergeCollected({}, parsedIntent, raw);
  const jobResolution = await resolveJobIfNeeded({
    business,
    workflow,
    parsedIntent,
    raw,
    currentState: normalised,
    collected,
    resolveJobReference,
  });

  if (jobResolution.status === 'multiple') {
    return {
      type: 'prompt',
      workflow,
      state: {
        workflow,
        focus: {},
        collected,
        pending: { type: 'selection', field: 'jobId' },
        options: jobResolution.jobs.slice(0, 5),
      },
      message: `I found a few matches:\n${formatOptions(jobResolution.jobs)}\n\nReply with 1, 2 or 3.`,
    };
  }

  if (jobResolution.status === 'missing') {
    return {
      type: 'prompt',
      workflow,
      state: {
        workflow,
        focus: {},
        collected: {
          ...collected,
          __expecting: 'jobId',
        },
        pending: { type: 'field', field: 'jobId' },
        options: [],
      },
      message: buildPrompt(workflow, 'jobId'),
    };
  }

  if (jobResolution.collected) {
    collected = jobResolution.collected;
  }

  const missing = computeMissingFields(workflow, collected);
  if (missing.length) {
    return {
      type: 'prompt',
      workflow,
      state: {
        workflow,
        focus: jobResolution.focus || {},
        collected: {
          ...collected,
          __expecting: missing[0],
        },
        pending: { type: 'field', field: missing[0] },
        options: [],
      },
      message: buildPrompt(workflow, missing[0]),
    };
  }

  return {
    type: 'action',
    workflow,
    state: null,
    intent: {
      kind: 'command',
      intent: workflow,
      ...collected,
    },
  };
}

module.exports = {
  handleMessage,
  workflowFromIntent,
  mergeCollected,
  buildPrompt,
  parseSelection,
  isExplicitNewCommand,
};
