const { computeMissingFields, getWorkflow } = require('./workflow-definitions');
const { buildGreeting, buildAcknowledgement, buildChoiceList, buildClarification, buildNoMatch, buildResolvedReference } = require('./response-builder');
const { resolveSingleJobReference } = require('./entity-resolver');

function workflowFromIntent(parsedIntent, classifierResult) {
  const map = {
    new_job: 'create_job',
    quote: 'create_quote',
    schedule: 'schedule_job',
    archive_job: 'archive_job',
    thanks: 'social',
  };
  return classifierResult?.suggestedWorkflow || map[parsedIntent?.intent] || null;
}

async function handleMessage({ business, raw, parsedIntent, classifierResult, currentState }) {
  if (parsedIntent?.intent === 'hello' || classifierResult?.suggestedWorkflow === 'hello') {
    return { type: 'reply', message: buildGreeting() };
  }

  if (classifierResult?.kind === 'social' || parsedIntent?.intent === 'thanks') {
    return { type: 'reply', message: buildAcknowledgement() };
  }

  const workflow = workflowFromIntent(parsedIntent, classifierResult);
  if (!workflow) {
    return {
      type: 'action',
      intent: parsedIntent,
    };
  }

  if (workflow === 'query_job_status') {
    const resolved = await resolveSingleJobReference({
      businessId: business.id,
      parsedIntent,
      raw,
      state: currentState?.state,
    });

    if (resolved.status === 'resolved') {
      const job = resolved.job;
      const when = job.scheduled_date
        ? `${job.scheduled_date}${job.scheduled_time ? ` at ${job.scheduled_time}` : ''}`
        : 'not booked in yet';
      return {
        type: 'reply',
        message: `📌 ${job.customer_name} — ${job.description}\nStatus: ${job.status.toLowerCase()}\nScheduled: ${when}`,
      };
    }

    if (resolved.status === 'multiple') {
      return {
        type: 'reply',
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

  const state = {
    ...(currentState?.state || {}),
    ...(parsedIntent || {}),
  };

  if (workflow === 'create_quote' && !state.amount && parsedIntent?.amount) {
    state.amount = parsedIntent.amount;
  }

  if (workflow === 'create_quote' && !state.items && !parsedIntent?.amount && raw && !/^£?\s*\d+(?:\.\d{1,2})?$/.test(raw.trim())) {
    state.items = raw.trim();
  }

  if (workflow === 'schedule_job') {
    if (!state.date && parsedIntent?.date) state.date = parsedIntent.date;
    if (!state.time && parsedIntent?.time) state.time = parsedIntent.time;
  }

  if (workflow === 'archive_job' && Array.isArray(currentState?.state?.options) && classifierResult?.kind === 'selection') {
    const raw = (raw || '').trim().toLowerCase();
    const matches = raw === 'all'
      ? currentState.state.options
      : [...new Set((raw.match(/\d+/g) || []).map((n) => parseInt(n, 10)).filter((n) => Number.isInteger(n) && n > 0))]
          .map((index) => currentState.state.options[index - 1])
          .filter(Boolean);

    if (matches.length) {
      return {
        type: 'action',
        workflow,
        state: {},
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
      state: currentState?.state,
    });

    if (resolved.status === 'resolved') {
      state.jobId = resolved.job.id;
      if (workflow === 'create_quote' && !state.items) {
        state.items = resolved.job.description;
      }
    } else if (resolved.status === 'multiple') {
      return {
        type: 'reply',
        workflow,
        state: { ...state, options: resolved.jobs },
        message: buildChoiceList('I found a few matches:', resolved.jobs.map(buildResolvedReference)),
      };
    } else {
      return {
        type: 'reply',
        workflow,
        state,
        message: buildClarification('Which customer or job do you mean? You can just reply with the customer name.'),
      };
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
      archive_job: {
        jobId: 'Which customer or job should I archive? You can reply with the customer name.',
      },
    };

    return {
      type: 'reply',
      message: buildClarification(prompts[workflow]?.[missing[0]] || 'I need a bit more information to do that.'),
      workflow,
      state,
    };
  }

  const intentMap = {
    create_job: 'new_job',
    create_quote: 'quote',
    schedule_job: 'schedule',
    archive_job: 'archive_job',
  };

  return {
    type: 'action',
    workflow,
    state,
    intent: {
      ...state,
      intent: intentMap[workflow] || parsedIntent.intent,
    },
  };
}

module.exports = {
  handleMessage,
};
