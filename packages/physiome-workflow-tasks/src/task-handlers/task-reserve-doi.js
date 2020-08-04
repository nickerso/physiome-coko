const { models } = require('component-workflow-model/model');
const { Submission } = models;
const logger = require('workflow-utils/logger-with-prefix')('PhysiomeWorkflowTasks/ReserveDOI');
const { transaction } = require('objection');

const { FigshareApi } = require('figshare-publish-service');
const config = require('config');
const endpointSet = config.get('figsharePublish.endpointSet');


module.exports = function _setupReserveDoiTask(client) {

    client.subscribe('reserve-doi', async ({ task, taskService }) => {

        logger.debug(`reserve doi task is starting`);

        const submissionId = task.businessKey;
        if(!submissionId) {
            logger.warn(`failed to timeout submission due to missing business key (processInstanceId="${task.processInstanceId}")`);
            return;
        }

        const submission = await Submission.find(submissionId);
        if(!submission) {
            logger.warn(`unable to find submission instance for id (${submissionId})`);
            return;
        }

        if (!submission.figshareArticleId) {
            submission.figshareArticleType = endpointSet;
            await submission.patchFields(['figshareArticleType']);
        }
        // if there is an existing article id, assume the type was default
        // subsequent function may call a create()

        return _reserveDoiForSubmission(submission).then(async article => {

            if(!article || !article.doi) {
                logger.error(`reserve doi was unable to retrieve the DOI or article details for the Figshare article (submissionId = ${submissionId})`);
                return;
            }

            submission.figshareArticleDoi = article.doi;

            await submission.patchFields(['figshareArticleDoi']);
            await submission.publishWasModified();

            logger.debug(`reserve doi completed, completing external task`);
            return taskService.complete(task);

        }).catch(err => {

            logger.error(`unable to reserve doi for submission due to: ${err.toString()} (submissionId = ${submissionId})`);

            // FIXME: apply a better back-off approach here...
        });
    });
};


function _reserveDoiForSubmission(submission) {

    const articleData = {
        title: submission.title,
        categories: [ 2 ],
        tags: [
            "Demo Physiome Article"
        ],
        description: submission.abstract || "No article description was provided at the time of submission."
    };

    const submissionEndpointSet = submission.figshareArticleType || endpointSet;

    if(submission.authors && submission.authors instanceof Array && submission.authors.length) {

        articleData.authors = submission.authors.filter(a => a.name).map(author => {
            return {name: author.name};
        });
    }

    const createArticleIdPromise = !submission.figshareArticleId ? FigshareApi.create(submissionEndpointSet, articleData).then(articleId => {

        submission.figshareArticleId = "" + articleId;

        return submission.patchFields(['figshareArticleId'], builder =>

            builder.whereNull('figshareArticleId')

        ).catch(err => {

            FigshareApi.delete(submissionEndpointSet, articleId);
            return Promise.reject(err);

        }).then(() => {

            return articleId;
        });

    }) : Promise.resolve(submission.figshareArticleId);

    return createArticleIdPromise.then(figshareArticleId => {

        return FigshareApi.reserveDoi(submissionEndpointSet, figshareArticleId).then(() => {
            return figshareArticleId;
        });

    }).then(figshareArticleId => {

        return FigshareApi.get(submissionEndpointSet, figshareArticleId);
    });
}
