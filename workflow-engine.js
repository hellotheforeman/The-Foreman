const { computeMissingFields, getWorkflow } = require('./workflow-definitions');
const { buildGreeting, buildAcknowledgement, buildChoiceList, buildClarification, buildNoMatch, buildResolvedReference } = require('./response-builder');
const { resolveSingleJobReference } = require('./entity-resolver');
const { decideContextPolicy } = require('./context-policy');
const { normaliseConversationState } = require('./conversation-state');

function workflowFromIntent(parsedIntent, classifierResult) {
  const map = {
    new_job: 'create_job',
    quote: 'create_quote',
    schedule: 'schedule_job',
    archive_job: 'archive_job',
    thanks: 'social',
    open_jobs: 'open_jobs',
    view_schedule: 'view_schedule',
    reschedule_job: 'reschedule_job',
  };
  return classifierResult?.suggestedWorkflow || map[parsedIntent?.intent] || null;
}

function getStoredState(currentState) {
  const state = normaliseConversationState(currentState);
  return {
    ...state.collected,
    focus: state.focus,
    pending: state.pending,
    options: state.options,
  };
}

function isExplicitBreakoutMessage(raw, classifierResult) {
  const text = (raw || '').trim().toLowerCase();
  if (!text) return false;
  if (classifierResult?.kind === 'social') return true;
  if (classifierResult?.kind === 'overview_query') return true;
  if (/^(help|hello|hi|hey|thanks|thank you|cheers)\b/.test(text)) return true;
  if (/^(new job|quote|schedule|book|invoice|paid|chase|follow up|archive|delete|remove|done)\b/.test(text)) return true;
  return false;
}

async function handlePendingFieldAnswer({ raw, parsedIntent, currentState }) {
  const storedState = getStoredState(currentState);
  const pendingField = storedState?.pending?.field;
  if (!pendingField) return null;

  const workflow = currentState?.workflow;
  const collected = {
    ...(storedState.collected || {}),
    ...(storedState.focus?.jobId ? { jobId: storedState.focus.jobId } : {}),
  };

  if (pendingField === 'date') {
    if (!parsedIntent?.date) {
      return {
        type: 'reply',
        workflow,
        state: currentState.state,
        message: 'Sorry — what day do you want to move it to?',
      };
    }
    collected.date = parsedIntent.date;
  } else if (pendingField === 'time') {
    if (!parsedIntent?.time) {
      return {
        type: 'reply',
        workflow,
        state: currentState.state,
        message: 'Sorry — what time do you want?',
      };
    }
    collected.time = parsedIntent.time;
  } else if (pendingField === 'amount') {
    if (parsedIntent?.amount === undefined || parsedIntent?.amount === null) {
      return {
        type: 'reply',
        workflow,
        state: currentState.state,
        message: 'Sorry — what price should I use?',
      };
    }
    collected.amount = parsedIntent.amount;
  } else if (pendingField === 'address') {
    collected.address = raw.trim();
  } else if (pendingField === 'description') {
    collected.description = raw.trim();
  } else if (pendingField === 'phone') {
    collected.phone = parsedIntent?.phone || raw.trim();
  } else if (pendingField === 'name') {
    collected.name = parsedIntent?.name || raw.trim();
  }

  return {
    type: 'continue_workflow',
    workflow,
    state: {
      focus: storedState.focus || {},
      collected,
      pending: null,
      options: storedState.options || [],
      lastTurnType: 'answered_question',
    },
  };
}

