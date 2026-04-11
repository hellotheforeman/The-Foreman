const WORKFLOWS = {
  new_customer: {
    requiredFields: ['name', 'phone'],
    optionalFields: [],
    prompts: {
      name: "What's the customer's name?",
      phone: "What's their phone number?",
    },
  },
  new_job: {
    requiredFields: ['name', 'phone', 'description'],
    optionalFields: ['postcode'],
    prompts: {
      name: 'Who is the customer?',
      phone: 'What is their phone number?',
      description: 'What is the job for?',
      postcode: 'What is the postcode?',
    },
  },
  quote: {
    requiredFields: ['jobId', 'amount'],
    optionalFields: ['items'],
    prompts: {
      jobId: 'Which customer or job do you mean?',
      amount: 'What price should I use?',
      items: 'What should I put on the quote?',
    },
  },
  schedule: {
    requiredFields: ['jobId', 'date', 'time'],
    optionalFields: [],
    prompts: {
      jobId: 'Which customer or job do you mean?',
      date: 'What day should I book it in for?',
      time: 'What time should I put down?',
    },
  },
};

function getWorkflow(name) {
  return WORKFLOWS[name] || null;
}

function computeMissingFields(workflowName, data = {}) {
  const workflow = getWorkflow(workflowName);
  if (!workflow) return [];
  return workflow.requiredFields.filter((field) => data[field] === undefined || data[field] === null || data[field] === '');
}

module.exports = {
  WORKFLOWS,
  getWorkflow,
  computeMissingFields,
};
