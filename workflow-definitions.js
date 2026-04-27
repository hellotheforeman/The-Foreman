const WORKFLOWS = {
  new_customer: {
    requiredFields: ['name', 'phone'],
    optionalFields: ['email'],
    prompts: {
      name: "What's the customer's name?",
      phone: "What's their phone number?",
      email: "What's their email address?",
    },
  },
  new_job: {
    requiredFields: ['name', 'phone', 'description'],
    optionalFields: ['email'],
    prompts: {
      name: 'Who is the customer?',
      phone: 'What is their phone number?',
      description: 'What is the job for?',
      email: "What's their email address?",
    },
  },
  quote: {
    requiredFields: ['jobId', 'amount'],
    optionalFields: ['items'],
    prompts: {
      jobId: 'Which customer or job do you mean?',
      amount: 'What price should I use?\n\n(Or itemised: *service 250, parts 45*)',
      items: 'What should I put on the quote?',
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
