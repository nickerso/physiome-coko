require('dotenv').config();
const path = require('path');
const logger = require('./loggerCustom');
const components = require('./components.json');


const getDbConfig = () => {
    if (process.env.DATABASE) {
        return {
            user: process.env.DB_USER,
            password: process.env.DB_PASS,
            database: process.env.DATABASE,
            host: process.env.DB_HOST,
            port: 5432,
            ssl: false,
            newJobCheckIntervalSeconds: 3600,
            expireCheckIntervalMinutes: 60
        };
    }
    return {};
};

if(!process.env.PUBSWEET_SERVER_SECRET) {
    console.error(`The environment variable "PUBSWEET_SERVER_SECRET" must be defined. This value should not be disclosed as it is used to sign JSON Web Tokens.`);
    process.exit(1);
}

if(process.env.PUBLISH_FIGSHARE_GROUP_ID && isNaN(parseInt(process.env.PUBLISH_FIGSHARE_GROUP_ID))) {
    console.error(`The environment variable "PUBLISH_FIGSHARE_GROUP_ID" if defined must be a valid numeric value (PUBLISH_FIGSHARE_GROUP_ID = ${process.env.PUBLISH_FIGSHARE_GROUP_ID}).`);
    process.exit(1);
}


const values = {

    // Public keys are copied into webpack build (i.e. go client-side)
    publicKeys: ['pubsweet-client', 'validations', 'orcid-paths', 'stripe-publishable-key', 'figshare-widgets-hostname', 'email'],

    authsome: {
        mode: path.resolve(__dirname, 'authsome-mode.js')
    },
    pubsweet: {
        components
    },
    dbManager: {
        migrationsPath: path.join(process.cwd(), 'migrations')
    },
    'pubsweet-server': {
        db: getDbConfig(),
        pool: { min: 0, max: 10 },
        ignoreTerminatedConnectionError: true,
        port: 3000,
        logger,
        secret: process.env.PUBSWEET_SERVER_SECRET,
        enableExperimentalGraphql: true,
        graphiql: true
    },
    'pubsweet-client': {
        API_ENDPOINT: '/api',
        baseUrl: process.env.CLIENT_BASE_URL || 'http://localhost:3000',
        'login-redirect': '/',
        theme: process.env.PUBSWEET_THEME
    },

    SES: {
        accessKey: process.env.AWS_SES_ACCESS_KEY,
        secretKey: process.env.AWS_SES_SECRET_KEY,
        region: process.env.AWS_SES_REGION
    },

    workflow: {
        apiUri: process.env.WORKFLOW_API_URI || 'http://127.0.0.1:8080/engine-rest',
        deploymentName: 'physiome-submission'
    },

    'workflow-files': {
        fileIdentifierDomain: "physiome-submission-dev.ds-innovation-experiments.com",
        secretAccessKey: process.env.AWS_S3_SECRET_KEY,
        accessKeyId: process.env.AWS_S3_ACCESS_KEY,
        region: process.env.AWS_S3_REGION,
        bucket: process.env.AWS_S3_BUCKET
    },

    'workflow-send-email' : {
        from: process.env.EMAIL_SEND_FROM,
        prefix: process.env.EMAIL_SUBJECT_PREFIX,
        templateDirectory: `${__dirname}/../../../definitions/email-templates`,
        signature: process.env.EMAIL_SIGNATURE ? process.env.EMAIL_SIGNATURE.replace(/\\n/g, "\n") : "",

        editorsMailingListAddress: process.env.EMAIL_EDITORS_MAILING_LIST,

        // Note: restricted email addresses, env variable parsed as JSON array of addresses, for a regex match it should look like: "regex:^.+@digital-science\\.com$"
        restrictedEmailAddresses: process.env.EMAIL_RESTRICTED_TO ? JSON.parse(process.env.EMAIL_RESTRICTED_TO).map(v => v.indexOf("regex:") === 0 ? new RegExp(v.split(':')[1], 'i') : v) : null
    },

    'workflow-publish-output' : {
        directory: `${__dirname}/../../../published`,
    },

    identity: {
        validationTokenExpireDays: 15,
        maximumEmailValidationsPerDay: 5,
        adminIdentities: process.env.IDENTITY_ADMIN_USERS ? `${process.env.IDENTITY_ADMIN_USERS}`.split(",").map(s => s.trim()) : []
    },

    orcid: {
        clientID: process.env.ORCID_CLIENT_ID,
        clientSecret: process.env.ORCID_CLIENT_SECRET,

        orcidUrl: 'sandbox.orcid.org',
        orcidDisplayUrl: 'orcid.org',

        authenticatePath: '/orcid/authenticate',
        callbackPath: '/orcid/callback',

        associatePath: '/orcid/link',
        associateCallbackPath: '/orcid/associate',

        successPath: '/',

        publicApiEndpoint: 'https://pub.orcid.org',
    },

    dimensions: {
        apiBaseUrl: process.env.DIMENSIONS_API_BASE || "https://app.dimensions.ai/api",
        apiUserName: process.env.DIMENSIONS_API_USERNAME,
        apiUserPassword: process.env.DIMENSIONS_API_PASSWORD
    },

    figshare: {
        apiBaseUrl: process.env.FIGSHARE_API_BASE,
        apiToken: process.env.FIGSHARE_API_TOKEN
    },

    figsharePublish: {
        endpointSet: process.env.PUBLISH_FIGSHARE_ENDPOINT_SET || "Article",
        type: process.env.PUBLISH_FIGSHARE_TYPE || "journal contribution",
        groupId: process.env.PUBLISH_FIGSHARE_GROUP_ID ? (parseInt(process.env.PUBLISH_FIGSHARE_GROUP_ID)) : null,
        categories: process.env.PUBLISH_FIGSHARE_CATEGORIES || "4, 12, 135",  /* Biochemistry, Cell Biology, Computational  Biology */
        defaultTag: process.env.PUBLISH_FIGSHARE_DEFAULT_TAG || "Physiome Journal",
        customFieldNames: {
            CommissionKind: process.env.PUBLISH_FIGSHARE_COMMISSION_KIND_NAME || 'Commission Kind'
        },

        skipPublishingStage: (process.env.PUBLISH_FIGSHARE_SKIP_STAGE && (process.env.PUBLISH_FIGSHARE_SKIP_STAGE === "true" || process.env.PUBLISH_FIGSHARE_SKIP_STAGE === true))
    },

    'figshare-widgets-hostname': process.env.FIGSHARE_WIDGETS_HOSTNAME || "widgets.figsh.com",

    stripe: {
        testing: (process.env.STRIPE_IS_PRODUCTION && process.env.STRIPE_IS_PRODUCTION.toString() !== "false"),
        secretKey: process.env.STRIPE_SECRET_KEY,
        publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
        webhookSecretKey: process.env.STRIPE_WEBHOOK_SECRET_KEY
    },

    logging: {
        debugAclRules: true
    }
};


// For values we want to expose to the front-end, which also happen to have private API keys defined as well
// within the same config set, extract those into a completely separate config key area.
values['orcid-paths'] = {
    orcidUrl: values.orcid.orcidUrl,
    orcidDisplayUrl: values.orcid.orcidDisplayUrl,
    authenticatePath: values.orcid.authenticatePath,
    associatePath: values.orcid.associatePath
};

values['stripe-publishable-key'] = (values.stripe && values.stripe.publishableKey) || null;

values['email'] = {
    help: values['workflow-send-email'].editorsMailingListAddress
};

module.exports = values;
