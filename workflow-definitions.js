const db = require('./db');

const workflows = {
  create_job: {
    name: 'create_job',
    requiredFields: ['name', 'phone', 'address', 'description'],
    optionalFields: ['postcode'],
  },
  create_quote: {
    name: 'create_quote',
    requiredFields: ['jobId', 'amount'],
    optionalFields: ['items'],
    defaults: ({ job }) => ({ items: job?.description }),
  },
  schedule_job: {
    name: 'schedule_job',
    requiredFields: ['jobId', 'date'],
    optionalFields: ['time'],
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
