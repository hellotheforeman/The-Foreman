const workflows = {
  create_job: {
    name: 'create_job',
    requiredFields: ['name', 'phone', 'address', 'description'],
    optionalFields: ['postcode'],
  },
  create_quote: {
    name: 'create_quote',
    kind: 'action',
    target: 'job',
    requiredFields: ['jobId', 'amount'],
    optionalFields: ['items'],
    canReuseFocus: true,
    canReuseWorkflow: true,
    collectDefaults: async ({ focus, collected }) => ({
      items: collected.items || focus?.job?.description || null,
    }),
    nextStep: ({ missing }) => {
      if (missing.includes('jobId')) return { type: 'resolve_target' };
      if (missing.includes('amount')) return { type: 'ask', promptKey: 'ask_quote_amount' };
      return { type: 'ready' };
    },
    execute: async ({ focus, collected }) => ({
      intent: 'quote',
      jobId: focus.jobId,
      amount: collected.amount,
      items: collected.items,
    }),
  },
  schedule_job: {
    name: 'schedule_job',
    requiredFields: ['jobId', 'date'],
    optionalFields: ['time'],
  },
  reschedule_job: {
    name: 'reschedule_job',
    kind: 'action',
    target: 'job',
    requiredFields: ['jobId', 'date'],
    optionalFields: ['time'],
    canReuseFocus: true,
    canReuseWorkflow: true,
    nextStep: ({ missing }) => {
      if (missing.includes('jobId')) return { type: 'resolve_target' };
      if (missing.includes('date')) return { type: 'ask', promptKey: 'ask_schedule_date' };
      return { type: 'ready' };
    },
    execute: async ({ focus, collected }) => ({
      intent: 'schedule',
      jobId: focus.jobId,
      date: collected.date,
      time: collected.time,
    }),
  },
  query_job_status: {
    name: 'query_job_status',
    requiredFields: ['jobId'],
    optionalFields: [],
  },
  archive_job: {
    name: 'archive_job',
    requiredFields: ['jobId'],
    optionalFields: [],
  },
};

function getWorkflow(name) {
  return workflows[name] || null;
}

function getRequiredFields(name) {
  return getWorkflow(name)?.requiredFields || [];
}

function computeMissingFields(name, state) {
  return getRequiredFields(name).filter((field) => state[field] === undefined || state[field] === null || state[field] === '');
}

module.exports = {
  workflows,
  getWorkflow,
  getRequiredFields,
  computeMissingFields,
};
