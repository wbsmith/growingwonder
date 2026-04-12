const serverlessExpress = require('@codegenie/serverless-express');
const app = require('./app');

let handler;

exports.handler = async (event, context) => {
  try {
    if (!handler) {
      handler = serverlessExpress({ app });
    }
    return await handler(event, context);
  } catch (err) {
    console.error('Lambda handler error:', err);
    return {
      statusCode: 500,
      body: 'Internal Server Error',
    };
  }
};
