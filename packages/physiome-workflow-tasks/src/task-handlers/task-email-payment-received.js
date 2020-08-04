const TaskSendEmail = require('./util-task-send-email');
const logger = require('workflow-utils/logger-with-prefix')('PhysiomeWorkflowTasks/Email-ManuscriptAcceptance');

class TaskPaymentReceivedEmail extends TaskSendEmail {

    constructor(logger) {
        super('manuscript-payment-received', logger);
    }

    async formatEmailSubject(submission) {
        return `confirmation of payment for ${submission.manuscriptId}`;
    }
}

module.exports = function _setupEmailPaymentReceivedTask(client) {

    const externalTaskName = 'payment-received-email';
    const task = new TaskPaymentReceivedEmail(logger);

    task.configure(client, externalTaskName);

};