async function handleMessage({ business, raw, parsedIntent, classifierResult, currentState }) {
  currentState = currentState
    ? { workflow: currentState.workflow, state: normaliseConversationState(currentState) }
    : null;

  if (currentState?.state?.pending?.field && !isExplicitBreakoutMessage(raw, classifierResult)) {
    const pendingResult = await handlePendingFieldAnswer({ raw, parsedIntent, currentState });
    if (pendingResult?.type === 'reply') return pendingResult;
    if (pendingResult?.type === 'continue_workflow') {
      currentState = {
        workflow: pendingResult.workflow,
        state: pendingResult.state,
      };
      parsedIntent = {
        ...((pendingResult.state && pendingResult.state.collected) || {}),
      };
      classifierResult = {
        kind: 'follow_up_answer',
        suggestedWorkflow: pendingResult.workflow,
        raw,
      };
    }
  }

  if (parsedIntent?.intent === 'hello' || classifierResult?.suggestedWorkflow === 'hello') {
    return { type: 'reply', message: buildGreeting() };
  }

  if (classifierResult?.kind === 'social' || parsedIntent?.intent === 'thanks') {
    return { type: 'reply', message: buildAcknowledgement() };
  }

  const workflow = workflowFromIntent(parsedIntent, classifierResult);
  const policy = decideContextPolicy({
    messageType: classifierResult?.kind,
    suggestedWorkflow: workflow,
    state: currentState,
    raw,
  });

  if (!workflow) {
    return {
      type: 'action',
      intent: parsedIntent,
    };
  }

  if (workflow === 'open_jobs') {
    return {
      type: 'action',
      intent: { intent: 'open_jobs' },
      workflow: null,
      state: {
        focus: {},
        collected: {},
        pending: null,
        options: [],
        lastTurnType: 'answered_query',
      },
    };
  }

  if (workflow === 'view_schedule_today') {
    return {
      type: 'action',
      intent: { intent: 'view_schedule', period: 'today' },
      workflow: null,
      state: {
        focus: {},
        collected: {},
        pending: null,
        options: [],
        lastTurnType: 'answered_query',
      },
    };
  }

  if (workflow === 'view_schedule_tomorrow') {
    return {
      type: 'action',
      intent: { intent: 'view_schedule', period: 'tomorrow' },
      workflow: null,
      state: {
        focus: {},
        collected: {},
        pending: null,
        options: [],
        lastTurnType: 'answered_query',
      },
    };
  }

  if (workflow === 'view_schedule_week') {
    return {
      type: 'action',
      intent: { intent: 'view_schedule', period: 'week' },
      workflow: null,
      state: {
        focus: {},
        collected: {},
        pending: null,
        options: [],
        lastTurnType: 'answered_query',
      },
    };
  }

  if (workflow === 'query_job_status') {
    const resolved = await resolveSingleJobReference({
      businessId: business.id,
      parsedIntent,
      raw,
      state: getStoredState(currentState),
    });

    if (resolved.status === 'resolved') {
      const job = resolved.job;
      const when = job.scheduled_date
        ? `${job.scheduled_date}${job.scheduled_time ? ` at ${job.scheduled_time}` : ''}`
        : 'not booked in yet';
      return {
        type: 'reply',
        workflow: 'query_job_status',
        state: {
          focus: {
            jobId: job.id,
            customerId: job.customer_id,
            customerName: job.customer_name,
            jobSummary: job.description,
            confidence: 'high',
          },
          collected: {},
          pending: null,
          options: [],
          lastTurnType: 'answered_query',
        },
        message: `📌 ${job.customer_name} — ${job.description}\nStatus: ${job.status.toLowerCase()}\nScheduled: ${when}`,
      };
    }

    if (resolved.status === 'multiple') {
      return {
        type: 'reply',
        workflow: 'query_job_status',
        state: {
          focus: {},
          collected: {},
          pending: { type: 'selection', optionsType: 'job' },
          options: resolved.jobs,
          lastTurnType: 'showed_options',
        },
        message: buildChoiceList('I found a few matches:', resolved.jobs.map(buildResolvedReference)),
      };
    }

    return {
      type: 'reply',
      message: buildNoMatch(`I couldn't match that to an open job.`),
    };
  }

  const definition = getWorkflow(workflow);
  if (!definition) {
    return {
      type: 'action',
      intent: parsedIntent,
    };
  }

  const storedState = getStoredState(currentState);
  const preservedState = policy.reuseWorkflow ? storedState : {};
  const state = {
    ...preservedState,
    ...(parsedIntent || {}),
  };

  const focus = policy.reuseFocus ? (storedState.focus || {}) : {};

  if (!state.jobId && focus.jobId && ['schedule_job', 'reschedule_job', 'create_quote', 'archive_job', 'query_job_status'].includes(workflow)) {
    state.jobId = focus.jobId;
  }

  if ((workflow === 'schedule_job' || workflow === 'reschedule_job') && state.jobId) {
    const job = await resolveSingleJobReference({
      businessId: business.id,
      parsedIntent: { jobId: state.jobId },
      raw,
      state,
    });
    if (job.status === 'resolved' && !state.items) {
      state.customerName = job.job.customer_name;
      state.description = job.job.description;
      state.focus = {
        jobId: job.job.id,
        customerId: job.job.customer_id,
        customerName: job.job.customer_name,
        jobSummary: job.job.description,
        confidence: 'high',
      };
    }
  }

  if (workflow === 'create_quote' && !state.amount && parsedIntent?.amount) {
    state.amount = parsedIntent.amount;
  }

  if (workflow === 'create_quote' && !state.items && !parsedIntent?.amount && raw && !/^£?\s*\d+(?:\.\d{1,2})?$/.test(raw.trim())) {
    state.items = raw.trim();
  }

  if (workflow === 'schedule_job' || workflow === 'reschedule_job') {
    if (!state.date && parsedIntent?.date) state.date = parsedIntent.date;
    if (!state.time && parsedIntent?.time) state.time = parsedIntent.time;
  }

  if (workflow === 'archive_job' && Array.isArray(storedState.options) && classifierResult?.kind === 'selection') {
    const lowered = (raw || '').trim().toLowerCase();
    const matches = lowered === 'all'
      ? storedState.options
      : [...new Set((lowered.match(/\d+/g) || []).map((n) => parseInt(n, 10)).filter((n) => Number.isInteger(n) && n > 0))]
          .map((index) => storedState.options[index - 1])
          .filter(Boolean);

    if (matches.length) {
      return {
        type: 'action',
        workflow,
        state: {
          focus: {},
          collected: {},
          pending: null,
          options: [],
          lastTurnType: 'completed_action',
        },
        intent: {
          intent: 'archive_job',
          jobIds: matches.map((job) => job.id),
        },
      };
    }
  }

  if (definition.requiredFields.includes('jobId') && !state.jobId) {
    const resolved = await resolveSingleJobReference({
      businessId: business.id,
      parsedIntent,
      raw,
      state: storedState,
    });

    if (resolved.status === 'resolved') {
      state.jobId = resolved.job.id;
      state.focus = {
        jobId: resolved.job.id,
        customerId: resolved.job.customer_id,
        customerName: resolved.job.customer_name,
        jobSummary: resolved.job.description,
        confidence: 'high',
      };
      if (workflow === 'create_quote' && !state.items) {
        state.items = resolved.job.description;
      }
    } else if (resolved.status === 'multiple') {
      return {
        type: 'reply',
        workflow,
        state: {
          focus,
          collected: state,
          pending: { type: 'selection', optionsType: 'job' },
          options: resolved.jobs,
          lastTurnType: 'showed_options',
        },
        message: buildChoiceList('I found a few matches:', resolved.jobs.map(buildResolvedReference)),
      };
    } else {
      return {
        type: 'reply',
        workflow,
        state: {
          focus,
          collected: state,
          pending: { type: 'field', field: 'jobId' },
          options: [],
          lastTurnType: 'asked_question',
        },
        message: buildClarification('Which customer or job do you mean? You can just reply with the customer name.'),
      };
    }
  }

  if (workflow === 'create_quote') {
    const definitionDefaults = await definition.collectDefaults?.({
      focus: {
        jobId: state.focus?.jobId,
        job: state.jobId ? await resolveSingleJobReference({ businessId: business.id, parsedIntent: { jobId: state.jobId }, raw, state }).then((r) => r.job) : null,
      },
      collected: state,
    });
    Object.assign(state, definitionDefaults || {});
  }

  if (workflow === 'reschedule_job' && state.jobId && !state.time) {
    const resolved = await resolveSingleJobReference({
      businessId: business.id,
      parsedIntent: { jobId: state.jobId },
      raw,
      state,
    });
    if (resolved.status === 'resolved' && resolved.job?.scheduled_time) {
      state.time = resolved.job.scheduled_time;
    }
  }

  const missing = computeMissingFields(workflow, state);
  if (missing.length) {
    const prompts = {
      create_job: {
        address: 'What is the address?',
        description: 'What is the job for?',
        phone: 'What is their phone number?',
        name: 'Who is the customer?',
      },
      create_quote: {
        amount: 'What price should I use on the quote?',
      },
      schedule_job: {
        date: 'What day should I book it in for?',
        time: 'What time should I put it in for?',
      },
      reschedule_job: {
        date: 'What day do you want to move it to?',
        time: 'What time should I move it to?',
      },
      archive_job: {
        jobId: 'Which customer or job should I archive? You can reply with the customer name.',
      },
    };

    return {
      type: 'reply',
      message: buildClarification(prompts[workflow]?.[missing[0]] || 'I need a bit more information to do that.'),
      workflow,
      state: {
        focus: state.focus || focus,
        collected: state,
        pending: { type: 'field', field: missing[0] },
        options: state.options || [],
        lastTurnType: 'asked_question',
      },
    };
  }

  const intentMap = {
    create_job: 'new_job',
    create_quote: 'quote',
    schedule_job: 'schedule',
    reschedule_job: 'schedule',
    archive_job: 'archive_job',
  };

  if (definition.requiredFields.includes('jobId') && !state.jobId) {
    return {
      type: 'reply',
      workflow,
      state: {
        focus: state.focus || focus,
        collected: state,
        pending: { type: 'field', field: 'jobId' },
        options: [],
        lastTurnType: 'asked_question',
      },
      message: buildClarification('Which customer or job do you mean? You can just reply with the customer name.'),
    };
  }

  return {
    type: 'action',
    workflow,
    state: {
      focus: state.focus || focus,
      collected: state,
      pending: null,
      options: [],
      lastTurnType: 'completed_action',
    },
    intent: {
      ...state,
      intent: intentMap[workflow] || parsedIntent.intent,
    },
  };
}

module.exports = {
  handleMessage,
};
