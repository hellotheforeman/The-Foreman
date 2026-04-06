function buildChoiceList(title, options, footer = 'Reply with 1, 2 or 3.') {
  return `${title}\n${options.map((option, index) => `${index + 1}) ${option}`).join('\n')}\n\n${footer}`;
}

function buildClarification(text) {
  return text;
}

function buildGreeting() {
  const replies = [
    'Morning 👋 What do you need sorting?',
    'Alright — what do you need help with?',
    'Hi 👋 What do you want me to sort out?',
    'Morning — what are we working on?',
  ];
  return replies[Math.floor(Math.random() * replies.length)];
}

function buildAcknowledgement() {
  const replies = [
    'No worries 👍',
    'Nice one 👍',
    'Cheers — shout if you need anything else.',
    'All good 👍',
  ];
  return replies[Math.floor(Math.random() * replies.length)];
}

function buildNoMatch(text) {
  return text || `I couldn't match that to anything open right now.`;
}

function buildResolvedReference(job) {
  return `${job.customer_name} — ${job.description}${job.address ? `, ${job.address}` : ''}`;
}

module.exports = {
  buildChoiceList,
  buildClarification,
  buildGreeting,
  buildAcknowledgement,
  buildNoMatch,
  buildResolvedReference,
};
